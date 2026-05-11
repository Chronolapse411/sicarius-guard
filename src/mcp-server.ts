#!/usr/bin/env node
/**
 * SicariusGuard — MCP Server Entry Point
 */

import 'dotenv/config';
import { startMCPServer } from './mcp/server.js';

startMCPServer().catch(err => {
    console.error('[SicariusGuard MCP] Fatal error:', err);
    process.exit(1);
});
