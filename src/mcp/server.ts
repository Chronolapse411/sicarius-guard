/**
 * SicariusGuard — MCP Server
 *
 * Exposes token safety analysis as MCP tools for AI agents.
 * Supports stdio transport (local) and SSE transport (remote).
 *
 * v1.1.0: 10-layer analysis engine — adds LP lock detection,
 * token age analysis, and unified composite scoring.
 *
 * Usage:
 *   npx sicarius-guard          — starts stdio MCP server
 *   node dist/mcp-server.js     — same
 *
 * Claude Desktop config (claude_desktop_config.json):
 * {
 *   "mcpServers": {
 *     "sicarius-guard": {
 *       "command": "node",
 *       "args": ["D:/PERSONAL/Projects/SicariusGuard/dist/mcp-server.js"],
 *       "env": {
 *         "HELIUS_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
 *       }
 *     }
 *   }
 * }
 *
 * @author Chronolapse411
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Connection } from '@solana/web3.js';
import { z } from 'zod';
import { analyzeTokenSafety } from '../core/token_safety.js';
import { checkHoneypot } from '../core/honeypot_sim.js';
import { analyzeHolders } from '../core/holder_analysis.js';
import { enrichWithBirdeye } from '../core/birdeye.js';
import { enrichCreatorReputation, extractHeliusApiKey } from '../core/helius_wallet.js';
import { analyzeLpLock } from '../core/lp_lock.js';
import { analyzeTokenAge } from '../core/token_age.js';
import {
    computeCompositeScore,
    buildLightweightLayers,
    buildFullLayers,
    buildSummary,
    LIGHTWEIGHT_WEIGHTS,
    DEFAULT_WEIGHTS,
} from '../core/scoring.js';

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY  = extractHeliusApiKey(RPC_URL);

export function createMCPServer(): McpServer {
    const connection = new Connection(RPC_URL, 'finalized');

    const server = new McpServer({
        name: 'sicarius-guard',
        version: '1.1.0',
    });

    // ── Tool: check_token_safety ─────────────────────────────────────────
    server.tool(
        'check_token_safety',
        `Analyze a Solana SPL token for rug pull, honeypot, and safety risks. Call this BEFORE executing any swap or buy transaction. Performs 8 checks: mint authority, freeze authority, Token-2022 extensions, honeypot simulation, holder concentration, LP lock status, and token age. Returns a JSON object with a combined risk score (0-100) and verdict (SAFE | CAUTION | HIGH_RISK | CRITICAL). This is a read-only operation with no on-chain side effects. Rate limited to 100 free calls/day per IP. Use this instead of check_honeypot or check_holder_concentration when you need a comprehensive pre-trade safety check. Use full_token_scan instead when you also need Birdeye market data and wallet reputation.`,
        {
            mint: z.string().describe('Solana token mint address to check (base58)'),
            txSignature: z.string().optional().describe('Optional: tx signature of pool creation for deeper analysis'),
            isPumpSwap: z.boolean().optional().describe('Set true for Pump.fun/PumpSwap graduated tokens'),
        },
        async ({ mint, txSignature, isPumpSwap }) => {
            try {
                let txInfo: unknown = undefined;
                if (txSignature) {
                    try {
                        txInfo = await connection.getParsedTransaction(txSignature, {
                            maxSupportedTransactionVersion: 0,
                        });
                    } catch { /* best-effort */ }
                }

                const [safety, honeypot, holders, lpLock, tokenAge] = await Promise.all([
                    analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                    checkHoneypot(mint),
                    analyzeHolders(connection, mint),
                    analyzeLpLock(connection, mint),
                    analyzeTokenAge(connection, mint),
                ]);

                // Build on-chain sub-score from safety + honeypot + holders
                let onChainScore = safety.riskScore;
                if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
                if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

                const layers = buildLightweightLayers(
                    onChainScore,
                    lpLock.riskScore,
                    tokenAge.riskScore,
                );
                const composite = computeCompositeScore(layers, LIGHTWEIGHT_WEIGHTS);
                const summary = buildSummary(composite, {
                    safetyReason: !safety.safe ? safety.reason : undefined,
                    honeypotDetected: honeypot.isHoneypot,
                    holderReason: holders.concentrated ? holders.reason : undefined,
                    lpFlags: lpLock.flags,
                    ageFlags: tokenAge.flags,
                });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            safe: composite.safe,
                            riskScore: composite.finalScore,
                            verdict: composite.verdict,
                            summary,
                            breakdown: composite.breakdown,
                            safety,
                            honeypot,
                            holders: {
                                concentrated: holders.concentrated,
                                reason: holders.reason,
                                stats: holders.stats,
                            },
                            lpLock: {
                                isLocked: lpLock.isLocked,
                                lockType: lpLock.lockType,
                                burnPct: lpLock.burnPct,
                                flags: lpLock.flags,
                            },
                            tokenAge: {
                                ageCategory: tokenAge.ageCategory,
                                ageDays: tokenAge.ageDays,
                                ageHuman: tokenAge.ageHuman,
                                flags: tokenAge.flags,
                            },
                        }, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: check_honeypot ─────────────────────────────────────────────
    server.tool(
        'check_honeypot',
        `Check if a Solana token is a honeypot by simulating a sell order through Jupiter DEX. Zero cost — only requests a quote, no actual transaction is executed. Returns a JSON object with isHoneypot (boolean) and sellability details. This is a read-only operation with no on-chain side effects or gas costs. Use this when you only need to verify sellability; use check_token_safety for a broader 8-layer analysis, or full_token_scan for the most comprehensive 10-layer scan including market data.`,
        {
            mint: z.string().describe('Solana token mint address'),
            amount: z.string().optional().describe('Raw token amount to simulate selling (default: 1000000)'),
        },
        async ({ mint, amount }) => {
            try {
                const result = await checkHoneypot(mint, amount);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: check_holder_concentration ──────────────────────────────────
    server.tool(
        'check_holder_concentration',
        `Analyze token holder distribution to detect supply concentration (a key rug pull indicator). Returns a JSON object with concentrated (boolean), reason, and stats showing percentage held by top 1/5/10 wallets. Flags risk if top 1 holder >50%, top 5 >80%, or top 10 >90%. This is a read-only RPC call with no on-chain side effects. Use this when you specifically need holder distribution data; use check_token_safety for a broader safety analysis that includes this check among others.`,
        {
            mint: z.string().describe('Solana token mint address'),
        },
        async ({ mint }) => {
            try {
                const result = await analyzeHolders(connection, mint);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: check_lp_lock ──────────────────────────────────────────────
    server.tool(
        'check_lp_lock',
        `Check whether a Solana token's liquidity pool has its LP tokens burned or locked. Discovers the primary pool via GeckoTerminal/Raydium, decodes the Raydium V4 pool state, computes LP burn percentage, and checks holders against known burn addresses and locker programs (Streamflow, UNCX). Returns pool address, LP mint, burn percentage, lock type, and risk score. This is a read-only operation with no on-chain side effects. Use this for LP-specific analysis; use full_token_scan for comprehensive analysis.`,
        {
            mint: z.string().describe('Solana token mint address'),
        },
        async ({ mint }) => {
            try {
                const result = await analyzeLpLock(connection, mint);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: check_token_age ────────────────────────────────────────────
    server.tool(
        'check_token_age',
        `Determine when a Solana token was created by finding its first-ever on-chain transaction. Returns creation timestamp, age in days, age category (newborn/young/adolescent/mature), and risk score. Newer tokens carry higher risk as they haven't been market-tested. This is a read-only RPC operation. Use this for age-specific analysis; use full_token_scan for comprehensive analysis.`,
        {
            mint: z.string().describe('Solana token mint address'),
        },
        async ({ mint }) => {
            try {
                const result = await analyzeTokenAge(connection, mint);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: full_token_scan ─────────────────────────────────────────────
    server.tool(
        'full_token_scan',
        `Most comprehensive 10-layer safety analysis: combines on-chain byte-level inspection (mint auth, freeze, Token-2022, honeypot, holders), LP lock detection (burn %, locker status), token age analysis, Birdeye market intelligence (liquidity, volume, wash trading), and Helius wallet reputation data. Returns a JSON object with layered breakdown, weighted finalScore (0-100), verdict (SAFE | CAUTION | HIGH_RISK | CRITICAL), and detailed per-layer data. This is a read-only operation with no on-chain side effects. Use this for high-value trades where you need maximum confidence; use check_token_safety for a faster check without market data. Rate limited to 100 free calls/day per IP.`,
        {
            mint: z.string().describe('Solana token mint address'),
            txSignature: z.string().optional().describe('Optional: tx signature for deeper analysis'),
            isPumpSwap: z.boolean().optional().describe('Set true for PumpSwap graduated tokens'),
        },
        async ({ mint, txSignature, isPumpSwap }) => {
            try {
                let txInfo: unknown = undefined;
                if (txSignature) {
                    try {
                        txInfo = await connection.getParsedTransaction(txSignature, {
                            maxSupportedTransactionVersion: 0,
                        });
                    } catch { /* best-effort */ }
                }

                const [safety, honeypot, holders, birdeye, walletIntel, lpLock, tokenAge] = await Promise.all([
                    analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                    checkHoneypot(mint),
                    analyzeHolders(connection, mint),
                    enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                    enrichCreatorReputation(mint, HELIUS_API_KEY),
                    analyzeLpLock(connection, mint),
                    analyzeTokenAge(connection, mint),
                ]);

                // Build on-chain sub-score
                let onChainScore = safety.riskScore;
                if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
                if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

                const reputationScore = walletIntel.reputation?.riskScore ?? 0;
                const layers = buildFullLayers(
                    onChainScore,
                    lpLock.riskScore,
                    tokenAge.riskScore,
                    birdeye.marketRisk.score,
                    reputationScore,
                );
                const composite = computeCompositeScore(layers, DEFAULT_WEIGHTS);
                const summary = buildSummary(composite, {
                    safetyReason: !safety.safe ? safety.reason : undefined,
                    honeypotDetected: honeypot.isHoneypot,
                    holderReason: holders.concentrated ? holders.reason : undefined,
                    lpFlags: lpLock.flags,
                    ageFlags: tokenAge.flags,
                    marketFlags: birdeye.marketRisk.flags,
                    reputationFlags: walletIntel.reputation?.flags,
                });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            safe: composite.safe,
                            finalScore: composite.finalScore,
                            verdict: composite.verdict,
                            summary,
                            breakdown: composite.breakdown,
                            layerCount: composite.layerCount,
                            safety,
                            honeypot,
                            holders: {
                                concentrated: holders.concentrated,
                                reason: holders.reason,
                                stats: holders.stats,
                            },
                            lpLock: {
                                poolFound: lpLock.poolFound,
                                poolAddress: lpLock.poolAddress,
                                isLocked: lpLock.isLocked,
                                lockType: lpLock.lockType,
                                burnPct: lpLock.burnPct,
                                lockerName: lpLock.lockerName,
                                flags: lpLock.flags,
                            },
                            tokenAge: {
                                createdAt: tokenAge.createdAt,
                                ageCategory: tokenAge.ageCategory,
                                ageDays: tokenAge.ageDays,
                                ageHuman: tokenAge.ageHuman,
                                flags: tokenAge.flags,
                            },
                            birdeye: {
                                overview: birdeye.overview ? {
                                    price: birdeye.overview.price,
                                    volume24h: birdeye.overview.volume24h,
                                    liquidity: birdeye.overview.liquidity,
                                    marketCap: birdeye.overview.marketCap,
                                    holders: birdeye.overview.holder,
                                } : null,
                                marketFlags: birdeye.marketRisk.flags,
                            },
                            walletIntel: {
                                creatorAddress: walletIntel.creatorAddress,
                                reputation: walletIntel.reputation ? {
                                    verdict: walletIntel.reputation.verdict,
                                    riskScore: walletIntel.reputation.riskScore,
                                    flags: walletIntel.reputation.flags,
                                    creatorAge: walletIntel.reputation.creatorAge,
                                    identity: walletIntel.reputation.identity,
                                } : null,
                            },
                        }, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: get_wallet_reputation ────────────────────────────────────────
    server.tool(
        'get_wallet_reputation',
        `Analyze a Solana wallet's reputation using Helius DAS identity data and funding chain analysis. Checks deployer/wallet age, funding source identity, and known entity classification. Returns a JSON object with creatorAddress, reputation verdict, riskScore, flags, creatorAge, and identity data. This is a read-only operation — queries Helius API with no on-chain side effects. Use this to evaluate whether a token deployer or counterparty wallet is trustworthy before transacting. Do not use this for token analysis — use check_token_safety or full_token_scan for that. Requires a Helius API key for full results.`,
        {
            address: z.string().describe('Solana wallet address to investigate (base58)'),
        },
        async ({ address }) => {
            try {
                const result = await enrichCreatorReputation(address, HELIUS_API_KEY);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: get_market_intel ────────────────────────────────────────────
    server.tool(
        'get_market_intel',
        `Get real-time market intelligence for a Solana token from the Birdeye API. Returns a JSON object with price, 24h volume, liquidity depth, market cap, holder count, 24h price change, and market risk flags (wash trading, low liquidity, extreme volume-to-liquidity ratios). This is a read-only API call with no on-chain side effects. Use this for trade sizing, market health assessment, and liquidity analysis. Do not use this for safety/rug-pull checks — use check_token_safety or full_token_scan for that. Requires a Birdeye API key for data.`,
        {
            mint: z.string().describe('Solana token mint address'),
        },
        async ({ mint }) => {
            try {
                const result = await enrichWithBirdeye(mint, BIRDEYE_API_KEY);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            overview: result.overview ? {
                                price: result.overview.price,
                                volume24h: result.overview.volume24h,
                                liquidity: result.overview.liquidity,
                                marketCap: result.overview.marketCap,
                                holders: result.overview.holder,
                                priceChange24h: result.overview.priceChange24h,
                            } : null,
                            marketRisk: result.marketRisk,
                            tradeData: result.tradeData ?? null,
                        }, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: batch_scan ──────────────────────────────────────────────────
    server.tool(
        'batch_scan',
        `Scan multiple Solana tokens in a single call for portfolio-level risk assessment. Runs the full 10-layer analysis (same as full_token_scan) on each mint in parallel. Returns a JSON object with scanned count and a results array, each containing mint, safe (boolean), finalScore (0-100), verdict, honeypot status, LP lock status, token age, liquidity, marketFlags, and walletAge. Max 10 tokens per batch. This is a read-only operation with no on-chain side effects. Use this when evaluating a portfolio, watchlist, or multiple tokens from a pool discovery. Do not use this for a single token — use full_token_scan or check_token_safety instead, as they return more detailed results.`,
        {
            mints: z.array(z.string()).max(10).describe('Array of Solana token mint addresses to scan (max 10)'),
        },
        async ({ mints }) => {
            try {
                const results = await Promise.allSettled(
                    mints.map(async (mint) => {
                        const [safety, honeypot, holders, birdeye, walletIntel, lpLock, tokenAge] = await Promise.all([
                            analyzeTokenSafety(connection, mint, undefined, false),
                            checkHoneypot(mint),
                            analyzeHolders(connection, mint),
                            enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                            enrichCreatorReputation(mint, HELIUS_API_KEY),
                            analyzeLpLock(connection, mint),
                            analyzeTokenAge(connection, mint),
                        ]);

                        let onChainScore = safety.riskScore;
                        if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
                        if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

                        const reputationScore = walletIntel.reputation?.riskScore ?? 0;
                        const layers = buildFullLayers(
                            onChainScore,
                            lpLock.riskScore,
                            tokenAge.riskScore,
                            birdeye.marketRisk.score,
                            reputationScore,
                        );
                        const composite = computeCompositeScore(layers, DEFAULT_WEIGHTS);

                        return {
                            mint,
                            safe: composite.safe,
                            finalScore: composite.finalScore,
                            verdict: composite.verdict,
                            honeypot: honeypot.isHoneypot,
                            lpLocked: lpLock.isLocked,
                            lpBurnPct: lpLock.burnPct,
                            tokenAgeDays: tokenAge.ageDays,
                            ageCategory: tokenAge.ageCategory,
                            liquidity: birdeye.overview?.liquidity ?? null,
                            marketFlags: birdeye.marketRisk.flags,
                            walletAge: walletIntel.reputation?.creatorAge ?? null,
                        };
                    })
                );

                const output = results.map((r, i) => {
                    if (r.status === 'fulfilled') return r.value;
                    return { mint: mints[i], error: r.reason?.message ?? String(r.reason) };
                });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ scanned: output.length, results: output }, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: recon_deployer ──────────────────────────────────────────────
    server.tool(
        'recon_deployer',
        `Perform a deep background investigation on a Solana wallet to determine if they are a serial rugger. Analyzes their entire token deployment history algorithmically — no hardcoded blacklists. Returns a JSON dossier with: totalTokensLaunched, portfolio health breakdown (alive/abandoned/rugged), deadTokenRatio, wallet creation date, funding genesis (who funded them), Recidivism Score (0-100), and verdict (CLEAN | SUSPICIOUS | SERIAL_DEPLOYER | LIKELY_SCAMMER). Use this to evaluate a deployer before trusting their token. This is a read-only operation using DAS API and Enhanced Transactions — zero extra cost on Helius Developer plan.`,
        {
            address: z.string().describe('Solana wallet address of the token deployer to investigate'),
        },
        async ({ address }) => {
            try {
                const { reconDeployer } = await import('../core/deployer_recon.js');
                const dossier = await reconDeployer(address);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(dossier, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    // ── Tool: check_nft ──────────────────────────────────────────────────
    server.tool(
        'check_nft',
        `Perform a safety analysis on a Solana NFT combining Helius DAS on-chain metadata with Magic Eden marketplace intelligence. Returns riskScore (0-100), verdict (SAFE | CAUTION | HIGH_RISK | CRITICAL), collection verification status, floor price, volume, creator verification, and per-signal flags. Read-only — no on-chain side effects. Use this for NFTs; use check_token_safety for fungible SPL tokens.`,
        {
            mint: z.string().describe('Solana NFT mint address (base58)'),
        },
        async ({ mint }) => {
            try {
                const { analyzeNft } = await import('../core/nft_intel.js');
                const result = await analyzeNft(mint);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(result, null, 2),
                    }],
                };
            } catch (e: unknown) {
                const msg = e instanceof Error ? e.message : String(e);
                return {
                    content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }],
                    isError: true,
                };
            }
        },
    );

    return server;
}

/**
 * Start MCP server with stdio transport.
 */
export async function startMCPServer(): Promise<void> {
    const server = createMCPServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('[SicariusGuard MCP] Server started on stdio transport');
}
