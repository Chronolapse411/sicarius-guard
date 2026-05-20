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

    recon_deployer: {
        name: 'recon_deployer',
        description: `Perform a deep background investigation on a Solana wallet that deployed or controls a token. Returns a complete dossier including their token creation history, portfolio health, wallet age, funding genesis, and a Recidivism Score (0-100).

Use this BEFORE trusting any new token — if the deployer has a history of abandoned or rugged tokens, the current token is likely another scam.

Analysis pipeline:
1. Portfolio enumeration — finds all fungible tokens the deployer controls or has created
2. Health triage — classifies each token as alive, abandoned, or rugged
3. Wallet genesis — identifies who funded the deployer and when
4. Recidivism scoring — algorithmic risk assessment based on dead token ratio, deployment frequency, wallet age, and authority patterns

Verdicts: CLEAN | SUSPICIOUS | SERIAL_DEPLOYER | LIKELY_SCAMMER

This is a zero-cost check using DAS API and Enhanced Transactions (Helius Developer plan).`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                address: {
                    type: 'string',
                    description: 'Solana wallet address of the token deployer to investigate',
                },
            },
            required: ['address'],
        },
    },

    check_nft: {
        name: 'check_nft',
        description: `Perform a safety analysis on a Solana NFT using on-chain DAS metadata and Magic Eden marketplace data. Detects counterfeit collections, unverified creators, wash-traded NFTs, burnt/frozen assets, excessive royalties, and pricing anomalies.

Analyzes 7 risk signals:
1. Collection verification — is the collection group verified on-chain?
2. Creator verification — are the NFT creators verified?
3. Metadata mutability — can the creator change the NFT's image/name after sale?
4. Marketplace presence — is the NFT listed on Magic Eden? At what price?
5. Collection health — floor price, volume, listing count
6. Asset status — compressed, burnt, frozen
7. Pricing anomalies — listed far above/below floor price

Returns a JSON object with riskScore (0-100), verdict (SAFE/CAUTION/HIGH_RISK/CRITICAL), collection data, floor price, and per-signal flags. This is a read-only operation with no on-chain side effects. Use this for NFT safety checks; use check_token_safety for fungible SPL tokens instead.`,
        inputSchema: {
            type: 'object' as const,
            properties: {
                mint: {
                    type: 'string',
                    description: 'Solana NFT mint address to analyze (base58)',
                },
            },
            required: ['mint'],
        },
    },
} as const;
