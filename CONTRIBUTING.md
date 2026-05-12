# Contributing to SicariusGuard

Thank you for your interest in contributing to SicariusGuard!

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/YOUR_USERNAME/sicarius-guard.git`
3. Install dependencies: `npm install`
4. Create a feature branch: `git checkout -b feature/your-feature`
5. Make your changes
6. Build and verify: `npm run build`
7. Commit with a descriptive message
8. Push to your fork and open a PR

## Development Setup

```bash
# Required environment variables
export HELIUS_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
export BIRDEYE_API_KEY="your-birdeye-key"  # Optional but recommended

# Build
npm run build

# Run MCP server (stdio)
node dist/mcp-server.js

# Run REST API server
node dist/api-server.js
```

## Code Style

- TypeScript strict mode
- ESM modules (`"type": "module"` in package.json)
- Descriptive function and variable names
- Error handling with try/catch — never let exceptions pass silently

## Adding a New MCP Tool

1. Create or modify the core analysis module in `src/core/`
2. Register the tool in `src/mcp/server.ts` using `server.tool()`
3. Add the corresponding REST endpoint in `src/api/server.ts`
4. Update the server-card endpoint with the new tool description
5. Update `README.md` and `glama.json` with the new tool

## Reporting Issues

Please open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Error messages (if any)
- Node.js version and OS

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
