/**
 * SicariusGuard — Birdeye Data Integration
 *
 * Enriches on-chain safety analysis with market intelligence from Birdeye APIs.
 *
 * Standard (Free) tier endpoints used:
 *   1. /defi/token_overview   — price, volume, liquidity, market cap, holder count
 *   2. /defi/v3/token/trade-data/single — granular buy/sell/volume/wallet data
 *
 * Paid tier endpoints (gracefully skipped when unavailable):
 *   3. /defi/token_security   — owner, freeze, mint authority (Starter+)
 *   4. /defi/token_creation_info — creator wallet, creation tx (Starter+)
 *
 * Rate limit: 1 RPS / 60 RPM on Standard. Calls are staggered accordingly.
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
    // Extended fields from the actual response
    trade24h?:    number;
    sell24h?:     number;
    buy24h?:      number;
    v24hUSD?:     number;
    numberMarkets?: number;
    uniqueWallet24h?: number;
}

export interface BirdeyeSecurity {
    ownerAddress:     string | null;
    freezeAuthority:  string | null;
    freezeable:       boolean;
    mutableMetadata:  boolean;
    renounced:        boolean;
    isToken2022:      boolean;
    transferFeeEnable: boolean;
    transferFeeData:  Record<string, unknown>;
    nonTransferable:  boolean;
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
    // v3 snake_case fields
    price:       number;
    volume_24h:  number;
    volume_24h_usd: number;
    volume_24h_change_percent: number;
    trade_24h:   number;
    sell_24h:    number;
    buy_24h:     number;
    unique_wallet_24h: number;
    unique_wallet_history_24h: number;
    unique_wallet_24h_change_percent: number;
    // Buy/sell volume for ratio analysis
    volume_buy_24h_usd:  number;
    volume_sell_24h_usd: number;
    // Short-term activity (manipulation detection)
    trade_1h?:   number;
    unique_wallet_1h?: number;
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
    tier:      'standard' | 'starter' | 'premium' | 'business';
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

        if (res.status === 401 || res.status === 403) {
            // Endpoint requires higher tier — fail silently
            console.warn(`[Birdeye] ${endpoint} requires paid tier (${res.status})`);
            return null;
        }

        if (res.status === 429) {
            console.warn(`[Birdeye] Rate limited on ${endpoint}`);
            return null;
        }

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

/**
 * Stagger delay between API calls to respect 1 RPS limit on Standard tier.
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
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
        // ── Liquidity Risk ──
        if (overview.liquidity < 1_000) {
            flags.push('CRITICALLY_LOW_LIQUIDITY (<$1K)');
            score += 30;
        } else if (overview.liquidity < 10_000) {
            flags.push('LOW_LIQUIDITY (<$10K)');
            score += 15;
        } else if (overview.liquidity < 50_000) {
            flags.push('MODERATE_LIQUIDITY (<$50K)');
            score += 5;
        }

        // ── Holder count ──
        if (overview.holder < 10) {
            flags.push('EXTREMELY_FEW_HOLDERS (<10)');
            score += 25;
        } else if (overview.holder < 50) {
            flags.push('FEW_HOLDERS (<50)');
            score += 15;
        }

        // ── Stale trading ──
        if (overview.lastTradeUnixTime) {
            const ageSeconds = (Date.now() / 1000) - overview.lastTradeUnixTime;
            if (ageSeconds > 86_400) {
                flags.push('NO_RECENT_TRADES (>24h)');
                score += 10;
            }
        }

        // ── Extreme price crash ──
        if (overview.priceChange24h < -70) {
            flags.push(`SEVERE_PRICE_CRASH_24H (${overview.priceChange24h.toFixed(1)}%)`);
            score += 25;
        } else if (overview.priceChange24h < -50) {
            flags.push(`PRICE_CRASH_24H (${overview.priceChange24h.toFixed(1)}%)`);
            score += 15;
        }

        // ── Volume anomaly ──
        if (overview.marketCap > 0 && overview.v24hUSD) {
            const volumeToMcap = overview.v24hUSD / overview.marketCap;
            if (volumeToMcap > 10) {
                flags.push(`EXTREME_VOLUME_TO_MCAP_RATIO (${volumeToMcap.toFixed(1)}x)`);
                score += 10;
            }
        }
    }

    if (security) {
        // ── Birdeye security flags (only available on Starter+) ──
        if (!security.renounced) {
            flags.push('BIRDEYE_OWNERSHIP_NOT_RENOUNCED');
            score += 15;
        }
        if (security.freezeable) {
            flags.push('BIRDEYE_FREEZE_AUTHORITY_ACTIVE');
            score += 20;
        }
        if (security.mutableMetadata) {
            flags.push('MUTABLE_METADATA');
            score += 5;
        }
        if (security.transferFeeEnable) {
            flags.push('TRANSFER_FEE_ENABLED');
            score += 10;
        }
        if (security.nonTransferable) {
            flags.push('NON_TRANSFERABLE_TOKEN');
            score += 30;
        }
    }

    if (tradeData) {
        // ── Sell pressure analysis ──
        if (tradeData.buy_24h > 0 && tradeData.sell_24h > 0) {
            const ratio = tradeData.sell_24h / tradeData.buy_24h;
            if (ratio > 5) {
                flags.push(`EXTREME_SELLING (sell:buy ${ratio.toFixed(1)}:1)`);
                score += 20;
            } else if (ratio > 3) {
                flags.push(`HEAVY_SELLING (sell:buy ${ratio.toFixed(1)}:1)`);
                score += 10;
            }
        }

        // ── Volume sell pressure ──
        if (tradeData.volume_buy_24h_usd > 0 && tradeData.volume_sell_24h_usd > 0) {
            const sellBuyVolRatio = tradeData.volume_sell_24h_usd / tradeData.volume_buy_24h_usd;
            if (sellBuyVolRatio > 3) {
                flags.push(`SELL_VOLUME_DOMINANCE (${sellBuyVolRatio.toFixed(1)}x)`);
                score += 10;
            }
        }

        // ── Bot/wash trading detection ──
        if (tradeData.unique_wallet_24h < 5 && tradeData.trade_24h > 50) {
            flags.push('SUSPECTED_BOT_ACTIVITY (few wallets, many trades)');
            score += 15;
        }

        // ── Unique wallet decline (mass exodus) ──
        if (tradeData.unique_wallet_24h_change_percent < -50) {
            flags.push(`WALLET_EXODUS_24H (${tradeData.unique_wallet_24h_change_percent.toFixed(1)}%)`);
            score += 10;
        }

        // ── Short-term manipulation ──
        if (tradeData.trade_1h && tradeData.unique_wallet_1h) {
            if (tradeData.unique_wallet_1h < 3 && tradeData.trade_1h > 20) {
                flags.push('WASH_TRADING_1H (very few wallets, high frequency)');
                score += 15;
            }
        }
    }

    score = Math.min(score, 100);

    const verdict = score === 0 ? 'MARKET_SAFE'
        : score <= 15 ? 'MARKET_CAUTION'
        : score <= 40 ? 'MARKET_HIGH_RISK'
        : 'MARKET_CRITICAL';

    return { score, flags, verdict };
}

// ── Main Enrichment Function ─────────────────────────────────────────────────

/**
 * Enrich a token mint with Birdeye market data and trade activity.
 *
 * On Standard (free) tier: Uses token_overview + trade-data (2 calls).
 * On Starter+ tier: Also includes token_security + creation_info (4 calls).
 *
 * Calls are staggered by 1.1s to respect 1 RPS rate limit.
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
            tier: 'standard',
            fetchedAt: new Date().toISOString(),
            error: 'BIRDEYE_API_KEY not configured',
        };
    }

    // ── Phase 1: Free-tier endpoints (staggered for 1 RPS) ──
    const overview = await birdeyeFetch<BirdeyeOverview>(
        '/defi/token_overview', apiKey, { address: mint },
    );

    await delay(1_100); // Respect 1 RPS

    const tradeData = await birdeyeFetch<BirdeyeTradeData>(
        '/defi/v3/token/trade-data/single', apiKey, { address: mint },
    );

    // ── Phase 2: Paid-tier endpoints (attempt, fail gracefully) ──
    await delay(1_100);

    const security = await birdeyeFetch<BirdeyeSecurity>(
        '/defi/token_security', apiKey, { address: mint },
    );

    await delay(1_100);

    const creation = await birdeyeFetch<BirdeyeCreation>(
        '/defi/token_creation_info', apiKey, { address: mint },
    );

    // Determine detected tier based on what succeeded
    const tier = security ? (creation ? 'premium' : 'starter') : 'standard';

    const marketRisk = assessMarketRisk(overview, security, tradeData);

    return {
        overview,
        security,
        creation,
        tradeData,
        marketRisk,
        tier,
        fetchedAt: new Date().toISOString(),
    };
}
