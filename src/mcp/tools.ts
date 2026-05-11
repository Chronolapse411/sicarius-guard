/**
 * SicariusGuard — MCP Tool Definitions
 *
 * Defines the tools exposed to AI agents via the Model Context Protocol.
 * Each tool has a name, description, and JSON Schema parameters that
 * tell the LLM what the tool does and when to call it.
 *
 * @author Chronolapse411
 */

export const TOOLS = {
    check_token_safety: {
        name: 'check_token_safety',
        description: `Analyze a Solana SPL token for rug pull, honeypot, and safety risks. Call this BEFORE executing any swap or buy transaction to protect against scams.

Performs 5 checks:
1. Mint authority — can the deployer print infinite tokens?
2. Freeze authority — can the deployer freeze your wallet?
3. Token-2022 extensions — PermanentDelegate, TransferHook, ConfidentialTransfers traps
4. Honeypot simulation — can you actually sell this token back to SOL?
5. Holder concentration — is supply concentrated in a few wallets?

Returns a combined risk score (0-100), verdict (SAFE/CAUTION/HIGH_RISK/CRITICAL), and per-check details.`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                mint: {
                    type: 'string',
                    description: 'Solana token mint address to check (base58 encoded)',
                },
                txSignature: {
                    type: 'string',
                    description: 'Optional: transaction signature of the pool creation or graduation tx for deeper supply analysis',
                },
                isPumpSwap: {
                    type: 'boolean',
                    description: 'Optional: set to true if the token graduated from Pump.fun via PumpSwap (enables tx-based mint authority verification)',
                },
            },
            required: ['mint'],
        },
    },

    check_honeypot: {
        name: 'check_honeypot',
        description: `Check if a Solana token is a honeypot by simulating a sell order through Jupiter. If Jupiter cannot find a route to sell the token back to SOL, it is likely a honeypot — meaning you can buy but cannot sell.

This is a quick, zero-cost check (quote only, no swap executed). Use this for a fast preliminary filter before doing a full safety analysis.`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                mint: {
                    type: 'string',
                    description: 'Solana token mint address to check',
                },
                amount: {
                    type: 'string',
                    description: 'Optional: raw token amount to simulate selling (default: 1000000)',
                },
            },
            required: ['mint'],
        },
    },

    check_holder_concentration: {
        name: 'check_holder_concentration',
        description: `Analyze the distribution of token holders for a Solana SPL token. Detects if supply is dangerously concentrated in a few wallets, which is a common rug pull setup.

Flags as concentrated if:
- Top 1 holder owns >50% of supply
- Top 5 holders own >80% of supply  
- Top 10 holders own >90% of supply

Returns the top 10 holders with their addresses, amounts, and percentage of total supply.`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                mint: {
                    type: 'string',
                    description: 'Solana token mint address to analyze',
                },
            },
            required: ['mint'],
        },
    },

    full_token_scan: {
        name: 'full_token_scan',
        description: `Perform the most comprehensive safety analysis available on a Solana token by combining on-chain byte-level inspection with Birdeye market intelligence.

This is the premium check — use it for high-value trades or when you need maximum confidence.

Includes everything from check_token_safety PLUS:
- Birdeye token overview (price, volume, liquidity, market cap)
- Birdeye security flags (holder distribution, mutable metadata)
- Birdeye trade data (wash trading detection, bot activity)
- Market risk scoring with weighted final verdict

Returns a dual risk score:
- On-chain risk score (0-100)
- Market risk score (0-100)
- Weighted final score (70% on-chain, 30% market)`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                mint: {
                    type: 'string',
                    description: 'Solana token mint address to scan',
                },
                txSignature: {
                    type: 'string',
                    description: 'Optional: transaction signature for deeper analysis',
                },
                isPumpSwap: {
                    type: 'boolean',
                    description: 'Optional: set true for Pump.fun graduated tokens',
                },
            },
            required: ['mint'],
        },
    },
} as const;
