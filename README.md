# 🛡️ SicariusGuard

**Solana Token Safety Oracle for AI Agents & Trading Bots**

Real-time token safety analysis combining byte-level on-chain inspection with market intelligence. Built for autonomous AI agents, MCP-enabled LLMs, and trading infrastructure.

> *"Don't trade blind. Query SicariusGuard before every swap."*

---

## 🔍 What It Does

SicariusGuard performs **5 layers of safety analysis** on any Solana SPL token in under 2 seconds:

| Layer | Analysis | Detection |
|-------|----------|-----------|
| 🔓 **Mint Authority** | Raw SPL mint account byte read | Can deployer print infinite tokens? |
| 🧊 **Freeze Authority** | SPL layout offset 46 inspection | Can deployer freeze any wallet? |
| ⚠️ **Token-2022 Extensions** | Extension type scanning | PermanentDelegate, TransferHook, ConfidentialTransfers |
| 🍯 **Honeypot Detection** | Jupiter sell simulation (dry-run) | Can you actually sell this token? |
| 📊 **Holder Concentration** | `getTokenLargestAccounts` analysis | Top 5 wallets controlling >50% supply? |
| 📈 **Market Intelligence** | Birdeye API enrichment | Liquidity, volume, wash trading, price manipulation |

### Risk Scoring

Every analysis returns a **0-100 risk score** with a clear verdict:

```
0       → SAFE
1-15    → CAUTION
16-50   → HIGH_RISK
51-100  → CRITICAL
```

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
| `POST` | `/v1/scan` | Full analysis + Birdeye market enrichment |
| `GET` | `/v1/scan/:mint` | Convenience GET for enriched scan |
| `POST` | `/v1/honeypot` | Honeypot-only check (Jupiter sell sim) |
| `POST` | `/v1/holders` | Holder concentration analysis |
| `GET` | `/v1/pricing` | x402 payment pricing table |
| `GET` | `/x402/stats` | Payment verification stats |
| `GET` | `/health` | Service health check |

### Example Request

```bash
# Basic safety check
curl -X POST http://localhost:3400/v1/check \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'

# Full scan with Birdeye enrichment
curl -X POST http://localhost:3400/v1/scan \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_KEY" \
  -d '{"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
```

