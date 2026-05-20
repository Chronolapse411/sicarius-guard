/**
 * SicariusGuard — Liquidity Pool Lock Analyzer
 *
 * Determines whether a token's primary trading pool has its LP tokens
 * permanently burned, held by a recognized locker contract, or still
 * accessible by the deployer (rug-pullable).
 *
 * Detection pipeline:
 *   1. Discover pool address via GeckoTerminal (free, no key)
 *   2. Fallback to Raydium V3 API (free, mint+WSOL pair lookup)
 *   3. Decode Raydium AMM V4 on-chain layout → extract LP mint
 *   4. Compare LP supply vs reserve → compute burn percentage
 *   5. Scan LP token holders against known burn/locker addresses
 *   6. (Helius) Get pool creation TX for exact creation date + initial liquidity
 *
 * @author Chronolapse411
 * @version 1.1.0 — Added pool creation TX analysis via Helius
 */

import { Connection, PublicKey, type ParsedAccountData } from '@solana/web3.js';

// ── Constants ────────────────────────────────────────────────────────────────

/** Raydium Legacy AMM V4 program */
const RAYDIUM_V4_PROGRAM = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

/** Wrapped SOL mint — default quote token for pool discovery */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

/**
 * Raydium AMM V4 pool state byte offsets.
 * Computed from the canonical `liquidityStateV4Layout` struct in raydium-sdk-V2.
 *
 * Layout order (abbreviated, V4 only):
 *   30× u64 → 2× u128 → 1× u64 → 2× u128 → 1× u64
 *   → baseVault(32) → quoteVault(32) → baseMint(32) → quoteMint(32)
 *   → lpMint(32) → openOrders(32) → marketId(32) → marketProgramId(32)
 *   → targetOrders(32) → withdrawQueue(32) → lpVault(32) → owner(32)
 *   → lpReserve(u64) → padding(3× u64)
 */
const POOL_OFFSET = {
    /** PublicKey — SPL token account holding the base (coin) tokens */
    BASE_VAULT:   336,
    /** PublicKey — SPL token account holding the quote (PC/SOL) tokens */
    QUOTE_VAULT:  368,
    /** PublicKey — mint address of the LP token */
    LP_MINT:      464,
    /** u64 LE — total LP tokens ever minted (used for burn % calculation) */
    LP_RESERVE:   720,
    /** u64 LE — Unix timestamp when pool opened for trading */
    POOL_OPEN:    224,
} as const;

/** Total size of a Raydium V4 pool state account */
const RAYDIUM_V4_ACCOUNT_SIZE = 752;

/**
 * Known permanent burn addresses — tokens sent here can never be recovered.
 * Keys are base58 addresses, values are human-readable labels.
 */
const BURN_ADDRESSES: Record<string, string> = {
    '1nc1nerator11111111111111111111111111111111': 'Solana Incinerator',
    '11111111111111111111111111111111':             'System Null Address',
};

/**
 * Known LP locker program IDs — tokens held by these programs are
 * contractually locked and cannot be withdrawn until unlock conditions are met.
 */
const LOCKER_PROGRAMS: Record<string, string> = {
    '8e72pYCDaxu3GqMfeQ5r8wFgoZSYk6oua1Qo9XpsZjX': 'Streamflow',
    'GsSCS3vPWrtJ5Y9aEVVT65fmrex5P5RGHXdZvsdbWgfo': 'UNCX AMM V4',
    'UNCX77nZrA3TdAxMEggqG18xxpgiNGT6iqyynPwpoxN':  'UNCX Smart',
    'UNCXdvMRxvz91g3HqFmpZ5NgmL77UH4QRM4NfeL4mQB':  'UNCX CP Swap',
    'UNCXrB8cZXnmtYM1aSo1Wx3pQaeSZYuF2jCTesXvECs':  'UNCX CLMM',
};

// ── Public Types ─────────────────────────────────────────────────────────────

export interface LpLockResult {
    poolFound:           boolean;
    poolAddress:         string | null;
    poolSource:          'gecko' | 'raydium' | null;
    lpMint:              string | null;
    burnPct:             number;
    isLocked:            boolean;
    lockType:            'burned' | 'locker' | 'unlocked' | 'unknown';
    lockerName:          string | null;
    poolCreatedAt:       string | null;
    poolCreator:         string | null;
    initialLiquiditySOL: number | null;
    riskScore:           number;
    flags:               string[];
    checkedAt:           string;
}

// ── Pool Creation TX (Helius Enhanced) ───────────────────────────────────────

interface PoolCreationInfo {
    createdAt:           string;
    creator:             string | null;
    initialLiquiditySOL: number | null;
}

