/**
 * SicariusGuard — Deployer Reconnaissance Module
 *
 * Performs a full background investigation on a token deployer's on-chain
 * history to determine if they are a serial rugger. Completely algorithmic —
 * no hardcoded blacklists. Analyses the deployer's entire token portfolio
 * to compute a recidivism score.
 *
 * Pipeline:
 *   1. Portfolio Enumeration — DAS `searchAssets` to find all fungible tokens
 *      the deployer controls or has created
 *   2. Portfolio Health Triage — classify each token as alive, abandoned, or rugged
 *      based on supply, price, and authority state (from the same DAS response)
 *   3. Deployer Wallet Genesis — `getTransactionsForAddress(asc, 1)` to find
 *      who originally funded the deployer and when the wallet was born
 *   4. Recidivism Scoring — pure math on portfolio composition
 *
 * API Cost: 2-3 Helius credits per full recon (Developer plan, zero extra)
 *
 * @author Chronolapse411
 * @version 1.0.0 — Phase 2.5B initial
 */

// ── Public Types ─────────────────────────────────────────────────────────────

/** Health classification for a token in the deployer's portfolio. */
export type MintVitals = 'alive' | 'abandoned' | 'rugged';

/** Severity verdict for the deployer. */
export type DeployerVerdict = 'CLEAN' | 'SUSPICIOUS' | 'SERIAL_DEPLOYER' | 'LIKELY_SCAMMER';

/** Single token record from the deployer's portfolio. */
export interface MintRecord {
    mint:          string;
    name:          string;
    symbol:        string;
    vitals:        MintVitals;
    hasAuthority:  boolean;
    supply:        number;
    priceUsd:      number | null;
}

/** Complete dossier on a deployer wallet. */
export interface DeployerDossier {
    deployerAddress:      string;
    walletCreatedAt:      string | null;
    fundedBy:             string | null;
    totalTokensLaunched:  number;
    portfolio:            MintRecord[];
    aliveCount:           number;
    abandonedCount:       number;
    ruggedCount:          number;
    deadTokenRatio:       number;
    recidivismScore:      number;
    verdict:              DeployerVerdict;
    flags:                string[];
    reconAt:              string;
}

// ── Internal DAS Response Shapes ─────────────────────────────────────────────

interface DasAssetItem {
    id:           string;
    interface:    string;
    content?: {
        metadata?: {
            name?:   string;
            symbol?: string;
        };
    };
    authorities?: Array<{
        address: string;
        scopes:  string[];
    }>;
    ownership: {
        owner:  string;
        frozen: boolean;
    };
    token_info?: {
        supply?:           number;
        decimals?:         number;
        mint_authority?:   string;
        freeze_authority?: string;
        price_info?: {
            price_per_token: number;
        };
    };
    burnt?: boolean;
}

interface DasSearchResult {
    total: number;
    items: DasAssetItem[];
}

// ── Portfolio Enumeration ────────────────────────────────────────────────────

/**
 * Extract the Helius API key from an RPC URL.
 * Format: https://mainnet.helius-rpc.com/?api-key=XXXXXXXX
 */
function extractApiKey(rpcUrl: string): string {
    try {
        return new URL(rpcUrl).searchParams.get('api-key') ?? '';
    } catch {
        return '';
    }
}

/**
 * Discover every fungible token the deployer controls or has created.
 *
 * Three-tier enumeration strategy:
 *   1. DAS `searchAssets` by authority — finds tokens where deployer is still update auth
 *   2. DAS `getAssetsByCreator` — finds tokens with verified creator metadata
 *   3. Helius Enhanced Transactions API — scans for TOKEN_MINT type events in the
 *      deployer's history, then enriches each discovered mint via `getAsset`
 *
 * Strategy 3 is the critical fallback for pump.fun tokens where authority is
 * renounced during PumpSwap graduation — the deployer no longer shows up as
 * authority in DAS but DID sign the initial mint transaction.
 */
