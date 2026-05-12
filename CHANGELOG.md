# Changelog

All notable changes to SicariusGuard will be documented in this file.

## [1.0.0] - 2026-05-12

### Added
- **7-layer safety analysis**: mint authority, freeze authority, Token-2022 extensions, honeypot simulation, holder concentration, Birdeye market intelligence, Helius wallet reputation
- **MCP Server** with 7 tools: `check_token_safety`, `check_honeypot`, `check_holder_concentration`, `full_token_scan`, `get_wallet_reputation`, `get_market_intel`, `batch_scan`
- **REST API** with Express 5 on Cloud Run (`us-east4`)
- **x402 micropayment protocol** for SOL pay-per-call monetization
- **Upstash Redis** persistent rate limiting (100 free calls/day per IP)
- **Weighted risk scoring** (60% on-chain, 25% market, 15% reputation)
- **Glama registry** integration with `glama.json` and verified author status
- **Smithery registry** listing for agent ecosystem discoverability
- **GitHub Actions CI** for build verification and Docker validation
- **Auto-discovery** via `/.well-known/mcp/server-card.json` endpoint
- MIT License