/**
 * Fetch the pool's very first transaction via Helius `getTransactionsForAddress`.
 * Returns creation date, creator wallet, and initial SOL liquidity.
 *
 * Uses `sortOrder: "asc"` + `limit: 1` + `transactionDetails: "full"` to get
 * the pool creation TX in a single API call.
 */
async function findPoolCreationViaHelius(
    poolAddress: string,
): Promise<PoolCreationInfo | null> {
    const rpcUrl = process.env.HELIUS_RPC_URL || '';
    if (!rpcUrl.includes('helius')) return null;

    try {
        const res = await fetch(rpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 'sicarius-pool-creation',
                method: 'getTransactionsForAddress',
                params: [
                    poolAddress,
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

        if (!res.ok) return null;

        const body = await res.json() as {
            result?: {
                data?: Array<{
                    blockTime: number | null;
                    transaction?: {
                        message?: {
                            accountKeys?: string[];
                        };
                    };
                    meta?: {
                        preBalances?: number[];
                        postBalances?: number[];
                    };
                }>;
            };
            error?: unknown;
        };

        const tx = body.result?.data?.[0];
        if (!tx?.blockTime) return null;

        const createdAt = new Date(tx.blockTime * 1000).toISOString();

        // First account key is the fee payer (= pool creator)
        const accountKeys = tx.transaction?.message?.accountKeys;
        const creator = accountKeys?.[0] ?? null;

        // Estimate initial SOL liquidity from balance changes
        // The pool account's post-balance minus pre-balance = SOL deposited
        let initialLiquiditySOL: number | null = null;
        const preBalances = tx.meta?.preBalances;
        const postBalances = tx.meta?.postBalances;

        if (accountKeys && preBalances && postBalances) {
            const poolIdx = accountKeys.indexOf(poolAddress);
            if (poolIdx >= 0 && preBalances[poolIdx] !== undefined && postBalances[poolIdx] !== undefined) {
                const balanceChange = (postBalances[poolIdx] - preBalances[poolIdx]) / 1e9;
                if (balanceChange > 0) {
                    initialLiquiditySOL = Math.round(balanceChange * 1000) / 1000;
                }
            }
        }

        return { createdAt, creator, initialLiquiditySOL };
    } catch {
        return null;
    }
}

// ── Pool Discovery ───────────────────────────────────────────────────────────

/**
 * Find the primary trading pool for a token via GeckoTerminal.
 * Free API, no key required, ~30 req/min rate limit.
 */
async function discoverPoolViaGecko(mint: string): Promise<string | null> {
    try {
        const res = await fetch(
            `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${mint}/pools?page=1`,
            {
                headers: { 'Accept': 'application/json;version=20230302' },
                signal: AbortSignal.timeout(8_000),
            },
        );

        if (!res.ok) return null;

        const body = await res.json() as {
            data?: Array<{ id?: string; attributes?: { name?: string } }>;
        };

        const topPool = body.data?.[0];
        if (!topPool?.id) return null;

        // GeckoTerminal pool IDs are formatted as "solana_<pool_address>"
        const poolAddr = topPool.id.replace(/^solana_/, '');
        return poolAddr.length >= 32 ? poolAddr : null;
    } catch {
        return null;
    }
}

/**
 * Fallback pool discovery via Raydium V3 API.
 * Searches for token paired with WSOL.
 */
async function discoverPoolViaRaydium(mint: string): Promise<string | null> {
    try {
        const url = new URL('https://api-v3.raydium.io/pools/info/mint');
        url.searchParams.set('mint1', mint);
        url.searchParams.set('mint2', WSOL_MINT);
        url.searchParams.set('poolType', 'all');
        url.searchParams.set('poolSortField', 'default');
        url.searchParams.set('sortType', 'desc');
        url.searchParams.set('pageSize', '1');

        const res = await fetch(url.toString(), {
            signal: AbortSignal.timeout(8_000),
        });

        if (!res.ok) return null;

        const body = await res.json() as {
            data?: { data?: Array<{ id?: string }> };
        };

        return body.data?.data?.[0]?.id ?? null;
    } catch {
        return null;
    }
}

// ── On-Chain LP Analysis ─────────────────────────────────────────────────────

/**
 * Read the LP mint public key directly from Raydium V4 pool account data.
 * No SDK dependency — raw byte offset read.
 */
function extractLpMintFromPoolData(data: Buffer): PublicKey | null {
    if (data.length < RAYDIUM_V4_ACCOUNT_SIZE) return null;
    try {
        return new PublicKey(data.subarray(POOL_OFFSET.LP_MINT, POOL_OFFSET.LP_MINT + 32));
    } catch {
        return null;
    }
}

/**
 * Read the LP reserve (u64 little-endian) from pool account data.
 */
function extractLpReserveFromPoolData(data: Buffer): bigint {
    if (data.length < RAYDIUM_V4_ACCOUNT_SIZE) return 0n;
    return data.readBigUInt64LE(POOL_OFFSET.LP_RESERVE);
}

/**
 * Read the base and quote vault public keys from pool account data.
 * These are SPL token accounts whose balances represent actual pool liquidity.
 */
function extractVaultsFromPoolData(data: Buffer): {
    baseVault: PublicKey | null;
    quoteVault: PublicKey | null;
} {
    if (data.length < RAYDIUM_V4_ACCOUNT_SIZE) {
        return { baseVault: null, quoteVault: null };
    }
    try {
        return {
            baseVault:  new PublicKey(data.subarray(POOL_OFFSET.BASE_VAULT, POOL_OFFSET.BASE_VAULT + 32)),
            quoteVault: new PublicKey(data.subarray(POOL_OFFSET.QUOTE_VAULT, POOL_OFFSET.QUOTE_VAULT + 32)),
        };
    } catch {
        return { baseVault: null, quoteVault: null };
    }
}

/**
 * Determine if a holder address is a known burn destination or locker.
 */
function classifyHolder(ownerAddress: string): {
    isBurned: boolean;
    isLocked: boolean;
    label: string | null;
} {
    if (BURN_ADDRESSES[ownerAddress]) {
        return { isBurned: true, isLocked: true, label: BURN_ADDRESSES[ownerAddress] };
    }
    if (LOCKER_PROGRAMS[ownerAddress]) {
        return { isBurned: false, isLocked: true, label: LOCKER_PROGRAMS[ownerAddress] };
    }
    return { isBurned: false, isLocked: false, label: null };
}

// ── Risk Assessment ──────────────────────────────────────────────────────────

function assessLpRisk(burnPct: number, lockType: string): { score: number; flags: string[] } {
    const flags: string[] = [];
    let score = 0;

    if (lockType === 'burned') {
        if (burnPct >= 95) {
            flags.push(`LP_BURNED_${burnPct.toFixed(1)}%`);
            score = 0;
        } else if (burnPct >= 50) {
            flags.push(`LP_PARTIALLY_BURNED_${burnPct.toFixed(1)}%`);
            score = 10;
        } else {
            flags.push(`LP_LOW_BURN_${burnPct.toFixed(1)}%`);
            score = 20;
        }
    } else if (lockType === 'locker') {
        flags.push('LP_IN_LOCKER');
        score = 5;
    } else if (lockType === 'unlocked') {
        flags.push('LP_UNLOCKED');
        score = 25;
    } else {
        flags.push('LP_STATUS_UNKNOWN');
        score = 10;
    }

    return { score, flags };
}

// ── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Analyze LP lock status for a Solana token.
 *
 * @param connection  Solana RPC connection
 * @param mint        Token mint address (base58)
 * @returns           LpLockResult with burn percentage, lock type, and risk score
 */
export async function analyzeLpLock(
    connection: Connection,
    mint: string,
): Promise<LpLockResult> {
    const now = new Date().toISOString();

    const emptyResult = (flags: string[], score: number): LpLockResult => ({
        poolFound: false,
        poolAddress: null,
        poolSource: null,
        lpMint: null,
        burnPct: 0,
        isLocked: false,
        lockType: 'unknown',
        lockerName: null,
        poolCreatedAt: null,
        poolCreator: null,
        initialLiquiditySOL: null,
        riskScore: score,
        flags,
        checkedAt: now,
    });

    try {
        // ── Step 1: Discover pool ────────────────────────────────────────
        let poolAddress = await discoverPoolViaGecko(mint);
        let poolSource: 'gecko' | 'raydium' = 'gecko';

        if (!poolAddress) {
            poolAddress = await discoverPoolViaRaydium(mint);
            poolSource = 'raydium';
        }

        if (!poolAddress) {
            return emptyResult(['NO_POOL_FOUND'], 10);
        }

        // ── Step 2: Fetch pool account data ──────────────────────────────
        const poolPk = new PublicKey(poolAddress);
        const poolAcct = await connection.getAccountInfo(poolPk);

        if (!poolAcct || !poolAcct.owner.equals(RAYDIUM_V4_PROGRAM)) {
            // Pool exists but isn't Raydium V4 — can't decode, treat as unknown
            return {
                ...emptyResult(['NON_RAYDIUM_POOL'], 10),
                poolFound: true,
                poolAddress,
                poolSource,
            };
        }

        // ── Step 3: Extract LP mint from raw account bytes ───────────────
        const lpMintPk = extractLpMintFromPoolData(poolAcct.data as Buffer);
        if (!lpMintPk) {
            return {
                ...emptyResult(['LP_MINT_DECODE_FAILED'], 10),
                poolFound: true,
                poolAddress,
                poolSource,
            };
        }

        const lpMint = lpMintPk.toBase58();
        const lpReserve = extractLpReserveFromPoolData(poolAcct.data as Buffer);
        const { baseVault, quoteVault } = extractVaultsFromPoolData(poolAcct.data as Buffer);

        // ── Step 4: Fetch LP token supply info ───────────────────────────
        const lpAcctInfo = await connection.getParsedAccountInfo(lpMintPk);
        const mintData = (lpAcctInfo?.value?.data as ParsedAccountData)?.parsed?.info;

        if (!mintData) {
            return {
                ...emptyResult(['LP_MINT_INFO_UNAVAILABLE'], 10),
                poolFound: true,
                poolAddress,
                poolSource,
                lpMint,
            };
        }

        const decimals: number = mintData.decimals ?? 0;
        const actualSupply = Number(mintData.supply) / Math.pow(10, decimals);
        const reserveNormalized = Number(lpReserve) / Math.pow(10, decimals);

        // Burn % = (reserve - circulating supply) / reserve × 100
        // Reserve represents total ever minted; supply is what still exists
        const burnPct = reserveNormalized > 0
            ? Math.min(((reserveNormalized - actualSupply) / reserveNormalized) * 100, 100)
            : 0;

        // ── Step 5: Check largest LP token holders ───────────────────────
        let lockType: 'burned' | 'locker' | 'unlocked' | 'unknown' = 'unknown';
        let lockerName: string | null = null;

        try {
            const largestHolders = await connection.getTokenLargestAccounts(lpMintPk);
            const topHolder = largestHolders.value[0];

            if (topHolder) {
                // Resolve the owner of the largest LP token account
                const holderAcctInfo = await connection.getParsedAccountInfo(topHolder.address);
                const ownerAddr = (holderAcctInfo?.value?.data as ParsedAccountData)?.parsed?.info?.owner;

                if (ownerAddr) {
                    const classification = classifyHolder(ownerAddr);
                    if (classification.isBurned) {
                        lockType = 'burned';
                        lockerName = classification.label;
                    } else if (classification.isLocked) {
                        lockType = 'locker';
                        lockerName = classification.label;
                    } else {
                        lockType = burnPct >= 95 ? 'burned' : 'unlocked';
                    }
                }
            }
        } catch {
            // If holder lookup fails, fall back to burn percentage heuristic
            lockType = burnPct >= 95 ? 'burned' : 'unknown';
        }

        const isLocked = lockType === 'burned' || lockType === 'locker';
        const { score, flags } = assessLpRisk(burnPct, lockType);

        // ── Step 6: Pool liquidity snapshot (vault balances) ─────────────
        // Read actual vault SPL token balances — this is the REAL liquidity,
        // not the rent-exempt deposit on the pool account (BUG-002 fix).
        let initialLiquiditySOL: number | null = null;
        if (quoteVault) {
            try {
                const vaultBal = await connection.getTokenAccountBalance(quoteVault);
                const solAmount = vaultBal.value.uiAmount;
                if (solAmount !== null && solAmount > 0) {
                    initialLiquiditySOL = Math.round(solAmount * 1000) / 1000;
                }
            } catch {
                // Vault read failed — non-fatal
            }
        }

        // ── Step 7: Pool creation TX (Helius enhanced, best-effort) ──────
        const creationInfo = await findPoolCreationViaHelius(poolAddress);
        if (creationInfo) {
            flags.push(`POOL_CREATED_${creationInfo.createdAt.split('T')[0]}`);
        }
        if (initialLiquiditySOL !== null && initialLiquiditySOL < 1) {
            flags.push(`LOW_LIQUIDITY_${initialLiquiditySOL}SOL`);
        } else if (initialLiquiditySOL !== null) {
            flags.push(`LIQUIDITY_${initialLiquiditySOL}SOL`);
        }

        return {
            poolFound: true,
            poolAddress,
            poolSource,
            lpMint,
            burnPct: Math.round(burnPct * 10) / 10,
            isLocked,
            lockType,
            lockerName,
            poolCreatedAt: creationInfo?.createdAt ?? null,
            poolCreator: creationInfo?.creator ?? null,
            initialLiquiditySOL,
            riskScore: score,
            flags,
            checkedAt: now,
        };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return emptyResult([`LP_ANALYSIS_ERROR: ${msg}`], 10);
    }
}