async function enumeratePortfolio(
    rpcUrl: string,
    deployerAddress: string,
): Promise<DasAssetItem[]> {
    // Strategy 1: DAS searchAssets by authority
    const primary = await dasRpc(rpcUrl, 'searchAssets', {
        authorityAddress: deployerAddress,
        tokenType: 'fungible',
        limit: 100,
        options: { showFungible: true },
    });

    if (primary && primary.total > 0) return primary.items;

    // Strategy 2: DAS getAssetsByCreator
    const byCreator = await dasRpc(rpcUrl, 'getAssetsByCreator', {
        creatorAddress: deployerAddress,
        onlyVerified: false,
        limit: 100,
    });

    if (byCreator && byCreator.total > 0) {
        const fungibles = byCreator.items.filter(a =>
            a.interface === 'FungibleToken' ||
            a.interface === 'FungibleAsset' ||
            a.token_info?.decimals !== undefined
        );
        if (fungibles.length > 0) return fungibles;
    }

    // Strategy 3: Enhanced Transactions API — find TOKEN_MINT events
    const mintAddresses = await discoverMintsFromHistory(rpcUrl, deployerAddress);
    if (mintAddresses.length === 0) return [];

    // Enrich each discovered mint via DAS getAsset
    return enrichMintBatch(rpcUrl, mintAddresses);
}

/**
 * Scan the deployer's transaction history for TOKEN_MINT events via Helius
 * Enhanced Transactions REST API. Returns unique mint addresses.
 */
async function discoverMintsFromHistory(
    rpcUrl: string,
    deployerAddress: string,
): Promise<string[]> {
    const apiKey = extractApiKey(rpcUrl);
    if (!apiKey) return [];

    try {
        const url = `https://api.helius.xyz/v0/addresses/${deployerAddress}/transactions?api-key=${apiKey}&limit=50&type=TOKEN_MINT`;
        const res = await fetch(url, {
            signal: AbortSignal.timeout(12_000),
        });

        if (!res.ok) return [];

        const txs = await res.json() as Array<{
            type:         string;
            tokenTransfers?: Array<{
                mint:          string;
                tokenAmount:   number;
                tokenStandard: string;
            }>;
        }>;

        // Extract unique mint addresses from TOKEN_MINT transactions
        const mints = new Set<string>();
        for (const tx of txs) {
            if (tx.tokenTransfers) {
                for (const tt of tx.tokenTransfers) {
                    if (tt.mint && tt.tokenAmount > 0) {
                        mints.add(tt.mint);
                    }
                }
            }
        }

        return [...mints];
    } catch {
        return [];
    }
}

/**
 * Enrich a batch of mint addresses via DAS `getAsset` calls.
 * Returns full asset data for each mint.
 */
async function enrichMintBatch(
    rpcUrl: string,
    mints: string[],
): Promise<DasAssetItem[]> {
    const results: DasAssetItem[] = [];

    // Batch via getAssetBatch (single RPC call for up to 1000 assets)
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sicarius-recon-batch',
                method: 'getAssetBatch',
                params: { ids: mints.slice(0, 100) },
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) return [];

        const body = await res.json() as {
            result?: DasAssetItem[];
            error?:  unknown;
        };

        if (Array.isArray(body.result)) {
            // Filter to fungible tokens only
            for (const asset of body.result) {
                if (
                    asset &&
                    asset.id &&
                    (asset.interface === 'FungibleToken' ||
                     asset.interface === 'FungibleAsset' ||
                     asset.token_info?.decimals !== undefined)
                ) {
                    results.push(asset);
                }
            }
        }
    } catch {
        // Batch failed — return whatever we have
    }

    return results;
}

/**
 * Generic DAS RPC helper — sends a single JSON-RPC call to the Helius endpoint.
 */
async function dasRpc(
    rpcUrl: string,
    method: string,
    params: Record<string, unknown>,
): Promise<DasSearchResult | null> {
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: `sicarius-recon-${method}`,
                method,
                params,
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as {
            result?: DasSearchResult;
            error?:  unknown;
        };

        return body.result ?? null;
    } catch {
        return null;
    }
}

// ── Portfolio Health Triage ───────────────────────────────────────────────────

/**
 * Classify a token's health based on data already present in the DAS response.
 * No additional API calls needed.
 */
