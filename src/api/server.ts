/**
 * SicariusGuard — Express REST API Server
 *
 * Endpoints:
 *   POST /v1/check          — full token safety analysis
 *   POST /v1/honeypot       — honeypot-only check (Jupiter sell sim)
 *   POST /v1/holders        — holder concentration analysis
 *   GET  /v1/check/:mint    — convenience GET for simple checks
 *   GET  /health            — health check
 *
 * @author Chronolapse411
 */

import express from 'express';
import cors from 'cors';
import { Connection } from '@solana/web3.js';
import { analyzeTokenSafety, type SafetyResult } from '../core/token_safety.js';
import { checkHoneypot, type HoneypotResult } from '../core/honeypot_sim.js';
import { analyzeHolders, type HolderResult } from '../core/holder_analysis.js';
import { authMiddleware, cleanupRateLimits } from './auth.js';
import { ResultCache } from './cache.js';
import { enrichWithBirdeye, type BirdeyeEnrichment } from '../core/birdeye.js';
import { enrichCreatorReputation, extractHeliusApiKey, type WalletIntelligence } from '../core/helius_wallet.js';
import { x402PaymentMiddleware, cleanupPaymentCache, getPricing, getPaymentStats } from './x402.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface FullCheckResult {
    safety:   SafetyResult;
    honeypot: HoneypotResult;
    holders:  HolderResult;
    combined: {
        safe:      boolean;
        riskScore: number;
        verdict:   string;
        summary:   string;
    };
}

interface FullScanResult {
    safety:    SafetyResult;
    honeypot:  HoneypotResult;
    holders:   HolderResult;
    birdeye:   BirdeyeEnrichment;
    walletIntel: WalletIntelligence;
    combined:  {
        safe:           boolean;
        riskScore:      number;
        marketRiskScore: number;
        reputationScore: number;
        finalScore:     number;
        verdict:        string;
        summary:        string;
    };
}

// ── Server Setup ─────────────────────────────────────────────────────────────

const RPC_URL   = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT      = parseInt(process.env.PORT || '3400', 10);
const HOST      = process.env.HOST || '0.0.0.0';
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

// Solana connection with finalized commitment for safety-critical reads
const connection = new Connection(RPC_URL, 'finalized');

// Result caches
const safetyCache   = new ResultCache<SafetyResult>(CACHE_TTL);
const honeypotCache = new ResultCache<HoneypotResult>(CACHE_TTL);
const holderCache   = new ResultCache<HolderResult>(CACHE_TTL);
const fullCache     = new ResultCache<FullCheckResult>(CACHE_TTL);
const scanCache     = new ResultCache<FullScanResult>(CACHE_TTL);

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY  = extractHeliusApiKey(RPC_URL);

// Solana address validation (base58, 32-44 chars)
const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidMint(mint: unknown): mint is string {
    return typeof mint === 'string' && MINT_REGEX.test(mint);
}

// ── Express App ──────────────────────────────────────────────────────────────

