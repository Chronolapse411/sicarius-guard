/**
 * SicariusGuard — Token Safety Analysis Engine
 *
 * Extracted and enhanced from Sicarius MEV Engine (token_safety.ts).
 * Performs byte-level analysis of SPL mint accounts to detect:
 *   1. Mint authority active (infinite supply printing)
 *   2. Freeze authority active (wallet freezing)
 *   3. Token-2022 dangerous extensions (PermanentDelegate, TransferHook, ConfidentialTransfers)
 *   4. Supply concentration in pool vaults (rug reserve detection)
 *
 * Returns a SafetyResult with boolean safe flag, risk score (0-100),
 * human-readable verdict, and detailed per-check breakdown.
 *
 * @author Chronolapse411
 * @version 2.0.0 — standalone extraction from Sicarius
 */

import { Connection, PublicKey } from '@solana/web3.js';

// ── Known dangerous Token-2022 extension type IDs ────────────────────────────
const DANGEROUS_EXTENSIONS = new Set([
    0x0d, // PermanentDelegate   — owner can drain any wallet silently
    0x0f, // TransferHook        — arbitrary code on every transfer (fee drain, honeypot)
    0x10, // ConfidentialTransfers — obscures balance from on-chain checks
]);

const EXTENSION_NAMES: Record<number, string> = {
    0x0d: 'PermanentDelegate',
    0x0f: 'TransferHook',
    0x10: 'ConfidentialTransfers',
};

// SPL Token-2022 program ID
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// Pump.fun migration program
const PUMPFUN_MIGRATION = '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg';

// ── Public Types ─────────────────────────────────────────────────────────────

export interface CheckDetail {
    status:  string;
    safe:    boolean;
    detail?: string;
}

export interface SafetyResult {
    safe:                boolean;
    riskScore:           number;   // 0 = perfectly safe, 100 = guaranteed rug
    verdict:             string;   // SAFE | CAUTION | HIGH_RISK | CRITICAL
    reason:              string;
    checks: {
        mintAuthority:       CheckDetail;
        freezeAuthority:     CheckDetail;
        token2022Extensions: CheckDetail & { extensions?: string[] };
        supplyConcentration: CheckDetail & { poolPct?: number };
    };
    meta: {
        programId:   string;
        isToken2022: boolean;
        checkedAt:   string;
    };
}

// ── Internal Helpers ─────────────────────────────────────────────────────────

/**
 * Check if a PumpSwap graduation tx revoked mint authority via SetAuthority.
 * PumpSwap migration always calls SetAuthority(MintTokens, None) during graduation.
 */
function txRevokesMintAuthority(txInfo: unknown, mint: string): boolean {
    try {
        const tx = txInfo as Record<string, unknown>;
        const meta = tx?.meta as Record<string, unknown> | undefined;
        const transaction = tx?.transaction as Record<string, unknown> | undefined;
        const innerIxs = (meta?.innerInstructions ?? []) as Array<{ instructions?: unknown[] }>;
        const outerIxs = (transaction?.message as Record<string, unknown>)?.instructions as unknown[] ?? [];

        const allIxs = [...outerIxs, ...innerIxs.flatMap(g => g.instructions ?? [])];

        for (const ix of allIxs) {
            const parsed = (ix as Record<string, unknown>)?.parsed as Record<string, unknown> | undefined;
            if (parsed?.type === 'setAuthority') {
                const info = parsed?.info as Record<string, unknown> | undefined;
                if (
                    info?.mint === mint &&
                    info?.authorityType === 'mintTokens' &&
                    (info?.newAuthority === null || info?.newAuthority === undefined)
                ) {
                    return true;
                }
            }
        }
    } catch { /* best-effort */ }
    return false;
}

function computeRiskScore(checks: SafetyResult['checks']): number {
    let score = 0;
    if (!checks.mintAuthority.safe)       score += 40; // highest risk — infinite supply
    if (!checks.freezeAuthority.safe)     score += 25; // can freeze wallets
    if (!checks.token2022Extensions.safe) score += 25; // delegate/hook traps
    if (!checks.supplyConcentration.safe)  score += 10; // rug reserve
    return Math.min(score, 100);
}

function computeVerdict(score: number): string {
    if (score === 0)  return 'SAFE';
    if (score <= 15)  return 'CAUTION';
    if (score <= 50)  return 'HIGH_RISK';
    return 'CRITICAL';
}

// ── Main Analysis Function ───────────────────────────────────────────────────

/**
 * Analyze a Solana SPL token mint for rug pull, honeypot, and safety risks.
 *
 * @param connection  Solana RPC connection (finalized commitment recommended)
 * @param mint        Token mint address string
 * @param txInfo      Optional: pool creation / graduation tx (getParsedTransaction result)
 * @param isPumpSwap  true = PumpSwap graduation (enables tx-based mint auth verification)
 */