function triageMint(asset: DasAssetItem): MintRecord {
    const name   = asset.content?.metadata?.name   ?? 'Unknown';
    const symbol = asset.content?.metadata?.symbol  ?? '???';
    const supply = asset.token_info?.supply ?? 0;
    const price  = asset.token_info?.price_info?.price_per_token ?? null;
    const burnt  = asset.burnt === true;

    // Deployer still has authority if mint or freeze authority matches any authority entry
    const hasAuthority = !!(
        asset.token_info?.mint_authority ||
        asset.token_info?.freeze_authority
    );

    let vitals: MintVitals;

    if (burnt) {
        vitals = 'rugged';
    } else if (price !== null && price > 0 && supply > 0) {
        vitals = 'alive';
    } else if (supply === 0) {
        vitals = 'rugged';
    } else {
        // Has supply but no price data — likely abandoned
        vitals = 'abandoned';
    }

    return {
        mint: asset.id,
        name,
        symbol,
        vitals,
        hasAuthority,
        supply,
        priceUsd: price,
    };
}

// ── Deployer Wallet Genesis ──────────────────────────────────────────────────

interface WalletGenesis {
    createdAt: string | null;
    fundedBy:  string | null;
}

/**
 * Find when the deployer wallet was created and who funded it.
 * Uses Helius `getTransactionsForAddress` with ascending sort — single call.
 */
async function traceWalletGenesis(
    rpcUrl: string,
    deployerAddress: string,
): Promise<WalletGenesis> {
    if (!rpcUrl.includes('helius')) {
        return { createdAt: null, fundedBy: null };
    }

    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sicarius-recon-genesis',
                method: 'getTransactionsForAddress',
                params: [
                    deployerAddress,
                    {
                        transactionDetails: 'full',
                        sortOrder: 'asc',
                        limit: 1,
                        filters: { status: 'succeeded' },
                    },
                ],
            }),
            signal: AbortSignal.timeout(12_000),
        });

        if (!res.ok) return { createdAt: null, fundedBy: null };

        const body = await res.json() as {
            result?: {
                data?: Array<{
                    blockTime: number | null;
                    transaction?: {
                        message?: {
                            accountKeys?: string[];
                        };
                    };
                }>;
            };
        };

        const tx = body.result?.data?.[0];
        if (!tx?.blockTime) return { createdAt: null, fundedBy: null };

        const createdAt = new Date(tx.blockTime * 1000).toISOString();

        // The first account key is the fee payer (who funded this wallet)
        const keys = tx.transaction?.message?.accountKeys ?? [];
        // Find the funder — typically the first signer that ISN'T the deployer itself
        const funder = keys.find(k => k !== deployerAddress) ?? keys[0] ?? null;

        return { createdAt, fundedBy: funder };
    } catch {
        return { createdAt: null, fundedBy: null };
    }
}

// ── Recidivism Scoring ───────────────────────────────────────────────────────

/**
 * Pure mathematical scoring — no external calls.
 * Evaluates how likely a deployer is to be a serial rugger based on
 * their portfolio composition and wallet characteristics.
 */