export function createApp(): express.Express {
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    // Health check (no auth)
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            service: 'sicarius-guard',
            version: '1.0.0',
            uptime: process.uptime(),
            cacheSize: {
                safety: safetyCache.size(),
                honeypot: honeypotCache.size(),
                holders: holderCache.size(),
                full: fullCache.size(),
            },
        });
    });

    // Payment stats endpoint (no auth)
    app.get('/x402/stats', (_req, res) => {
        res.json({
            protocol: 'x402',
            ...getPaymentStats(),
            pricing: getPricing(),
        });
    });

    // All /v1/* endpoints: try API key auth first, then x402 payment
    app.use('/v1', authMiddleware);
    app.use('/v1', x402PaymentMiddleware);

    // Pricing endpoint (no auth required)
    app.get('/v1/pricing', (_req, res) => {
        res.json({
            protocol: 'x402',
            network: 'solana',
            currency: 'SOL',
            pricing: getPricing(),
            instructions: 'Send SOL to the recipient address, then include the tx signature in the X-PAYMENT header. Or use a free API key via x-api-key header.',
        });
    });

    // ── POST /v1/check — Full analysis ───────────────────────────────────────
    app.post('/v1/check', async (req, res) => {
        try {
            const { mint, txSignature, isPumpSwap } = req.body as {
                mint?: unknown;
                txSignature?: string;
                isPumpSwap?: boolean;
            };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address', message: 'Provide a valid Solana mint address' });
                return;
            }

            // Check cache
            const cached = fullCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            // Fetch tx if signature provided
            let txInfo: unknown = undefined;
            if (txSignature) {
                try {
                    txInfo = await connection.getParsedTransaction(txSignature, {
                        maxSupportedTransactionVersion: 0,
                    });
                } catch { /* best-effort */ }
            }

            // Run all checks in parallel
            const [safety, honeypot, holders] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
            ]);

            // Combine scores
            let combinedScore = safety.riskScore;
            if (honeypot.isHoneypot) combinedScore = Math.min(combinedScore + 30, 100);
            if (holders.concentrated) combinedScore = Math.min(combinedScore + 15, 100);

            const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated;
            const verdict = combinedScore === 0 ? 'SAFE'
                : combinedScore <= 15 ? 'CAUTION'
                : combinedScore <= 50 ? 'HIGH_RISK'
                : 'CRITICAL';

            const summaryParts: string[] = [];
            if (!safety.safe) summaryParts.push(safety.reason);
            if (honeypot.isHoneypot) summaryParts.push('Honeypot detected');
            if (holders.concentrated) summaryParts.push(holders.reason);

            const result: FullCheckResult = {
                safety,
                honeypot,
                holders,
                combined: {
                    safe: combinedSafe,
                    riskScore: combinedScore,
                    verdict,
                    summary: combinedSafe ? 'All checks passed' : summaryParts.join('; '),
                },
            };

            fullCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[API] /v1/check error:', msg);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── GET /v1/check/:mint — Convenience GET ────────────────────────────────
    app.get('/v1/check/:mint', async (req, res) => {
        const { mint } = req.params;

        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }

        // Check cache
        const cached = fullCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }

        const [safety, honeypot, holders] = await Promise.all([
            analyzeTokenSafety(connection, mint),
            checkHoneypot(mint),
            analyzeHolders(connection, mint),
        ]);

        let combinedScore = safety.riskScore;
        if (honeypot.isHoneypot) combinedScore = Math.min(combinedScore + 30, 100);
        if (holders.concentrated) combinedScore = Math.min(combinedScore + 15, 100);

        const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated;
        const verdict = combinedScore === 0 ? 'SAFE'
            : combinedScore <= 15 ? 'CAUTION'
            : combinedScore <= 50 ? 'HIGH_RISK'
            : 'CRITICAL';

        const result: FullCheckResult = {
            safety,
            honeypot,
            holders,
            combined: {
                safe: combinedSafe,
                riskScore: combinedScore,
                verdict,
                summary: combinedSafe ? 'All checks passed' : [
                    !safety.safe ? safety.reason : '',
                    honeypot.isHoneypot ? 'Honeypot detected' : '',
                    holders.concentrated ? holders.reason : '',
                ].filter(Boolean).join('; '),
            },
        };

        fullCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    // ── POST /v1/honeypot — Honeypot-only check ──────────────────────────────
    app.post('/v1/honeypot', async (req, res) => {
        try {
            const { mint, amount } = req.body as { mint?: unknown; amount?: string };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            const cached = honeypotCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            const result = await checkHoneypot(mint, amount);
            honeypotCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── POST /v1/holders — Holder concentration check ────────────────────────
    app.post('/v1/holders', async (req, res) => {
        try {
            const { mint } = req.body as { mint?: unknown };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            const cached = holderCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            const result = await analyzeHolders(connection, mint);
            holderCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── POST /v1/scan — Full analysis + Birdeye enrichment ────────────────────
    app.post('/v1/scan', async (req, res) => {
        try {
            const { mint, txSignature, isPumpSwap } = req.body as {
                mint?: unknown;
                txSignature?: string;
                isPumpSwap?: boolean;
            };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            // Check cache
            const cached = scanCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            // Fetch tx if provided
            let txInfo: unknown = undefined;
            if (txSignature) {
                try {
                    txInfo = await connection.getParsedTransaction(txSignature, {
                        maxSupportedTransactionVersion: 0,
                    });
                } catch { /* best-effort */ }
            }

            // Run ALL checks in parallel — on-chain + Birdeye + Helius Wallet Intel
            const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
                enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                enrichCreatorReputation(mint, HELIUS_API_KEY),  // Look up mint in Orb identity DB
            ]);

            // Combine on-chain score
            let onChainScore = safety.riskScore;
            if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
            if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

            // Reputation score from Helius wallet intelligence
            const reputationScore = walletIntel.reputation?.riskScore ?? 0;

            // Weighted final score: 60% on-chain, 25% market data, 15% reputation
            const marketScore = birdeye.marketRisk.score;
            const finalScore = Math.round(
                onChainScore * 0.60 +
                marketScore * 0.25 +
                reputationScore * 0.15
            );

            const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated
                && marketScore < 30 && reputationScore < 30;

            const verdict = finalScore === 0 ? 'SAFE'
                : finalScore <= 15 ? 'CAUTION'
                : finalScore <= 50 ? 'HIGH_RISK'
                : 'CRITICAL';

            const summaryParts: string[] = [];
            if (!safety.safe) summaryParts.push(safety.reason);
            if (honeypot.isHoneypot) summaryParts.push('Honeypot detected');
            if (holders.concentrated) summaryParts.push(holders.reason);
            if (birdeye.marketRisk.flags.length > 0) {
                summaryParts.push(`Market flags: ${birdeye.marketRisk.flags.join(', ')}`);
            }
            if (walletIntel.reputation && walletIntel.reputation.flags.length > 0) {
                summaryParts.push(`Reputation: ${walletIntel.reputation.flags.join(', ')}`);
            }

            const result: FullScanResult = {
                safety,
                honeypot,
                holders,
                birdeye,
                walletIntel,
                combined: {
                    safe: combinedSafe,
                    riskScore: onChainScore,
                    marketRiskScore: marketScore,
                    reputationScore,
                    finalScore,
                    verdict,
                    summary: combinedSafe ? 'All checks passed — token appears safe' : summaryParts.join('; '),
                },
            };

            scanCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[API] /v1/scan error:', msg);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── GET /v1/scan/:mint — Convenience GET for scan ────────────────────────
    app.get('/v1/scan/:mint', async (req, res) => {
        const { mint } = req.params;

        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }

        const cached = scanCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }

        const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
            analyzeTokenSafety(connection, mint),
            checkHoneypot(mint),
            analyzeHolders(connection, mint),
            enrichWithBirdeye(mint, BIRDEYE_API_KEY),
            enrichCreatorReputation(mint, HELIUS_API_KEY),
        ]);

        let onChainScore = safety.riskScore;
        if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
        if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

        const reputationScore = walletIntel.reputation?.riskScore ?? 0;
        const marketScore = birdeye.marketRisk.score;
        const finalScore = Math.round(
            onChainScore * 0.60 +
            marketScore * 0.25 +
            reputationScore * 0.15
        );
        const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated
            && marketScore < 30 && reputationScore < 30;

        const verdict = finalScore === 0 ? 'SAFE'
            : finalScore <= 15 ? 'CAUTION'
            : finalScore <= 50 ? 'HIGH_RISK'
            : 'CRITICAL';

        const result: FullScanResult = {
            safety,
            honeypot,
            holders,
            birdeye,
            walletIntel,
            combined: {
                safe: combinedSafe,
                riskScore: onChainScore,
                marketRiskScore: marketScore,
                reputationScore,
                finalScore,
                verdict,
                summary: combinedSafe ? 'All checks passed — token appears safe' : [
                    !safety.safe ? safety.reason : '',
                    honeypot.isHoneypot ? 'Honeypot detected' : '',
                    holders.concentrated ? holders.reason : '',
                    birdeye.marketRisk.flags.length > 0 ? `Market: ${birdeye.marketRisk.flags.join(', ')}` : '',
                    walletIntel.reputation?.flags.length ? `Reputation: ${walletIntel.reputation.flags.join(', ')}` : '',
                ].filter(Boolean).join('; '),
            },
        };

        scanCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    return app;
}

// ── Start Server ─────────────────────────────────────────────────────────────

export function startServer(): void {
    const app = createApp();

    // Periodic cleanup of rate limit entries + payment cache
    setInterval(cleanupRateLimits, 60_000);
    setInterval(cleanupPaymentCache, 120_000);

    app.listen(PORT, HOST, () => {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🛡️  SicariusGuard — Token Safety API                   ║
║                                                          ║
║   Server:    http://${HOST}:${PORT}                       ║
║   Health:    http://${HOST}:${PORT}/health                ║
║   Pricing:   http://${HOST}:${PORT}/v1/pricing           ║
║   x402:      http://${HOST}:${PORT}/x402/stats           ║
║   Docs:      POST /v1/check  { "mint": "..." }           ║
║   Payment:   x402 SOL → ${process.env.TREASURY_WALLET?.slice(0, 20) ?? 'not set'}...   ║
║   RPC:       ${RPC_URL.slice(0, 45)}...                  ║
║   Cache TTL: ${CACHE_TTL}s                               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
        `.trim());
    });
}

