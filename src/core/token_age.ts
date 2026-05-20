/**
 * SicariusGuard — Token Creation Age Analyzer
 *
 * Determines how old a token is by locating the earliest transaction
 * recorded against its mint address. New tokens are inherently riskier
 * because they haven't been battle-tested by the market.
 *
 * Strategy (multi-tier):
 *   1. Primary: Helius `getTransactionsForAddress` — asc sort with full
 *      tx data returns the exact first transaction in a single API call,
 *      regardless of total transaction volume. Works for BONK (100M+ txs),
 *      JUP, and any other token.
 *   2. Fallback: Standard RPC getSignaturesForAddress with backward pagination
 *      (capped at 50k sigs, accurate for most tokens)
 *   3. Safety: If both fail, return 'unknown' with moderate risk
 *
 * @author Chronolapse411
 * @version 1.1.1 — Helius deep-dive rewrite (exact dates, no exhaustion heuristic)
 */

import { Connection, PublicKey } from '@solana/web3.js';

// ── Time Constants ───────────────────────────────────────────────────────────

const SECONDS_PER_HOUR = 3_600;
const SECONDS_PER_DAY  = 86_400;
const SECONDS_PER_WEEK = 604_800;
const SECONDS_PER_MONTH = 2_592_000; // 30 days

// ── Public Types ─────────────────────────────────────────────────────────────

export type AgeCategory = 'newborn' | 'young' | 'adolescent' | 'mature' | 'unknown';

export interface TokenAgeResult {
    createdAt:       string | null;
    ageSeconds:      number | null;
    ageDays:         number | null;
    ageHuman:        string | null;
    ageCategory:     AgeCategory;
    riskScore:       number;
    flags:           string[];
    checkedAt:       string;
}

// ── Age Categorization ───────────────────────────────────────────────────────

/**
 * Classify a token's age into a risk tier based on how long it has existed.
 * Newer tokens carry higher risk because they haven't been market-tested.
 */
function categorizeAge(ageSeconds: number): {
    category: AgeCategory;
    score: number;
    flags: string[];
} {
    if (ageSeconds < SECONDS_PER_HOUR) {
        return {
            category: 'newborn',
            score: 20,
            flags: [`TOKEN_AGE_${Math.round(ageSeconds / 60)}m`, 'EXTREMELY_NEW_TOKEN'],
        };
    }
    if (ageSeconds < SECONDS_PER_DAY) {
        const hours = Math.round(ageSeconds / SECONDS_PER_HOUR);
        return {
            category: 'newborn',
            score: 10,
            flags: [`TOKEN_AGE_${hours}h`, 'VERY_NEW_TOKEN'],
        };
    }
    if (ageSeconds < SECONDS_PER_WEEK) {
        const days = Math.round(ageSeconds / SECONDS_PER_DAY);
        return {
            category: 'young',
            score: 5,
            flags: [`TOKEN_AGE_${days}d`, 'NEW_TOKEN'],
        };
    }
    if (ageSeconds < SECONDS_PER_MONTH) {
        const days = Math.round(ageSeconds / SECONDS_PER_DAY);
        return {
            category: 'adolescent',
            score: 2,
            flags: [`TOKEN_AGE_${days}d`],
        };
    }

    const days = Math.round(ageSeconds / SECONDS_PER_DAY);
    return {
        category: 'mature',
        score: 0,
        flags: [`TOKEN_AGE_${days}d`],
    };
}

/**
 * Convert seconds into a human-readable duration string.
 */
