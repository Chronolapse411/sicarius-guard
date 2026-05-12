/**
 * SicariusGuard — MCP Server
 *
 * Exposes token safety analysis as MCP tools for AI agents.
 * Supports stdio transport (local) and SSE transport (remote).
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

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY  = extractHeliusApiKey(RPC_URL);

export function createMCPServer(): McpServer {
    const connection = new Connection(RPC_URL, 'finalized');

    const server = new McpServer({
        name: 'sicarius-guard',
        version: '1.0.0',
    });

    // ── Tool: check_token_safety ─────────────────────────────────────────
    server.tool(
        'check_token_safety',
        `Analyze a Solana SPL token for rug pull, honeypot, and safety risks. Call this BEFORE executing any swap or buy transaction. Performs 5 checks: mint authority, freeze authority, Token-2022 extensions, honeypot simulation, and holder concentration. Returns a JSON object with a combined risk score (0-100) and verdict (SAFE | CAUTION | HIGH_RISK | CRITICAL). This is a read-only operation with no on-chain side effects. Rate limited to 100 free calls/day per IP. Use this instead of check_honeypot or check_holder_concentration when you need a comprehensive pre-trade safety check. Use full_token_scan instead when you also need Birdeye market data and wallet reputation.`,
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

                const [safety, honeypot, holders] = await Promise.all([
                    analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
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

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            safe: combinedSafe,
                            riskScore: combinedScore,
                            verdict,
                            safety,
                            honeypot,
                            holders: {
                                concentrated: holders.concentrated,
                                reason: holders.reason,
                                stats: holders.stats,
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
        `Check if a Solana token is a honeypot by simulating a sell order through Jupiter DEX. Zero cost — only requests a quote, no actual transaction is executed. Returns a JSON object with isHoneypot (boolean) and sellability details. This is a read-only operation with no on-chain side effects or gas costs. Use this when you only need to verify sellability; use check_token_safety for a broader 5-layer analysis, or full_token_scan for the most comprehensive 7-layer scan including market data.`,
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
        `Analyze token holder distribution to detect supply concentration (a key rug pull indicator). Returns a JSON object with concentrated (boolean), reason, and stats showing percentage held by top 1/5/10 wallets. Flags risk if top 1 holder >50%, top 5 >80%, or top 10 >90%. This is a read-only RPC call with no on-chain side effects. Use this when you specifically need holder distribution data; use check_token_safety for a broader safety analysis that includes this check among 4 others.`,
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

    // ── Tool: full_token_scan ─────────────────────────────────────────────
    server.tool(
        'full_token_scan',
        `Most comprehensive 7-layer safety analysis: combines on-chain byte-level inspection (mint auth, freeze, Token-2022, honeypot, holders) with Birdeye market intelligence (liquidity, volume, wash trading) and Helius wallet reputation data. Returns a JSON object with onChainRiskScore, marketRiskScore, reputationScore, weighted finalScore (0-100), verdict (SAFE | CAUTION | HIGH_RISK | CRITICAL), and detailed breakdown. This is a read-only operation with no on-chain side effects. Use this for high-value trades where you need maximum confidence; use check_token_safety for a faster 5-layer check without market data. Rate limited to 100 free calls/day per IP.`,
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

                const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
                    analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
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

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            safe: combinedSafe,
                            onChainRiskScore: onChainScore,
                            marketRiskScore: marketScore,
                            reputationScore,
                            finalScore,
                            verdict,
                            safety,
                            honeypot,
                            holders: {
                                concentrated: holders.concentrated,
                                reason: holders.reason,
                                stats: holders.stats,
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
        `Scan multiple Solana tokens in a single call for portfolio-level risk assessment. Runs the full 7-layer analysis (same as full_token_scan) on each mint in parallel. Returns a JSON object with scanned count and a results array, each containing mint, safe (boolean), finalScore (0-100), verdict, honeypot status, liquidity, marketFlags, and walletAge. Max 10 tokens per batch. This is a read-only operation with no on-chain side effects. Use this when evaluating a portfolio, watchlist, or multiple tokens from a pool discovery. Do not use this for a single token — use full_token_scan or check_token_safety instead, as they return more detailed results.`,
        {
            mints: z.array(z.string()).max(10).describe('Array of Solana token mint addresses to scan (max 10)'),
        },
        async ({ mints }) => {
            try {
                const results = await Promise.allSettled(
                    mints.map(async (mint) => {
                        const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
                            analyzeTokenSafety(connection, mint, undefined, false),
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
                            onChainScore * 0.60 + marketScore * 0.25 + reputationScore * 0.15
                        );
                        const verdict = finalScore === 0 ? 'SAFE'
                            : finalScore <= 15 ? 'CAUTION'
                            : finalScore <= 50 ? 'HIGH_RISK'
                            : 'CRITICAL';

                        return {
                            mint,
                            safe: safety.safe && !honeypot.isHoneypot && !holders.concentrated && marketScore < 30,
                            finalScore,
                            verdict,
                            honeypot: honeypot.isHoneypot,
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