### Example Response

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
  "honeypot": { "isHoneypot": false, "sellable": true },
  "holders": { "concentrated": false, "top5Pct": 12.3 },
  "combined": {
    "safe": true,
    "riskScore": 0,
    "verdict": "SAFE",
    "summary": "All checks passed"
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

### Usage with Solana Agent Kit

```typescript
import { SicariusGuard } from 'sicarius-guard';

const guard = new SicariusGuard({ rpcUrl: process.env.HELIUS_RPC_URL });
const result = await guard.checkToken('So11111111111111111111111111111111111111112');

if (!result.safe) {
  console.log(`⚠️ ${result.verdict}: ${result.reason}`);
  // Agent decides not to trade
}
```

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SicariusGuard                         │
│                                                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────┐ │
│  │ REST API    │  │ MCP Server  │  │ x402 Payment    │ │
│  │ Express     │  │ stdio       │  │ SOL Micropay    │ │
│  └──────┬──────┘  └──────┬──────┘  └────────┬────────┘ │
│         │                │                   │          │
│  ┌──────▼────────────────▼───────────────────▼────────┐ │
│  │              Core Safety Engine                    │ │
│  │                                                    │ │
│  │  ┌────────────┐ ┌──────────┐ ┌─────────────────┐  │ │
│  │  │ token_     │ │honeypot_ │ │ holder_         │  │ │
│  │  │ safety.ts  │ │sim.ts    │ │ analysis.ts     │  │ │
│  │  └────────────┘ └──────────┘ └─────────────────┘  │ │
│  │                                                    │ │
│  │  ┌────────────────────────────────────────────┐    │ │
│  │  │ birdeye.ts — Market Intelligence Layer     │    │ │
│  │  │  • Token Overview (price, volume, liq)     │    │ │
│  │  │  • Security Flags (holders, metadata)      │    │ │
│  │  │  • Trade Data (wash trading detection)     │    │ │
│  │  └────────────────────────────────────────────┘    │ │
│  └────────────────────────────────────────────────────┘ │
│                         │                               │
│              ┌──────────▼──────────┐                    │
│              │  Solana Mainnet     │                    │
│              │  (Helius RPC)       │                    │
│              └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
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

| Endpoint | Price (SOL) | ~USD |
|----------|------------|------|
| `/v1/check` | 0.001 | $0.15 |
| `/v1/scan` | 0.002 | $0.30 |
| `/v1/honeypot` | 0.0005 | $0.07 |
| `/v1/holders` | 0.0005 | $0.07 |

### Example (Paid Request)

```bash
# Step 1: Get pricing
curl http://localhost:3400/v1/pricing

# Step 2: Send SOL to treasury (via any wallet/CLI)
solana transfer 5QMsfrUcaJ8WgD98MD8NJ3aEHvYz443QqFEJqGXbyLFM 0.002

# Step 3: Use tx signature as payment proof
curl -X POST http://localhost:3400/v1/scan \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <your_tx_signature>" \
  -d '{"mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"}'
```

### Access Tiers

| Tier | Auth Method | Rate Limit |
|------|------------|------------|
| **Free** | None | 100 calls/day per IP |
| **API Key** | `x-api-key` header | Unlimited |
| **x402 Pay-Per-Call** | `X-PAYMENT` header (SOL tx sig) | Unlimited |

## 🔧 Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `HELIUS_RPC_URL` | Solana RPC endpoint | `https://api.mainnet-beta.solana.com` |
| `PORT` | API server port | `3400` |
| `HOST` | Bind address | `0.0.0.0` |
| `BIRDEYE_API_KEY` | Birdeye API key (optional) | — |
| `TREASURY_WALLET` | SOL payment recipient | `5QMsfrU...LFM` |
| `CACHE_TTL_SECONDS` | Cache duration | `300` |
| `FREE_TIER_CALLS_PER_DAY` | Rate limit | `100` |

## 📦 Tech Stack

- **Runtime:** Node.js 20+ (ESM)
- **Language:** TypeScript 5.9
- **Blockchain:** @solana/web3.js (direct RPC, no wrapper SDKs)
- **API:** Express 5
- **MCP:** @modelcontextprotocol/sdk
- **Market Data:** Birdeye API

## 🛡️ Why SicariusGuard?

Most token safety tools rely on third-party APIs that can be gamed. SicariusGuard reads **raw mint account bytes directly from the blockchain** — the same data the Solana runtime uses to execute transactions. No middleman, no stale data, no API that can be fooled.

| Feature | SicariusGuard | RugCheck | GoPlus |
|---------|:---:|:---:|:---:|
| Byte-level SPL analysis | ✅ | ❌ | ❌ |
| Token-2022 extension scanning | ✅ | ❌ | Partial |
| Jupiter honeypot simulation | ✅ | ❌ | ❌ |
| MCP server for AI agents | ✅ | ❌ | ❌ |
| x402 pay-per-call (SOL) | ✅ | ❌ | ❌ |
| Self-hosted (no vendor lock-in) | ✅ | ❌ | ❌ |
| Birdeye market enrichment | ✅ | ❌ | ❌ |
| Sub-2s response time | ✅ | ✅ | ✅ |

## 📄 License

MIT — Built by [Chronolapse411](https://github.com/Chronolapse411)

## 🔗 Links

- **GitHub:** [github.com/Chronolapse411/sicarius-guard](https://github.com/Chronolapse411/sicarius-guard)
- **Author:** Manuel Delgado ([@Chronolapse411](https://github.com/Chronolapse411))
- **Business:** DelgadoLogic
