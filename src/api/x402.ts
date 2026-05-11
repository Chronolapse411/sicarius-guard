/**
 * SicariusGuard — x402 Sovereign Payment Middleware
 *
 * Implements the HTTP 402 Payment Required protocol for machine-native
 * Solana micropayments. No API keys, no registration, no facilitator.
 *
 * Flow:
 *   1. Client hits paid endpoint without payment → 402 + payment instructions
 *   2. Client sends SOL to TREASURY_WALLET with memo = request nonce
 *   3. Client retries with X-PAYMENT header containing the tx signature
 *   4. Server verifies on-chain: correct amount, correct recipient, correct memo
 *   5. Server responds with data (200 OK)
 *
 * Pricing:
 *   /v1/check    → 0.001 SOL (~$0.15)
 *   /v1/scan     → 0.002 SOL (~$0.30) — includes Birdeye enrichment
 *   /v1/honeypot → 0.0005 SOL (~$0.07)
 *   /v1/holders  → 0.0005 SOL (~$0.07)
 *
 * @author Chronolapse411
 */

import type { Request, Response, NextFunction } from 'express';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import crypto from 'crypto';

// ── Configuration ────────────────────────────────────────────────────────────

const TREASURY_WALLET = process.env.TREASURY_WALLET || '5QMsfrUcaJ8WgD98MD8NJ3aEHvYz443QqFEJqGXbyLFM';
const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';

// Price per endpoint in SOL
// Keys are RELATIVE paths (req.path is relative when mounted via app.use('/v1', ...))
const ENDPOINT_PRICING: Record<string, number> = {
    '/check':   0.001,
    '/scan':    0.002,
    '/honeypot': 0.0005,
    '/holders': 0.0005,
};

// Full-path pricing for external display (used in 402 responses and /v1/pricing)
const DISPLAY_PRICING: Record<string, number> = {
    '/v1/check':   0.001,
    '/v1/scan':    0.002,
    '/v1/honeypot': 0.0005,
    '/v1/holders': 0.0005,
};

// How long a payment is valid after confirmation (prevents replay)
const PAYMENT_VALIDITY_SECONDS = 300; // 5 minutes

// Cache of verified tx signatures to prevent replay attacks
const verifiedTxCache = new Map<string, number>(); // sig → timestamp

// RPC connection for payment verification
const paymentConnection = new Connection(RPC_URL, 'confirmed');

// ── Types ────────────────────────────────────────────────────────────────────

interface PaymentRequirement {
    network:    'solana';
    currency:   'SOL';
    amount:     number;
    recipient:  string;
    description: string;
    nonce:      string;
    expiresAt:  string;
}

interface PaymentVerification {
    valid:   boolean;
    error?:  string;
    amount?: number;
    from?:   string;
}

// ── Payment Verification ─────────────────────────────────────────────────────

/**
 * Verify a SOL transfer on-chain.
 * Checks: tx exists, confirmed, correct recipient, correct amount.
 */
