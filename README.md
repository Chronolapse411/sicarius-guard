# 🛡️ SicariusGuard

**Solana Token Safety Oracle for AI Agents & Trading Bots**

[![sicarius-guard MCP server](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard/badges/card.svg)](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard)
[![Score](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard/badges/score.svg)](https://glama.ai/mcp/servers/Chronolapse411/sicarius-guard)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Smithery](https://smithery.ai/badge/sicarius-guard)](https://smithery.ai/server/chronolapse411/sicarius-guard)

Real-time token safety analysis combining byte-level on-chain inspection, market intelligence, and wallet reputation scoring. Built for autonomous AI agents, MCP-enabled LLMs, and trading infrastructure.

> *"Don't trade blind. Query SicariusGuard before every swap."*

### 🌐 Live API: `https://sicarius-guard-640545264957.us-east4.run.app`

```bash
# Try it now — no auth required (100 free calls/day)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/scan/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

---

## 🔍 What It Does

SicariusGuard performs **7 layers of safety analysis** on any Solana SPL token:

| Layer | Source | Detection |
|-------|--------|-----------|
| 🔓 **Mint Authority** | Raw SPL mint bytes | Can deployer print infinite tokens? |
| 🧊 **Freeze Authority** | SPL layout offset 46 | Can deployer freeze any wallet? |
| ⚠️ **Token-2022 Extensions** | Extension type scan | PermanentDelegate, TransferHook, ConfidentialTransfers |
| 🍯 **Honeypot Detection** | Jupiter sell simulation | Can you actually sell this token? |
| 📊 **Holder Concentration** | `getTokenLargestAccounts` | Top 5 wallets controlling >50% supply? |
| 📈 **Market Intelligence** | Birdeye API | Liquidity, volume, wash trading, manipulation |
| 🔎 **Wallet Reputation** | Helius Identity + Funded-By | Is the deployer wallet a known scammer? |

### Weighted Risk Scoring (60/25/15 Model)

```
finalScore = (onChainRisk × 0.60) + (marketRisk × 0.25) + (reputationRisk × 0.15)

0       → SAFE
1-15    → CAUTION
16-50   → HIGH_RISK
51-100  → CRITICAL
```

| Weight | Source | What It Catches |
|--------|--------|----------------|
| **60%** | On-chain safety | Mint/freeze authority, honeypots, extensions |
| **25%** | Birdeye market data | Low liquidity, wash trading, price manipulation |
| **15%** | Helius wallet intel | Scammer wallets, suspicious funding chains |

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
| `POST` | `/v1/scan` | Full analysis + Birdeye + Helius wallet intel |
| `GET` | `/v1/scan/:mint` | Convenience GET for enriched scan |
| `POST` | `/v1/honeypot` | Honeypot-only check (Jupiter sell sim) |
| `POST` | `/v1/holders` | Holder concentration analysis |
| `GET` | `/v1/pricing` | x402 payment pricing table |
| `GET` | `/x402/stats` | Payment verification stats |
| `GET` | `/health` | Service health check |

### Example Request

```bash
# Basic safety check (BONK)
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/check/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263

# Full scan with Birdeye + Helius enrichment
curl https://sicarius-guard-640545264957.us-east4.run.app/v1/scan/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263
```

### Example Response (`/v1/scan`)

```json
{
  "safety": {
    "safe": true,
    "riskScore": 0,
    "verdict": "SAFE",
    "reason": "SAFE — mint/freeze revoked, no dangerous extensions, supply OK",
    "checks": {
      "mintAuthority": { "status": "REVOKED", "safe": true },
      "freezeAuthority": { "status": "REVOKED", "safe": true },
      "token2022Extensions": { "status": "CLEAN", "safe": true },
      "supplyConcentration": { "status": "OK", "safe": true }
    }
  },
  "honeypot": {
    "isHoneypot": false,
    "sellable": true,
    "reason": "Sellable via Raydium → Quantum"
  },
  "holders": {
    "concentrated": false,
    "stats": { "top10Pct": 8.2 }
  },
  "birdeye": {
    "overview": {
      "price": 0.0000075,
      "liquidity": 3511099,
      "marketCap": 631226030,
      "holder": 999749
    },
    "marketRisk": { "verdict": "MARKET_SAFE", "flags": [] }
  },
  "walletIntel": {
    "creatorAddress": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
    "reputation": {
      "verdict": "TRUSTED",
      "riskScore": 0,
      "flags": []
    }
  },
  "combined": {
    "safe": true,
    "riskScore": 0,
    "marketRiskScore": 0,
    "reputationScore": 0,
    "finalScore": 0,
    "verdict": "SAFE",
    "summary": "All checks passed — token appears safe"
  }
}
```

## 🤖 MCP Server (for AI Agents)

SicariusGuard exposes tools via the **Model Context Protocol (MCP)**, enabling LLMs and agent frameworks to call safety checks natively.

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `check_token_safety` | Full SPL mint safety analysis |
| `check_honeypot` | Jupiter sell simulation |
| `check_holder_concentration` | Top holder analysis |
| `full_token_scan` | Complete scan with Birdeye + Helius intel |

### Usage with Claude/Cursor

```json
{
  "mcpServers": {
    "sicarius-guard": {
      "command": "node",
      "args": ["dist/mcp-server.js"],
      "cwd": "/path/to/sicarius-guard"
    }
  }
}
```

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                       SicariusGuard                           │
│                                                              │
│  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐ │
│  │ REST API    │  │ MCP Server  │  │ x402 Payment Gate    │ │
│  │ Express 5   │  │ stdio       │  │ SOL Micropayments    │ │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘ │
│         │                │                     │             │
│  ┌──────▼────────────────▼─────────────────────▼───────────┐ │
│  │                  Core Safety Engine                      │ │
│  │                                                          │ │
│  │  ┌────────────┐ ┌──────────┐ ┌───────────────────────┐  │ │
│  │  │ token_     │ │honeypot_ │ │ holder_               │  │ │
│  │  │ safety.ts  │ │sim.ts    │ │ analysis.ts           │  │ │
│  │  └────────────┘ └──────────┘ └───────────────────────┘  │ │
│  │                                                          │ │
│  │  ┌────────────────────┐  ┌────────────────────────────┐ │ │
│  │  │ birdeye.ts         │  │ helius_wallet.ts           │ │ │
│  │  │ Market Intelligence│  │ Wallet Reputation (15%)    │ │ │
│  │  │ • Price/Volume     │  │ • Identity API             │ │ │
│  │  │ • Liquidity        │  │ • Funded-By chain          │ │ │
│  │  │ • Wash trading     │  │ • Scammer detection        │ │ │
│  │  └────────────────────┘  └────────────────────────────┘ │ │
│  └──────────────────────────────────────────────────────────┘ │
│                         │                                     │
│         ┌───────────────┼───────────────┐                    │
│         ▼               ▼               ▼                    │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐           │
│  │ Solana RPC  │ │ Birdeye API │ │ Helius DAS  │           │
│  │ (Helius)    │ │ (Market)    │ │ (Wallet)    │           │
│  └─────────────┘ └─────────────┘ └─────────────┘           │
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

| Endpoint | Price (SOL) |
|----------|------------|
| `/v1/check` | 0.001 |
| `/v1/scan` | 0.002 |
| `/v1/honeypot` | 0.0005 |
| `/v1/holders` | 0.0005 |

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
- **Wallet Intel:** Helius DAS / Identity / Funded-By APIs

## 🛡️ Why SicariusGuard?

Most token safety tools rely on third-party APIs that can be gamed. SicariusGuard reads **raw mint account bytes directly from the blockchain** — the same data the Solana runtime uses to execute transactions. No middleman, no stale data, no API that can be fooled.

| Feature | SicariusGuard | RugCheck | GoPlus |
|---------|:---:|:---:|:---:|
| Byte-level SPL analysis | ✅ | ❌ | ❌ |
| Token-2022 extension scanning | ✅ | ❌ | Partial |
| Jupiter honeypot simulation | ✅ | ❌ | ❌ |
| Helius wallet reputation | ✅ | ❌ | ❌ |
| Weighted multi-source scoring | ✅ | ❌ | ❌ |
| MCP server for AI agents | ✅ | ❌ | ❌ |
| x402 pay-per-call (SOL) | ✅ | ❌ | ❌ |
| Self-hosted (no vendor lock-in) | ✅ | ❌ | ❌ |
| Birdeye market enrichment | ✅ | ❌ | ❌ |
| Sub-6s full scan | ✅ | ✅ | ✅ |

## 📄 License

MIT — Built by [Chronolapse411](https://github.com/Chronolapse411)

## 🔗 Links

- **Live API:** [sicarius-guard-640545264957.us-east4.run.app](https://sicarius-guard-640545264957.us-east4.run.app/health)
- **GitHub:** [github.com/Chronolapse411/sicarius-guard](https://github.com/Chronolapse411/sicarius-guard)
- **Author:** [@Chronolapse411](https://github.com/Chronolapse411)