export async function analyzeTokenSafety(
    connection: Connection,
    mint: string,
    txInfo?: unknown,
    isPumpSwap = false,
): Promise<SafetyResult> {
    const now = new Date().toISOString();

    const failResult = (reason: string, checks: SafetyResult['checks'], programId: string, isToken2022: boolean): SafetyResult => {
        const riskScore = computeRiskScore(checks);
        return {
            safe: false,
            riskScore,
            verdict: computeVerdict(riskScore),
            reason,
            checks,
            meta: { programId, isToken2022, checkedAt: now },
        };
    };

    const defaultChecks: SafetyResult['checks'] = {
        mintAuthority:       { status: 'UNKNOWN', safe: false },
        freezeAuthority:     { status: 'UNKNOWN', safe: false },
        token2022Extensions: { status: 'UNKNOWN', safe: true, extensions: [] },
        supplyConcentration: { status: 'UNKNOWN', safe: true },
    };

    try {
        const mintPk = new PublicKey(mint);

        // ── Check 1: Mint authority ──────────────────────────────────────────
        let mintAuthorityNull = false;

        // FAST PATH: PumpSwap graduations contain SetAuthority(MintTokens, None)
        if (isPumpSwap && txInfo && txRevokesMintAuthority(txInfo, mint)) {
            mintAuthorityNull = true;
        }

        // Fetch mint account with finalized commitment
        const mintAcct = await connection.getAccountInfo(mintPk, 'finalized');
        if (!mintAcct) {
            return failResult('Mint account not found', defaultChecks, '', false);
        }

        const data = mintAcct.data;
        const programId = mintAcct.owner.toBase58();
        const isToken2022 = programId === TOKEN_2022_PROGRAM;

        if (!mintAuthorityNull) {
            // SPL Mint layout: [mint_authority_option(u32)] [mint_authority(Pubkey, 32)] ...
            let mintAuthTag = data.readUInt32LE(0);

            // Retry with fresh read after 700ms (graduation SetAuthority finalization lag)
            if (mintAuthTag !== 0) {
                await new Promise(r => setTimeout(r, 700));
                const retryAcct = await connection.getAccountInfo(mintPk, 'finalized');
                if (retryAcct) mintAuthTag = retryAcct.data.readUInt32LE(0);
            }

            if (mintAuthTag !== 0) {
                const checks = { ...defaultChecks };
                checks.mintAuthority = { status: 'ACTIVE', safe: false, detail: 'Can print infinite tokens' };
                checks.freezeAuthority = { status: 'UNCHECKED', safe: true };
                return failResult('Mint authority active — can print infinite tokens', checks, programId, isToken2022);
            }
            mintAuthorityNull = true;
        }

        const checks: SafetyResult['checks'] = {
            mintAuthority:       { status: 'REVOKED', safe: true },
            freezeAuthority:     { status: 'UNKNOWN', safe: false },
            token2022Extensions: { status: 'CLEAN', safe: true, extensions: [] },
            supplyConcentration: { status: 'UNKNOWN', safe: true },
        };

        // ── Check 2: Freeze authority (SPL layout offset 46) ────────────────
        const freezeAuthTag = data.readUInt32LE(46);
        if (freezeAuthTag !== 0) {
            checks.freezeAuthority = { status: 'ACTIVE', safe: false, detail: 'Can freeze any wallet' };
            return failResult('Freeze authority active — can freeze any wallet', checks, programId, isToken2022);
        }
        checks.freezeAuthority = { status: 'REVOKED', safe: true };

        // ── Check 3: Token-2022 dangerous extension scan ────────────────────
        if (isToken2022 && data.length > 165) {
            let cursor = 165;
            const foundExtensions: string[] = [];
            while (cursor + 4 <= data.length) {
                const extType = data.readUInt16LE(cursor);
                const extLength = data.readUInt16LE(cursor + 2);
                cursor += 4;
                if (DANGEROUS_EXTENSIONS.has(extType)) {
                    const name = EXTENSION_NAMES[extType] || `Unknown(0x${extType.toString(16)})`;
                    foundExtensions.push(name);
                }
                cursor += extLength;
                if (extLength === 0) break;
            }
            if (foundExtensions.length > 0) {
                checks.token2022Extensions = {
                    status: 'DANGEROUS',
                    safe: false,
                    detail: `Found: ${foundExtensions.join(', ')}`,
                    extensions: foundExtensions,
                };
                return failResult(
                    `Dangerous Token-2022 extensions: ${foundExtensions.join(', ')}`,
                    checks, programId, isToken2022,
                );
            }
        }

        // ── Check 4: Supply concentration in pool vault ─────────────────────
        if (txInfo) {
            try {
                const tx = txInfo as Record<string, unknown>;
                const meta = tx?.meta as Record<string, unknown> | undefined;
                const postBal = (meta?.postTokenBalances ?? []) as Array<Record<string, unknown>>;
                const supplyRaw = Number(data.readBigUInt64LE(36));

                const poolVaultTotal = postBal
                    .filter((b) => b.mint === mint)
                    .reduce((acc, b) => {
                        const amount = (b.uiTokenAmount as Record<string, unknown>)?.amount;
                        return acc + Number(amount ?? 0);
                    }, 0);

                if (supplyRaw > 0) {
                    const poolPct = poolVaultTotal / supplyRaw;
                    if (poolPct < 0.05) {
                        checks.supplyConcentration = {
                            status: 'CONCENTRATED',
                            safe: false,
                            detail: `Only ${(poolPct * 100).toFixed(1)}% of supply in pool — rug reserve suspected`,
                            poolPct: Math.round(poolPct * 1000) / 10,
                        };
                        return failResult(
                            `Low pool supply (${(poolPct * 100).toFixed(1)}% in pool)`,
                            checks, programId, isToken2022,
                        );
                    }
                    checks.supplyConcentration = { status: 'OK', safe: true, poolPct: Math.round(poolPct * 1000) / 10 };
                }
            } catch {
                checks.supplyConcentration = { status: 'PARSE_ERROR', safe: true, detail: 'Could not parse tx balances' };
            }
        } else {
            checks.supplyConcentration = { status: 'NO_TX_PROVIDED', safe: true, detail: 'Supply check skipped (no tx provided)' };
        }

        const riskScore = computeRiskScore(checks);
        return {
            safe: true,
            riskScore,
            verdict: computeVerdict(riskScore),
            reason: 'SAFE — mint/freeze revoked, no dangerous extensions, supply OK',
            checks,
            meta: { programId, isToken2022, checkedAt: now },
        };

    } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return failResult(`Safety analysis error: ${msg}`, defaultChecks, '', false);
    }
}
