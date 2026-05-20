# 🛡️ SicariusGuard

**Solana Token & NFT Safety Oracle for AI Agents & Trading Bots**

[![GitHub stars](https://img.shields.io/github/stars/Chronolapse411/sicarius-guard?style=social)](https://github.com/Chronolapse411/sicarius-guard)
[![npm version](https://img.shields.io/npm/v/sicarius-guard.svg)](https://www.npmjs.com/package/sicarius-guard)
[![npm downloads](https://img.shields.io/npm/dt/sicarius-guard.svg)](https://www.npmjs.com/package/sicarius-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)

[![sicarius-guard MCP server](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard/badges/card.svg)](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard)
[![Score](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard/badges/score.svg)](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard)
[![Smithery](https://smithery.ai/badge/sicarius-guard)](https://smithery.ai/server/chronolapse411/sicarius-guard)

Real-time token and NFT safety analysis combining byte-level on-chain inspection, LP lock verification, deployer reputation scoring, market intelligence, and NFT fraud detection. Built for autonomous AI agents, MCP-enabled LLMs, and trading infrastructure.

> *"Don't trade blind. Query SicariusGuard before every swap."*

### 🌐 Live API: `https://sicarius-guard-640545264957.us-east4.run.app`

```bash
# Try it now — no auth required (100 free calls/day)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/scan/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

---

## 📑 Table of Contents

- [What It Does](#-what-it-does)
- [Quick Start](#-quick-start)
- [API Endpoints](#-api-endpoints)
- [MCP Server (for AI Agents)](#-mcp-server-for-ai-agents)
- [Architecture](#%EF%B8%8F-architecture)
- [x402 Payment Protocol](#-x402-payment-protocol)
- [Configuration](#%EF%B8%8F-configuration)
- [Performance](#-performance)
- [Tech Stack](#-tech-stack)
- [Why SicariusGuard?](#%EF%B8%8F-why-sicariusguard)
- [Related MCP Servers](#-related-mcp-servers)
- [Links](#-links)

## 🔍 What It Does

SicariusGuard performs **12 layers of safety analysis** on any Solana SPL token or NFT:

### On-Chain Safety (Layers 1-5)
| Layer | Source | Detection |
|-------|--------|-----------|
| 🔓 **Mint Authority** | Raw SPL mint bytes | Can deployer print infinite tokens? |
| 🧊 **Freeze Authority** | SPL layout offset 46 | Can deployer freeze any wallet? |
| ⚠️ **Token-2022 Extensions** | Extension type scan | PermanentDelegate, TransferHook, ConfidentialTransfers |
| 🍯 **Honeypot Detection** | Jupiter sell simulation | Can you actually sell this token? |
| 📊 **Holder Concentration** | `getTokenLargestAccounts` | Top 5 wallets controlling >50% supply? |

### LP & Token Maturity (Layers 6-8)
| Layer | Source | Detection |
|-------|--------|-----------|
| 🔒 **LP Lock/Burn** | Raydium V4 byte decode + GeckoTerminal | Is liquidity locked, burned, or unlocked? |
| ⏰ **Token Age** | Helius enhanced RPC | Newborn (<24h)? Young (<7d)? Mature? |
| ⚖️ **Unified Scoring** | 5-axis weighted engine | Combined risk across all layers |

### Intelligence & Reputation (Layers 9-12)
| Layer | Source | Detection |
|-------|--------|-----------|
| 📈 **Market Intel** | Birdeye API | Liquidity, volume, wash trading, manipulation |
| 🔎 **Wallet Reputation** | Helius Identity + Funded-By | Is the deployer a known scammer? |
| 🕵️ **Deployer Recon** | DAS + Enhanced TX | Serial rugger? Burner wallet? Dead token history? |
| 🖼️ **NFT Intelligence** | Helius DAS + Magic Eden | Counterfeit collection? Unverified creators? Pricing anomaly? |

### 5-Axis Weighted Risk Scoring

```
finalScore = (onChain × 0.45) + (lpLock × 0.15) + (age × 0.05) + (market × 0.22) + (reputation × 0.13)

0       → SAFE
1-15    → CAUTION
16-50   → HIGH_RISK
51-100  → CRITICAL
```

| Weight | Source | What It Catches |
|--------|--------|----------------|
| **45%** | On-chain safety | Mint/freeze authority, honeypots, extensions, supply |
| **15%** | LP lock analysis | Unlocked liquidity, unburned LP tokens, lock duration |
| **5%** | Token age | Newborn tokens (<24h), recently deployed |
| **22%** | Birdeye market data | Low liquidity, wash trading, price manipulation |
| **13%** | Helius wallet intel | Scammer wallets, suspicious funding chains, burner deployers |

## 🚀 Quick Start

```bash
# Clone
git clone https://github.com/Chronolapse411/sicarius-guard.git
cd sicarius-guard

# Install
npm install

# Configure
cp .env.example .env
# Add your HELIUS_RPC_URL and optionally BIRDEYE_API_KEY

# Build & Run
npm run build
npm start
```

## 📡 API Endpoints

### REST API (Port 3400)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/v1/check` | Full on-chain safety analysis |
| `GET` | `/v1/check/:mint` | Convenience GET for safety check |
| `POST` | `/v1/scan` | Full 12-layer analysis + Birdeye + Helius + deployer recon |
| `GET` | `/v1/scan/:mint` | Convenience GET for enriched scan |
| `POST` | `/v1/honeypot` | Honeypot-only check (Jupiter sell sim) |
| `POST` | `/v1/holders` | Holder concentration analysis |
| `GET` | `/v1/lp-lock/:mint` | LP lock/burn status for a token |
| `GET` | `/v1/token-age/:mint` | Token creation date and age category |
| `GET` | `/v1/deployer/:address` | Deployer reconnaissance dossier |
| `GET` | `/v1/nft-check/:mint` | NFT safety analysis (Magic Eden + Helius DAS) |
| `GET` | `/v1/pricing` | x402 payment pricing table |
| `GET` | `/health` | Service health check with cache stats |

### Example Request

```bash
# Basic safety check (BONK)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/check/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

# Full 12-layer scan
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/scan/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

# LP lock check (POPCAT — 99.2% burned, 20,865 SOL liquidity)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/lp-lock/7GCihgDB8fe6LNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr

# NFT safety check (Mad Lads #7541)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/nft-check/7zuR45WCsAsWsrqvYPyvLXFiCRKuvjh7HrMcNJ6F36Kd

# Deployer recon (checks if a wallet is a serial scammer)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/deployer/BGkkEeg4Gj8VcoerFb2RephZNkTEfHmzJBZMv4S7qVTQ
```

### Example Response (`/v1/scan`)

```json
{
  "safety": {
    "safe": true,
    "riskScore": 0,
    "verdict": "SAFE",
    "checks": {
      "mintAuthority": { "status": "REVOKED", "safe": true },
      "freezeAuthority": { "status": "REVOKED", "safe": true },
      "token2022Extensions": { "status": "CLEAN", "safe": true },
      "supplyConcentration": { "status": "OK", "safe": true }
    }
  },
  "honeypot": { "isHoneypot": false, "sellable": true },
  "holders": { "concentrated": false, "stats": { "top10Pct": 8.2 } },
  "lpLock": {
    "status": "burned",
    "burnPct": 99.2,
    "liquiditySOL": 20865,
    "poolCreatedAt": "2023-12-12T..."
  },
  "tokenAge": {
    "ageCategory": "mature",
    "createdAt": "2022-12-08T...",
    "ageDays": 1259
  },
  "deployerRecon": {
    "verdict": "CLEAN",
    "recidivismScore": 0,
    "portfolioSize": 1
  },
  "combined": {
    "safe": true,
    "finalScore": 0,
    "verdict": "SAFE",
    "summary": "All checks passed — token appears safe"
  }
}
```

## 🤖 MCP Server (for AI Agents)

SicariusGuard exposes tools via the **Model Context Protocol (MCP)**, enabling LLMs and agent frameworks to call safety checks natively.

### Available MCP Tools (11)

| Tool | Description | Read-Only |
|------|-------------|:---------:|
| `check_token_safety` | 5-layer on-chain rug pull, honeypot, and holder analysis | ✅ |
| `check_honeypot` | Jupiter DEX sell simulation — zero cost, quote-only | ✅ |
| `check_holder_concentration` | Top holder distribution analysis with concentration flags | ✅ |
| `check_lp_lock` | LP lock/burn status — Raydium V4 byte decode + burn detection | ✅ |
| `check_token_age` | Token creation date and age category via Helius RPC | ✅ |
| `full_token_scan` | 12-layer scan: on-chain + LP + age + market + reputation + deployer | ✅ |
| `get_wallet_reputation` | Helius DAS identity, funding chain, deployer age analysis | ✅ |
| `get_market_intel` | Birdeye market data: price, volume, liquidity, risk flags | ✅ |
| `recon_deployer` | Deployer reconnaissance — portfolio health, serial scammer detection | ✅ |
| `check_nft` | NFT safety analysis — collection verification, floor price, risk scoring | ✅ |
| `batch_scan` | Parallel 12-layer scan of up to 10 tokens per call | ✅ |

### Install via npx (Recommended)

```bash
# Run directly — no cloning required
npx sicarius-guard
```

### Install in Claude Code

```bash
claude mcp add sicarius-guard -- npx -y sicarius-guard
```

### Install in Cursor

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=sicarius-guard&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInNpY2FyaXVzLWd1YXJkIl19)

Or manually add to your Cursor MCP config:

```json
{
  "mcpServers": {
    "sicarius-guard": {
      "command": "npx",
      "args": ["-y", "sicarius-guard"],
      "env": {
        "HELIUS_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
        "BIRDEYE_API_KEY": "your-birdeye-key"
      }
    }
  }
}
```

### Install in VS Code

[<img src="https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=for-the-badge&logo=visualstudiocode" alt="Install in VS Code">](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522sicarius-guard%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522-y%2522%252C%2522sicarius-guard%2522%255D%257D)

Or via CLI:

```bash
code --add-mcp '{"name":"sicarius-guard","command":"npx","args":["-y","sicarius-guard"]}'
```

### Install from Source (Claude Desktop / Cursor)

```json
{
  "mcpServers": {
    "sicarius-guard": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "cwd": "/path/to/sicarius-guard",
      "env": {
        "HELIUS_RPC_URL": "https://mainnet.helius-rpc.com/?api-key=YOUR_KEY",
        "BIRDEYE_API_KEY": "your-birdeye-key"
      }
    }
  }
}
```

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       SicariusGuard v1.1                      │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ REST API    │  │ MCP Server  │  │ x402 Payment Gate    │ │
│  │ Express 5   │  │ 11 tools    │  │ SOL Micropayments    │ │
│  │ 12 endpts   │  │ stdio       │  │                      │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘ │
│         │                │                     │             │
│  ┌──────▼────────────────▼─────────────────────▼───────────┐ │
│  │               12-Layer Analysis Engine                   │ │
│  │                                                          │ │
│  │  token_safety.ts   ┐                                    │ │
│  │  honeypot_sim.ts   ├─ On-Chain (45%)                    │ │
│  │  holder_analysis.ts┘                                    │ │
│  │  lp_lock.ts          LP Lock  (15%)                     │ │
│  │  token_age.ts        Age      (5%)                      │ │
│  │  birdeye.ts          Market   (22%)                     │ │
│  │  helius_wallet.ts    Rep      (13%)                     │ │
│  │  scoring.ts          Unified 5-Axis Engine              │ │
│  │  deployer_recon.ts   Deployer Reconnaissance            │ │
│  │  nft_intel.ts        NFT Intelligence (ME + DAS)        │ │
│  └──────────────────────────┬───────────────────────────────┘ │
│                             │                                 │
│     ┌───────────┬───────────┼───────────┬─────────────┐      │
│     ▼           ▼           ▼           ▼             ▼      │
│  ┌───────┐ ┌─────────┐ ┌────────┐ ┌──────────┐ ┌─────────┐ │
│  │Solana │ │Birdeye  │ │Helius  │ │Magic Eden│ │Gecko    │ │
│  │RPC    │ │API v3   │ │DAS+RPC │ │v2 (free) │ │Terminal │ │
│  └───────┘ └─────────┘ └────────┘ └──────────┘ └─────────┘ │
└──────────────────────────────────────────────────────────────┘
```

## 💰 x402 Payment Protocol

SicariusGuard implements the **x402 HTTP Payment Required** protocol for machine-native micropayments. AI agents can pay per API call with SOL — no registration, no API keys, no accounts.

### How It Works

```
1. Agent hits /v1/scan → gets 402 + payment instructions
2. Agent sends SOL to treasury wallet
3. Agent retries with X-PAYMENT: <tx_signature>
4. Server verifies on-chain → returns safety data
```

### Pricing

| Endpoint | Price (SOL) | Description |
|----------|------------|-------------|
| `/v1/check` | 0.001 | On-chain safety check |
| `/v1/scan` | 0.002 | Full 12-layer scan |
| `/v1/honeypot` | 0.0005 | Honeypot simulation |
| `/v1/holders` | 0.0005 | Holder analysis |
| `/v1/nft-check` | 0.001 | NFT safety check |

### Example (Paid Request)

```bash
# Step 1: Get pricing + treasury address
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/pricing

# Step 2: Send SOL to treasury address (returned in pricing response)
solana transfer <TREASURY_ADDRESS> 0.002

# Step 3: Use tx signature as payment proof
curl -X POST https://sicarius-guard-640545264957.us-east4.run.app/v1/scan \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <your_tx_signature>" \
  -d '{"mint": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'
```

### Security

- **On-chain verification** — Every payment is verified against Solana mainnet
- **Replay protection** — Each tx signature can only be used once
- **Amount validation** — Exact SOL amount must match endpoint pricing
- **Freshness check** — Transactions older than 10 minutes are rejected
- **Verified live on mainnet** — Tested with real SOL transfers

### Access Tiers

| Tier | Auth Method | Rate Limit |
|------|------------|------------|
| **Free** | None | 100 calls/day per IP |
| **x402 Pay-Per-Call** | `X-PAYMENT` header (SOL tx sig) | Unlimited |

## 🔧 Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `HELIUS_RPC_URL` | Solana RPC endpoint (Helius recommended) | `https://api.mainnet-beta.solana.com` |
| `PORT` | API server port | `3400` |
| `HOST` | Bind address | `0.0.0.0` |
| `BIRDEYE_API_KEY` | Birdeye API key (optional, enriches scans) | — |
| `TREASURY_WALLET` | SOL payment recipient (x402) | — |
| `CACHE_TTL_SECONDS` | Cache duration | `300` |
| `FREE_TIER_CALLS_PER_DAY` | Free tier rate limit | `100` |
| `UPSTASH_REDIS_REST_URL` | Upstash Redis URL for persistent rate limiting | — |
| `UPSTASH_REDIS_REST_TOKEN` | Upstash Redis auth token | — |

## 📊 Performance

Tested with 50-token bulk scan on Solana mainnet:

| Metric | Value |
|--------|-------|
| Success rate | **50/50 (100%)** |
| Avg response time | 5.4s |
| x402 payment verification | Verified live on mainnet |

## 📦 Tech Stack

- **Runtime:** Node.js 22+ (ESM)
- **Language:** TypeScript 5.9
- **Blockchain:** @solana/web3.js (direct RPC, no wrapper SDKs)
- **API:** Express 5
- **MCP:** @modelcontextprotocol/sdk
- **Market Data:** Birdeye API v3
- **NFT Data:** Magic Eden v2 API (free tier)
- **Wallet Intel:** Helius DAS / Identity / Funded-By APIs
- **Pool Data:** GeckoTerminal API + Raydium V4 byte decode

## 🛡️ Why SicariusGuard?

Most token safety tools rely on third-party APIs that can be gamed. SicariusGuard reads **raw mint account bytes directly from the blockchain** — the same data the Solana runtime uses to execute transactions. No middleman, no stale data, no API that can be fooled.

| Feature | SicariusGuard | RugCheck | GoPlus |
|---------|:---:|:---:|:---:|
| Byte-level SPL analysis | ✅ | ❌ | ❌ |
| Token-2022 extension scanning | ✅ | ❌ | Partial |
| Jupiter honeypot simulation | ✅ | ❌ | ❌ |
| LP lock/burn detection | ✅ | ✅ | ❌ |
| Raydium V4 byte decode | ✅ | ❌ | ❌ |
| Token age analysis | ✅ | ❌ | ❌ |
| Deployer serial scammer detection | ✅ | ❌ | ❌ |
| NFT fraud detection | ✅ | ❌ | ❌ |
| Helius wallet reputation | ✅ | ❌ | ❌ |
| 12-layer weighted scoring | ✅ | ❌ | ❌ |
| MCP server for AI agents | ✅ | ❌ | ❌ |
| x402 pay-per-call (SOL) | ✅ | ❌ | ❌ |
| Self-hosted (no vendor lock-in) | ✅ | ❌ | ❌ |
| Birdeye market enrichment | ✅ | ❌ | ❌ |
| Sub-6s full scan | ✅ | ✅ | ✅ |

## 🔗 Related MCP Servers

Build powerful agentic workflows by combining SicariusGuard with these complementary MCP servers:

| Server | Description | Use With SicariusGuard |
|--------|-------------|----------------------|
| [Pentagonal](https://glama.ai/mcp/servers/Pentagonal-ai/pentagonal) | AI-powered smart contract auditing for Solidity & Anchor/Rust | Audit the contract → scan the token with SicariusGuard |
| [Desk3](https://glama.ai/mcp/servers/desk3/cryptocurrency-mcp-server) | Real-time cryptocurrency market data | Get macro market context → validate token safety |
| [AgentForge](https://glama.ai/mcp/servers/agentforge/agentforge) | DeFi safety layer — SPL approval scans & contract registry | Check approvals → scan token safety with SicariusGuard |
| [Financial Datasets](https://glama.ai/mcp/servers/financial-datasets/mcp-server) | Stock & market data for AI assistants | Cross-market correlation analysis |

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Chronolapse411/sicarius-guard&type=Date)](https://star-history.com/#Chronolapse411/sicarius-guard&Date)

---

## 📄 License

MIT — Built by [Chronolapse411](https://github.com/Chronolapse411)

## 🔗 Links

- **npm:** [npmjs.com/package/sicarius-guard](https://www.npmjs.com/package/sicarius-guard)
- **Live API:** [sicarius-guard-640545264957.us-east4.run.app](https://sicarius-guard-640545264957.us-east4.run.app/health)
- **GitHub:** [github.com/Chronolapse411/sicarius-guard](https://github.com/Chronolapse411/sicarius-guard)
- **Glama:** [glama.ai/mcp/servers/Chronolapse411/sicarius-guard](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard)
- **Smithery:** [smithery.ai/server/chronolapse411/sicarius-guard](https://smithery.ai/server/chronolapse411/sicarius-guard)
- **Dev.to:** [How I Built a 12-Layer Token Safety Oracle](https://dev.to/chronolapse411/how-i-built-a-7-layer-token-safety-oracle-for-ai-agents-on-solana-2p40)
- **Twitter/X:** [@chronolapse411](https://x.com/chronolapse411)
- **Author:** [@Chronolapse411](https://github.com/Chronolapse411)