function calcRecidivismScore(
    portfolio: MintRecord[],
    genesis: WalletGenesis,
): { score: number; flags: string[] } {
    const flags: string[] = [];
    let score = 0;

    const total     = portfolio.length;
    const alive     = portfolio.filter(m => m.vitals === 'alive').length;
    const abandoned = portfolio.filter(m => m.vitals === 'abandoned').length;
    const rugged    = portfolio.filter(m => m.vitals === 'rugged').length;
    const dead      = abandoned + rugged;

    // ── Wallet age analysis (used in multiple signals) ──
    let ageDays = Infinity;
    if (genesis.createdAt) {
        const ageMs = Date.now() - new Date(genesis.createdAt).getTime();
        ageDays = ageMs / (1000 * 60 * 60 * 24);
    }

    // ── Signal 1: Dead token ratio (max +35) ──
    // Applies at any portfolio size — even 1 dead token out of 1 matters
    if (total >= 1) {
        const deadRatio = dead / total;
        if (deadRatio >= 0.8) {
            score += total >= 3 ? 35 : 25;
            flags.push(`DEAD_RATIO_${Math.round(deadRatio * 100)}%`);
        } else if (deadRatio >= 0.5) {
            score += 20;
            flags.push(`ELEVATED_DEAD_RATIO_${Math.round(deadRatio * 100)}%`);
        }
    }

    // ── Signal 2: Prolific deployer (max +15) ──
    if (total >= 10) {
        score += 15;
        flags.push(`PROLIFIC_${total}_TOKENS`);
    } else if (total >= 5) {
        score += 10;
        flags.push(`MULTI_DEPLOYER_${total}_TOKENS`);
    } else if (total >= 3) {
        score += 5;
        flags.push(`MULTI_DEPLOYER_${total}_TOKENS`);
    }

    // ── Signal 3: Wallet age (max +20) ──
    if (ageDays < 3) {
        score += 20;
        flags.push(`BURNER_WALLET_${Math.round(ageDays)}D`);
    } else if (ageDays < 7) {
        score += 15;
        flags.push(`FRESH_WALLET_${Math.round(ageDays)}D`);
    } else if (ageDays < 30) {
        score += 10;
        flags.push(`YOUNG_WALLET_${Math.round(ageDays)}D`);
    }

    // ── Signal 4: Still holds authority on dead tokens (max +10) ──
    const deadWithAuthority = portfolio.filter(
        m => m.vitals !== 'alive' && m.hasAuthority
    ).length;
    if (deadWithAuthority >= 2) {
        score += 10;
        flags.push(`AUTHORITY_ON_${deadWithAuthority}_DEAD_TOKENS`);
    }

    // ── Signal 5: All tokens dead (max +20) ──
    // Even a single dead token with zero alive tokens is a signal at scale
    if (total >= 3 && alive === 0) {
        score += 20;
        flags.push('ALL_TOKENS_DEAD');
    } else if (total >= 1 && alive === 0 && dead >= 1) {
        // Weaker signal for 1-2 token deployers where everything is dead
        score += 10;
        flags.push('NO_SURVIVING_TOKENS');
    }

    // ── Signal 6 (NEW): Burner deployer compound ──
    // Fresh wallet + dead token(s) = textbook burner deployer pattern.
    // A legitimate dev doesn't create a brand new wallet to launch a single
    // token that immediately dies.
    if (ageDays < 14 && total >= 1 && alive === 0) {
        score += 10;
        flags.push('BURNER_DEPLOYER_PATTERN');
    }

    // ── Mitigating factors ──
    // Has at least one healthy, established token with real market activity
    const healthyTokens = portfolio.filter(
        m => m.vitals === 'alive' && m.priceUsd !== null && m.priceUsd > 0.0001
    );
    if (healthyTokens.length > 0 && total <= 3) {
        score -= 10;
        flags.push(`HAS_${healthyTokens.length}_HEALTHY_TOKEN(S)`);
    }

    // Single token deployer — dampen but DON'T hard-cap.
    // A single dead token from a fresh wallet is still suspicious.
    if (total <= 1) {
        if (total === 0) {
            // Genuinely no portfolio — cap at 15 (only wallet age contributes)
            score = Math.min(score, 15);
            flags.push('NO_TOKEN_PORTFOLIO');
        } else {
            // Has exactly 1 token — apply soft dampen (reduce by 25%) instead of hard cap
            // This lets compound signals (fresh wallet + dead token) still push through
            score = Math.round(score * 0.75);
            flags.push('SINGLE_TOKEN_DEPLOYER');
        }
    }

    // Clamp
    score = Math.max(0, Math.min(score, 100));

    return { score, flags };
}

function resolveVerdict(score: number): DeployerVerdict {
    if (score >= 60) return 'LIKELY_SCAMMER';
    if (score >= 40) return 'SERIAL_DEPLOYER';
    if (score >= 20) return 'SUSPICIOUS';
    return 'CLEAN';
}

// ── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Perform a full deployer reconnaissance.
 *
 * @param deployerAddress  The wallet that deployed/controls the token
 * @returns                Complete dossier with portfolio analysis and risk score
 */
