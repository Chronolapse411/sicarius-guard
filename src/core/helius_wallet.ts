/**
 * SicariusGuard — Helius Wallet Intelligence
 *
 * Leverages Helius Developer-tier Wallet API for creator reputation scoring:
 *   1. Wallet Identity — Tags wallets as exchanges, scammers, ruggers, protocols, etc.
 *   2. Wallet Funded-By — Reveals who originally funded a wallet (sybil/scam detection)
 *
 * Credit cost: 100 credits per call (200 total per enrichment)
 * Developer plan: 10M credits/mo → supports ~49K enrichments/mo
 *
 * @author Chronolapse411
 * @see https://www.helius.dev/docs/api-reference/wallet-api/llms.txt
 */

const HELIUS_API_BASE = 'https://api.helius.xyz';

// ── Types ────────────────────────────────────────────────────────────────────

export interface WalletIdentity {
    address:    string;
    name:       string | null;
    type:       string;   // "exchange", "defi", "rugger", "scammer", "kol", etc.
    category:   string | null;
    tags:       string[];
}

export interface WalletFunding {
    funder:      string;
    funderName:  string | null;
    funderType:  string | null;   // "exchange" | null
    amount:      number;
    timestamp:   number;
    signature:   string;
}

export interface CreatorReputation {
    identity:     WalletIdentity | null;
    funding:      WalletFunding | null;
    riskScore:    number;           // 0-100
    flags:        string[];
    verdict:      string;           // TRUSTED | NEUTRAL | SUSPICIOUS | DANGEROUS
    creatorAge:   number | null;    // days since wallet was funded
}

export interface WalletIntelligence {
    creatorAddress:    string | null;
    reputation:        CreatorReputation | null;
    fetchedAt:         string;
    error?:            string;
}

// ── API Helpers ──────────────────────────────────────────────────────────────

/**
 * Extract the Helius API key from the RPC URL.
 * Format: https://mainnet.helius-rpc.com/?api-key=XXXXXXXX
 */
export function extractHeliusApiKey(rpcUrl: string): string {
    try {
        const url = new URL(rpcUrl);
        return url.searchParams.get('api-key') ?? '';
    } catch {
        return '';
    }
}

async function fetchWalletIdentity(
    address: string,
    apiKey: string,
): Promise<WalletIdentity | null> {
    try {
        const res = await fetch(
            `${HELIUS_API_BASE}/v1/wallet/${address}/identity?api-key=${apiKey}`,
            { signal: AbortSignal.timeout(8_000) },
        );

        if (res.status === 404) return null;  // Normal — wallet not in identity DB
        if (!res.ok) {
            console.warn(`[Helius Wallet] identity ${res.status} for ${address.slice(0, 8)}...`);
            return null;
        }

        return await res.json() as WalletIdentity;
    } catch (e) {
        console.warn(`[Helius Wallet] identity error:`, e instanceof Error ? e.message : e);
        return null;
    }
}

async function fetchWalletFunding(
    address: string,
    apiKey: string,
): Promise<WalletFunding | null> {
    try {
        const res = await fetch(
            `${HELIUS_API_BASE}/v1/wallet/${address}/funded-by?api-key=${apiKey}`,
            { signal: AbortSignal.timeout(8_000) },
        );

        if (res.status === 404) return null;  // Normal — no funding data
        if (!res.ok) {
            console.warn(`[Helius Wallet] funded-by ${res.status} for ${address.slice(0, 8)}...`);
            return null;
        }

        return await res.json() as WalletFunding;
    } catch (e) {
        console.warn(`[Helius Wallet] funded-by error:`, e instanceof Error ? e.message : e);
        return null;
    }
}

// ── Reputation Scoring ───────────────────────────────────────────────────────

/** Dangerous identity categories from Helius Orb database */
const DANGEROUS_TYPES = new Set([
    'rugger', 'scammer', 'exploiter', 'hacker',
]);

const SUSPICIOUS_TYPES = new Set([
    'spam', 'casino', 'gambling',
]);

const TRUSTED_TYPES = new Set([
    'centralized exchange', 'defi', 'bridge', 'validator',
    'market maker', 'trading firm', 'treasury', 'governance',
    'infrastructure', 'oracle', 'staking',
]);

