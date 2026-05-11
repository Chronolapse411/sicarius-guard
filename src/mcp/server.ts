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

const RPC_URL = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';

export function createMCPServer(): McpServer {
    const connection = new Connection(RPC_URL, 'finalized');

    const server = new McpServer({
        name: 'sicarius-guard',
        version: '1.0.0',
    });

    // ── Tool: check_token_safety ─────────────────────────────────────────
    server.tool(
        'check_token_safety',
        `Analyze a Solana SPL token for rug pull, honeypot, and safety risks. Call this BEFORE executing any swap or buy transaction. Performs 5 checks: mint authority, freeze authority, Token-2022 extensions, honeypot simulation, and holder concentration. Returns a combined risk score (0-100) and verdict.`,
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
        `Check if a Solana token is a honeypot by simulating a sell order through Jupiter. Zero cost — only requests a quote. Returns whether the token is sellable.`,
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
        `Analyze the distribution of token holders. Detects if supply is concentrated in a few wallets (rug pull indicator). Flags if top 1 holder >50%, top 5 >80%, or top 10 >90%.`,
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
        `Most comprehensive safety analysis: on-chain byte-level inspection + Birdeye market intelligence. Use for high-value trades. Returns dual risk score (on-chain + market) with weighted final verdict.`,
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

                const [safety, honeypot, holders, birdeye] = await Promise.all([
                    analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                    checkHoneypot(mint),
                    analyzeHolders(connection, mint),
                    enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                ]);

                let onChainScore = safety.riskScore;
                if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
                if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

                const marketScore = birdeye.marketRisk.score;
                const finalScore = Math.round(onChainScore * 0.7 + marketScore * 0.3);
                const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated && marketScore < 30;

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
