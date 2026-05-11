/**
 * SicariusGuard — Birdeye Data Integration
 *
 * Enriches on-chain safety analysis with market intelligence from Birdeye APIs:
 *   1. Token Overview — price, volume, liquidity, market cap
 *   2. Token Security — holder distribution, mutable metadata flags
 *   3. Token Creation — age, creator wallet, creation context
 *   4. Trade Data     — recent trade activity for manipulation detection
 *
 * Used in combination with the core safety engine for comprehensive risk scoring.
 *
 * @author Chronolapse411
 * @see https://docs.birdeye.so
 */

const BIRDEYE_BASE = 'https://public-api.birdeye.so';

// ── Types ────────────────────────────────────────────────────────────────────

export interface BirdeyeOverview {
    address:      string;
    symbol:       string;
    name:         string;
    decimals:     number;
    price:        number;
    priceChange24h: number;
    volume24h:    number;
    liquidity:    number;
    marketCap:    number;
    supply:       number;
    holder:       number;
    lastTradeUnixTime: number;
}

export interface BirdeyeSecurity {
    creatorAddress:   string | null;
    ownerAddress:     string | null;
    creationTx:       string | null;
    mintAuthority:    string | null;
    freezeAuthority:  string | null;
    isToken2022:      boolean;
    isTrueToken:      boolean;
    totalSupply:      number;
    top10HolderPercent: number;
    top10UserPercent:   number;
    creatorPercentage:  number;
    mutableMetadata:    boolean;
    metaplexUpdateAuthority: string | null;
}

export interface BirdeyeCreation {
    address:    string;
    decimals:   number;
    symbol:     string;
    name:       string;
    txHash:     string;
    slot:       number;
    blockUnixTime: number;
    creator:    string;
}

export interface BirdeyeTradeData {
    price:       number;
    volume24h:   number;
    volume24hChangePercent: number;
    trade24h:    number;
    sell24h:     number;
    buy24h:      number;
    uniqueWallet24h: number;
}

export interface BirdeyeEnrichment {
    overview:  BirdeyeOverview | null;
    security:  BirdeyeSecurity | null;
    creation:  BirdeyeCreation | null;
    tradeData: BirdeyeTradeData | null;
    marketRisk: {
        score:     number;
        flags:     string[];
        verdict:   string;
    };
    fetchedAt: string;
    error?:    string;
}

// ── Fetch Helpers ────────────────────────────────────────────────────────────

async function birdeyeFetch<T>(
    endpoint: string,
    apiKey: string,
    params: Record<string, string> = {},
): Promise<T | null> {
    const url = new URL(endpoint, BIRDEYE_BASE);
    for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
    }

    try {
        const res = await fetch(url.toString(), {
            headers: {
                'X-API-KEY': apiKey,
                'x-chain': 'solana',
                'Accept': 'application/json',
            },
            signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
            console.warn(`[Birdeye] ${endpoint} returned ${res.status}`);
            return null;
        }

        const json = await res.json() as { success: boolean; data: T };
        return json.success ? json.data : null;
    } catch (e) {
        console.warn(`[Birdeye] ${endpoint} error:`, e instanceof Error ? e.message : e);
        return null;
    }
}

// ── Market Risk Assessment ───────────────────────────────────────────────────