export async function reconDeployer(
    deployerAddress: string,
): Promise<DeployerDossier> {
    const rpcUrl = process.env.HELIUS_RPC_URL || '';
    const now    = new Date().toISOString();

    const emptyDossier = (flags: string[]): DeployerDossier => ({
        deployerAddress,
        walletCreatedAt:     null,
        fundedBy:            null,
        totalTokensLaunched: 0,
        portfolio:           [],
        aliveCount:          0,
        abandonedCount:      0,
        ruggedCount:         0,
        deadTokenRatio:      0,
        recidivismScore:     0,
        verdict:             'CLEAN',
        flags,
        reconAt:             now,
    });

    // ── Known Infrastructure Exclusion ──
    // Programs/AMMs structurally appear as authority on massive numbers of dead
    // tokens — this is protocol behavior, NOT human rug-pull behavior.
    if (KNOWN_INFRASTRUCTURE.has(deployerAddress)) {
        return emptyDossier(['KNOWN_INFRASTRUCTURE']);
    }

    if (!rpcUrl.includes('helius')) {
        return emptyDossier(['HELIUS_RPC_REQUIRED']);
    }

    // ── Stage 1+2: Portfolio enumeration ──
    const assets = await enumeratePortfolio(rpcUrl, deployerAddress);

    // ── Stage 3: Triage each token ──
    const portfolio = assets.map(triageMint);

    // ── Filter out common held assets (stablecoins, wrapped SOL, LSTs) ──
    // Holding USDC ≠ deploying USDC. These inflate "alive" counts incorrectly.
    const deployedPortfolio = portfolio.filter(
        m => !COMMON_HELD_MINTS.has(m.mint)
    );

    // ── Stage 4: Wallet genesis ──
    const genesis = await traceWalletGenesis(rpcUrl, deployerAddress);

    // ── Stage 5: Score — based on deployed tokens only ──
    const { score, flags } = calcRecidivismScore(deployedPortfolio, genesis);
    const verdict = resolveVerdict(score);

    const aliveCount     = deployedPortfolio.filter(m => m.vitals === 'alive').length;
    const abandonedCount = deployedPortfolio.filter(m => m.vitals === 'abandoned').length;
    const ruggedCount    = deployedPortfolio.filter(m => m.vitals === 'rugged').length;
    const deadCount      = abandonedCount + ruggedCount;
    const deadTokenRatio = deployedPortfolio.length > 0
        ? Math.round((deadCount / deployedPortfolio.length) * 1000) / 1000
        : 0;

    return {
        deployerAddress,
        walletCreatedAt:     genesis.createdAt,
        fundedBy:            genesis.fundedBy,
        totalTokensLaunched: deployedPortfolio.length,
        portfolio:           deployedPortfolio,
        aliveCount,
        abandonedCount,
        ruggedCount,
        deadTokenRatio,
        recidivismScore:     score,
        verdict,
        flags,
        reconAt:             now,
    };
}

// ── Known Infrastructure Programs ────────────────────────────────────────────
// These are AMMs, DEXs, and platform programs that structurally appear as
// token authorities. Recon on these would produce massive false positives.

const KNOWN_INFRASTRUCTURE = new Set([
    'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',  // pump.fun bonding curve program
    '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // pump.fun fee account
    '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM V4
    'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
    'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',  // Meteora DLMM
    'Eo7WjKq67rjJQSZxS6z3YkapzY3eBj6xehdVQYYPIVP6', // Meteora Pools
    '9W959DqEETiGZocYWCQPaJ6sBmUzgfxXfqGeTEdp3aQP', // Orca Whirlpool
    'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',  // Orca Legacy
    '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin', // Serum DEX V3
    'srmqPvymJeFKQ4zGQed1GFppgkRHL9kaELCbyksJtPX',  // OpenBook
    'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',  // Jupiter V6
    'MERLuDFBMmsHnsBPZw2sDQZHvXFMwp8EdjudcU2HKky',  // Mercurial Finance
    'SSwapUtytfBdBn1b9NUGG6foMVPtcWgpRU32HToDUZr',   // Saber Swap
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',   // SPL Token Program
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',   // Token-2022 Program
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',  // Associated Token Program
    '11111111111111111111111111111111',                 // System Program
]);

// ── Common Held Asset Mints ──────────────────────────────────────────────────
// Tokens that deployers commonly HOLD (not deploy). These should not inflate
// portfolio counts or affect dead-token ratios.

const COMMON_HELD_MINTS = new Set([
    'So11111111111111111111111111111111111111112',      // Wrapped SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',  // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',   // USDT
    'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',   // Marinade mSOL
    '7dHbWXmci3dT8UFYWYZweBZ5u7sgKyGkj9buqD6WmR6x',  // stSOL (Lido)
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',  // jitoSOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',   // bSOL (Blaze)
    'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
    'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',    // JUP
    'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',  // WIF
    '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr',  // POPCAT
    'AymATz4TCL9sWNEEV9KvdDYmfGxjSyBaTr5Efn2Fpump',   // XAUt0 / gold synthetic
]);