function assessCreatorReputation(
    identity: WalletIdentity | null,
    funding: WalletFunding | null,
): CreatorReputation {
    const flags: string[] = [];
    let score = 0;

    // ── Identity-based scoring ──
    if (identity) {
        const typeLower = (identity.type ?? '').toLowerCase();
        const categoryLower = (identity.category ?? '').toLowerCase();
        const allTags = identity.tags?.map(t => t.toLowerCase()) ?? [];

        // Check for known dangerous actors
        if (DANGEROUS_TYPES.has(typeLower) || DANGEROUS_TYPES.has(categoryLower)) {
            flags.push(`KNOWN_${typeLower.toUpperCase()}: ${identity.name ?? identity.address}`);
            score += 50;
        }

        // Check tags for danger signals
        for (const tag of allTags) {
            if (tag.includes('rug') || tag.includes('scam') || tag.includes('exploit') || tag.includes('hack')) {
                flags.push(`TAGGED_${tag.toUpperCase()}`);
                score += 30;
            }
        }

        // Suspicious but not definitively malicious
        if (SUSPICIOUS_TYPES.has(typeLower) || SUSPICIOUS_TYPES.has(categoryLower)) {
            flags.push(`SUSPICIOUS_CATEGORY: ${identity.category ?? identity.type}`);
            score += 15;
        }

        // Trusted entities reduce risk
        if (TRUSTED_TYPES.has(typeLower) || TRUSTED_TYPES.has(categoryLower)) {
            flags.push(`TRUSTED_ENTITY: ${identity.name ?? identity.type}`);
            score -= 15;
        }
    }

    // ── Funding source analysis ──
    if (funding) {
        // Funded by known exchange = likely legitimate user
        if (funding.funderType === 'exchange') {
            flags.push(`EXCHANGE_FUNDED: ${funding.funderName ?? 'unknown exchange'}`);
            score -= 10;
        }

        // Check wallet age
        const ageInDays = (Date.now() / 1000 - funding.timestamp) / 86_400;

        if (ageInDays < 1) {
            flags.push('WALLET_AGE_<1_DAY');
            score += 25;
        } else if (ageInDays < 7) {
            flags.push('WALLET_AGE_<7_DAYS');
            score += 15;
        } else if (ageInDays < 30) {
            flags.push('WALLET_AGE_<30_DAYS');
            score += 5;
        }
    } else {
        // No funding data — unknown origin
        flags.push('UNKNOWN_FUNDING_SOURCE');
        score += 5;
    }

    // Clamp score
    score = Math.max(0, Math.min(score, 100));

    const verdict = score >= 40 ? 'DANGEROUS'
        : score >= 20 ? 'SUSPICIOUS'
        : score > 0 ? 'NEUTRAL'
        : 'TRUSTED';

    const creatorAge = funding
        ? Math.floor((Date.now() / 1000 - funding.timestamp) / 86_400)
        : null;

    return { identity, funding, riskScore: score, flags, verdict, creatorAge };
}

// ── Main Enrichment ──────────────────────────────────────────────────────────

/**
 * Enrich a token creator wallet with Helius identity + funding intelligence.
 *
 * @param creatorAddress  The wallet that created/deployed the token (from update authority or known deployer)
 * @param heliusApiKey    Helius API key (extracted from RPC URL)
 * @returns               WalletIntelligence with reputation scoring
 */
export async function enrichCreatorReputation(
    creatorAddress: string | null,
    heliusApiKey: string,
): Promise<WalletIntelligence> {
    if (!creatorAddress) {
        return {
            creatorAddress: null,
            reputation: null,
            fetchedAt: new Date().toISOString(),
            error: 'No creator address available',
        };
    }

    if (!heliusApiKey) {
        return {
            creatorAddress,
            reputation: null,
            fetchedAt: new Date().toISOString(),
            error: 'HELIUS_API_KEY not configured',
        };
    }

    // Fetch identity and funding in parallel (both cost 100 credits each)
    const [identity, funding] = await Promise.all([
        fetchWalletIdentity(creatorAddress, heliusApiKey),
        fetchWalletFunding(creatorAddress, heliusApiKey),
    ]);

    const reputation = assessCreatorReputation(identity, funding);

    return {
        creatorAddress,
        reputation,
        fetchedAt: new Date().toISOString(),
    };
}