function formatDuration(seconds: number): string {
    if (seconds < SECONDS_PER_HOUR) {
        return `${Math.round(seconds / 60)} minutes`;
    }
    if (seconds < SECONDS_PER_DAY) {
        const h = Math.floor(seconds / SECONDS_PER_HOUR);
        const m = Math.round((seconds % SECONDS_PER_HOUR) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h} hours`;
    }
    if (seconds < SECONDS_PER_MONTH) {
        const d = Math.floor(seconds / SECONDS_PER_DAY);
        return `${d} day${d === 1 ? '' : 's'}`;
    }
    const months = Math.floor(seconds / SECONDS_PER_MONTH);
    const remainDays = Math.floor((seconds % SECONDS_PER_MONTH) / SECONDS_PER_DAY);
    return remainDays > 0
        ? `${months} month${months === 1 ? '' : 's'}, ${remainDays}d`
        : `${months} month${months === 1 ? '' : 's'}`;
}


// ── Helius Enhanced API Types ────────────────────────────────────────────────

/** Response shape for getTransactionsForAddress with transactionDetails: "signatures" */
interface HeliusSignaturesResponse {
    jsonrpc: string;
    id: string;
    result?: {
        data: Array<{
            signature: string;
            slot: number;
            blockTime: number | null;
            err: unknown;
            memo: string | null;
            confirmationStatus: string;
        }>;
        paginationToken?: string;
    };
    error?: { message?: string; code?: number };
}

/** Response shape for getTransactionsForAddress with transactionDetails: "full" */
interface HeliusFullTxResponse {
    jsonrpc: string;
    id: string;
    result?: {
        data: Array<{
            slot: number;
            blockTime: number | null;
            transaction: unknown;
            meta: unknown;
        }>;
        paginationToken?: string;
    };
    error?: { message?: string; code?: number };
}


/**
 * Primary: Use Helius's `getTransactionsForAddress` with ascending sort to find
 * the very first transaction for a mint in a SINGLE API call.
 *
 * Key capabilities (from Helius docs deep-dive):
 *   - `sortOrder: "asc"` → server-side ascending sort, oldest tx first
 *   - `transactionDetails: "signatures"` → lightweight, up to 1000 per call
 *   - `filters.status: "succeeded"` → only successful txs (skip failed noise)
 *   - `limit: 1` → just the absolute first transaction
 *
 * This method uses Helius's server-side index. It does NOT paginate client-side.
 * It works for tokens with ANY number of transactions (BONK, JUP, etc.)
 * because the server resolves the oldest tx directly from its index.
 *
 * @returns blockTime (unix seconds) of the first-ever tx, or null on failure
 */
async function findFirstTxViaHelius(
    mint: string,
    rpcUrl: string,
): Promise<number | null> {
    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sicarius-age-v2',
                method: 'getTransactionsForAddress',
                params: [
                    mint,
                    {
                        transactionDetails: 'signatures',
                        sortOrder: 'asc',
                        limit: 1,
                        filters: {
                            status: 'succeeded',
                        },
                    },
                ],
            }),
            signal: AbortSignal.timeout(15_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as HeliusSignaturesResponse;

        if (body.error || !body.result?.data?.length) return null;

        return body.result.data[0].blockTime ?? null;
    } catch {
        return null;
    }
}


/**
 * Emergency fallback: Standard RPC backward pagination.
 *
 * Limited to ~10k signatures (10 iterations × 1000 per page).
 * If we reach the limit without finding the end, the token is large
 * enough to be definitively mature — but we prefer Helius primary
 * which gives exact dates regardless.
 *
 * Only used if Helius enhanced API is unavailable (non-Helius RPC).
 */
async function findFirstTxViaRpc(
    connection: Connection,
    mintPk: PublicKey,
): Promise<{ timestamp: number | null; exhausted: boolean }> {
    let lastSig: string | undefined;
    let oldestBlockTime: number | null = null;
    let iterations = 0;
    const MAX_ITERATIONS = 10; // Reduced from 50 — Helius primary handles heavy tokens

    while (iterations < MAX_ITERATIONS) {
        const batch = await connection.getSignaturesForAddress(mintPk, {
            limit: 1000,
            before: lastSig,
        });

        if (batch.length === 0) break;

        const oldest = batch[batch.length - 1];
        if (oldest.blockTime) {
            oldestBlockTime = oldest.blockTime;
        }
        lastSig = oldest.signature;

        if (batch.length < 1000) break;
        iterations++;
    }

    return { timestamp: oldestBlockTime, exhausted: iterations >= MAX_ITERATIONS };
}

// ── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Determine a token's age by finding its first-ever transaction.
 *
 * Multi-tier strategy:
 *   1. Helius `getTransactionsForAddress` with `asc` sort — single call,
 *      exact creation date for ANY token regardless of volume.
 *   2. Standard RPC backward pagination (non-Helius RPCs only).
 *   3. If both fail, return 'unknown' with moderate risk score.
 *
 * @param connection  Solana RPC connection
 * @param mint        Token mint address (base58)
 * @returns           TokenAgeResult with creation timestamp and risk assessment
 */
export async function analyzeTokenAge(
    connection: Connection,
    mint: string,
): Promise<TokenAgeResult> {
    const now = new Date();
    const checkedAt = now.toISOString();

    try {
        const mintPk = new PublicKey(mint);
        const rpcUrl = process.env.HELIUS_RPC_URL || '';
        const isHelius = rpcUrl.includes('helius');

        let creationTimestamp: number | null = null;

        // ── Tier 1: Helius enhanced RPC (exact, single call) ─────────────
        if (isHelius) {
            creationTimestamp = await findFirstTxViaHelius(mint, rpcUrl);
        }

        // ── Tier 2: Standard RPC backward pagination fallback ────────────
        // Only if Helius primary failed or unavailable
        if (creationTimestamp === null) {
            const rpcResult = await findFirstTxViaRpc(connection, mintPk);
            creationTimestamp = rpcResult.timestamp;

            // If standard RPC exhausted pagination (10k+ txs without reaching
            // the beginning), token is definitively mature. But we can still
            // report the oldest timestamp we DID find as an approximation.
            if (rpcResult.exhausted) {
                const approxDate = creationTimestamp
                    ? new Date(creationTimestamp * 1000).toISOString()
                    : null;
                const approxAge = creationTimestamp
                    ? Math.floor(now.getTime() / 1000) - creationTimestamp
                    : null;
                return {
                    createdAt: approxDate,
                    ageSeconds: approxAge,
                    ageDays: approxAge ? Math.round((approxAge / SECONDS_PER_DAY) * 10) / 10 : null,
                    ageHuman: approxAge ? `${formatDuration(approxAge)}+ (approx)` : null,
                    ageCategory: 'mature',
                    riskScore: 0,
                    flags: ['HIGH_TX_VOLUME', 'RPC_FALLBACK_EXHAUSTED', 'HELIUS_ENHANCED_UNAVAILABLE'],
                    checkedAt,
                };
            }
        }

        // ── Both tiers failed ────────────────────────────────────────────
        if (creationTimestamp === null) {
            return {
                createdAt: null,
                ageSeconds: null,
                ageDays: null,
                ageHuman: null,
                ageCategory: 'unknown',
                riskScore: 5,
                flags: ['TOKEN_AGE_UNKNOWN'],
                checkedAt,
            };
        }

        // ── Success: compute age and categorize ──────────────────────────
        const createdAt = new Date(creationTimestamp * 1000).toISOString();
        const ageSeconds = Math.floor(now.getTime() / 1000) - creationTimestamp;
        const ageDays = Math.round((ageSeconds / SECONDS_PER_DAY) * 10) / 10;
        const ageHuman = formatDuration(ageSeconds);

        const { category, score, flags } = categorizeAge(ageSeconds);

        return {
            createdAt,
            ageSeconds,
            ageDays,
            ageHuman,
            ageCategory: category,
            riskScore: score,
            flags,
            checkedAt,
        };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
            createdAt: null,
            ageSeconds: null,
            ageDays: null,
            ageHuman: null,
            ageCategory: 'unknown',
            riskScore: 5,
            flags: [`TOKEN_AGE_ERROR: ${msg}`],
            checkedAt,
        };
    }
}