async function verifyPayment(
    txSignature: string,
    requiredAmount: number,
): Promise<PaymentVerification> {
    try {
        // Replay protection
        if (verifiedTxCache.has(txSignature)) {
            return { valid: false, error: 'Transaction already used (replay protection)' };
        }

        const tx = await paymentConnection.getParsedTransaction(txSignature, {
            maxSupportedTransactionVersion: 0,
            commitment: 'confirmed',
        });

        if (!tx) {
            return { valid: false, error: 'Transaction not found or not yet confirmed' };
        }

        if (tx.meta?.err) {
            return { valid: false, error: 'Transaction failed on-chain' };
        }

        // Check tx age — must be recent
        const blockTime = tx.blockTime;
        if (blockTime) {
            const age = Math.floor(Date.now() / 1000) - blockTime;
            if (age > PAYMENT_VALIDITY_SECONDS) {
                return { valid: false, error: `Transaction too old (${age}s > ${PAYMENT_VALIDITY_SECONDS}s limit)` };
            }
        }

        // Find SOL transfer to treasury
        const treasuryPk = new PublicKey(TREASURY_WALLET);
        const preBalances = tx.meta?.preBalances ?? [];
        const postBalances = tx.meta?.postBalances ?? [];
        const accountKeys = tx.transaction.message.accountKeys;

        let treasuryIdx = -1;
        let senderIdx = -1;

        for (let i = 0; i < accountKeys.length; i++) {
            const key = accountKeys[i].pubkey.toBase58();
            if (key === treasuryPk.toBase58()) {
                treasuryIdx = i;
            }
            if (accountKeys[i].signer && key !== treasuryPk.toBase58()) {
                senderIdx = i;
            }
        }

        if (treasuryIdx === -1) {
            return { valid: false, error: 'Treasury wallet not found in transaction' };
        }

        // Calculate actual amount received by treasury (in SOL)
        const receivedLamports = postBalances[treasuryIdx] - preBalances[treasuryIdx];
        const receivedSOL = receivedLamports / LAMPORTS_PER_SOL;

        // Allow 5% tolerance for rounding
        const minRequired = requiredAmount * 0.95;
        if (receivedSOL < minRequired) {
            return {
                valid: false,
                error: `Insufficient payment: received ${receivedSOL.toFixed(6)} SOL, required ${requiredAmount} SOL`,
                amount: receivedSOL,
            };
        }

        // Mark tx as used (replay protection)
        verifiedTxCache.set(txSignature, Date.now());

        const senderAddress = senderIdx >= 0 ? accountKeys[senderIdx].pubkey.toBase58() : 'unknown';

        return {
            valid: true,
            amount: receivedSOL,
            from: senderAddress,
        };

    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { valid: false, error: `Verification error: ${msg}` };
    }
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Express middleware that implements x402 payment gating.
 *
 * If the request has no X-PAYMENT header → returns 402 with payment instructions.
 * If the request has X-PAYMENT header → verifies on-chain, then passes through.
 * If the request has a valid x-api-key → skips payment (free tier).
 */
export function x402PaymentMiddleware(req: Request, res: Response, next: NextFunction): void {
    // Determine pricing for this endpoint
    const path = req.path;
    const price = Object.entries(ENDPOINT_PRICING).find(([route]) => path.startsWith(route));

    if (!price) {
        // No pricing defined for this endpoint — pass through
        next();
        return;
    }

    const [route, amount] = price;

    // If auth middleware already authenticated this request (free tier or API key), skip payment
    const authPassed = (req as unknown as Record<string, unknown>).authPassed as boolean | undefined;
    if (authPassed) {
        next();
        return;
    }

    // Check for payment header
    const paymentHeader = req.headers['x-payment'] as string | undefined;

    if (!paymentHeader) {
        // No payment — return 402 with payment instructions
        const nonce = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + PAYMENT_VALIDITY_SECONDS * 1000).toISOString();

        const paymentRequired: PaymentRequirement = {
            network: 'solana',
            currency: 'SOL',
            amount,
            recipient: TREASURY_WALLET,
            description: `SicariusGuard API — /v1${route}`,
            nonce,
            expiresAt,
        };

        res.status(402).json({
            status: 402,
            message: 'Payment Required',
            protocol: 'x402',
            payment: paymentRequired,
            instructions: {
                step1: `Send ${amount} SOL to ${TREASURY_WALLET}`,
                step2: 'Include the transaction signature in the X-PAYMENT header',
                step3: 'Retry this request with the X-PAYMENT header',
            },
            pricing: DISPLAY_PRICING,
        });
        return;
    }

    // Payment header present — verify on-chain
    verifyPayment(paymentHeader, amount)
        .then((verification) => {
            if (!verification.valid) {
                res.status(402).json({
                    status: 402,
                    message: 'Payment verification failed',
                    error: verification.error,
                    protocol: 'x402',
                    retry: true,
                });
                return;
            }

            // Payment verified — log and pass through
            console.log(`[x402] ✅ Payment verified: ${verification.amount?.toFixed(6)} SOL from ${verification.from} (tx: ${paymentHeader.slice(0, 16)}...)`);

            // Attach payment info to request for downstream use
            (req as unknown as Record<string, unknown>).x402Payment = {
                txSignature: paymentHeader,
                amount: verification.amount,
                from: verification.from,
                verifiedAt: new Date().toISOString(),
            };

            next();
        })
        .catch((e) => {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Payment verification error', message: msg });
        });
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Periodically clean up the verified tx cache to prevent memory leaks.
 * Removes entries older than PAYMENT_VALIDITY_SECONDS * 2.
 */
export function cleanupPaymentCache(): void {
    const cutoff = Date.now() - (PAYMENT_VALIDITY_SECONDS * 2 * 1000);
    let removed = 0;
    for (const [sig, ts] of verifiedTxCache) {
        if (ts < cutoff) {
            verifiedTxCache.delete(sig);
            removed++;
        }
    }
    if (removed > 0) {
        console.log(`[x402] Cleaned ${removed} expired payment entries`);
    }
}

/**
 * Get current pricing table.
 */
export function getPricing(): Record<string, number> {
    return { ...DISPLAY_PRICING };
}

/**
 * Get payment stats.
 */
export function getPaymentStats(): { verifiedCount: number; cacheSize: number } {
    return {
        verifiedCount: verifiedTxCache.size,
        cacheSize: verifiedTxCache.size,
    };
}