function assessMarketRisk(
    overview: BirdeyeOverview | null,
    security: BirdeyeSecurity | null,
    tradeData: BirdeyeTradeData | null,
): { score: number; flags: string[]; verdict: string } {
    const flags: string[] = [];
    let score = 0;

    if (overview) {
        // Low liquidity = high risk
        if (overview.liquidity < 1_000) {
            flags.push('CRITICALLY_LOW_LIQUIDITY (<$1K)');
            score += 30;
        } else if (overview.liquidity < 10_000) {
            flags.push('LOW_LIQUIDITY (<$10K)');
            score += 15;
        }

        // Very few holders
        if (overview.holder < 50) {
            flags.push('FEW_HOLDERS (<50)');
            score += 15;
        }

        // No recent trading
        const ageSeconds = (Date.now() / 1000) - overview.lastTradeUnixTime;
        if (ageSeconds > 86_400) {
            flags.push('NO_RECENT_TRADES (>24h)');
            score += 10;
        }

        // Extreme price drop
        if (overview.priceChange24h < -50) {
            flags.push(`PRICE_CRASH_24H (${overview.priceChange24h.toFixed(1)}%)`);
            score += 20;
        }
    }

    if (security) {
        // Top 10 holders controlling too much
        if (security.top10HolderPercent > 80) {
            flags.push(`TOP10_HOLDER_CONCENTRATION (${security.top10HolderPercent.toFixed(1)}%)`);
            score += 20;
        } else if (security.top10HolderPercent > 50) {
            flags.push(`HIGH_HOLDER_CONCENTRATION (${security.top10HolderPercent.toFixed(1)}%)`);
            score += 10;
        }

        // Creator still holds large percentage
        if (security.creatorPercentage > 20) {
            flags.push(`CREATOR_HOLDS_${security.creatorPercentage.toFixed(1)}%`);
            score += 15;
        }

        // Mutable metadata = can change token name/image for phishing
        if (security.mutableMetadata) {
            flags.push('MUTABLE_METADATA');
            score += 5;
        }

        // Birdeye's own mint/freeze check
        if (security.mintAuthority) {
            flags.push('BIRDEYE_MINT_AUTHORITY_ACTIVE');
            score += 25;
        }
        if (security.freezeAuthority) {
            flags.push('BIRDEYE_FREEZE_AUTHORITY_ACTIVE');
            score += 20;
        }
    }

    if (tradeData) {
        // Wash trading detection: sell:buy ratio extremely skewed
        if (tradeData.buy24h > 0 && tradeData.sell24h > 0) {
            const ratio = tradeData.sell24h / tradeData.buy24h;
            if (ratio > 5) {
                flags.push('HEAVY_SELLING (sell:buy > 5:1)');
                score += 15;
            }
        }

        // Very few unique wallets trading = bot activity
        if (tradeData.uniqueWallet24h < 5 && tradeData.trade24h > 50) {
            flags.push('SUSPECTED_BOT_ACTIVITY (few wallets, many trades)');
            score += 10;
        }
    }

    score = Math.min(score, 100);

    const verdict = score === 0 ? 'MARKET_SAFE'
        : score <= 20 ? 'MARKET_CAUTION'
        : score <= 50 ? 'MARKET_HIGH_RISK'
        : 'MARKET_CRITICAL';

    return { score, flags, verdict };
}

// ── Main Enrichment Function ─────────────────────────────────────────────────

/**
 * Enrich a token mint with Birdeye market data, security flags, and trade activity.
 *
 * @param mint     Solana token mint address
 * @param apiKey   Birdeye API key (from BIRDEYE_API_KEY env var)
 * @returns        BirdeyeEnrichment with market risk assessment
 */
export async function enrichWithBirdeye(
    mint: string,
    apiKey: string,
): Promise<BirdeyeEnrichment> {
    if (!apiKey) {
        return {
            overview: null,
            security: null,
            creation: null,
            tradeData: null,
            marketRisk: { score: 0, flags: ['NO_API_KEY'], verdict: 'SKIPPED' },
            fetchedAt: new Date().toISOString(),
            error: 'BIRDEYE_API_KEY not configured',
        };
    }

    // Fetch all endpoints in parallel
    const [overview, security, creation, tradeData] = await Promise.all([
        birdeyeFetch<BirdeyeOverview>('/defi/token_overview', apiKey, { address: mint }),
        birdeyeFetch<BirdeyeSecurity>('/defi/token_security', apiKey, { address: mint }),
        birdeyeFetch<BirdeyeCreation>('/defi/token_creation_info', apiKey, { address: mint }),
        birdeyeFetch<BirdeyeTradeData>('/defi/v3/token/trade-data/single', apiKey, { address: mint }),
    ]);

    const marketRisk = assessMarketRisk(overview, security, tradeData);

    return {
        overview,
        security,
        creation,
        tradeData,
        marketRisk,
        fetchedAt: new Date().toISOString(),
    };
}
