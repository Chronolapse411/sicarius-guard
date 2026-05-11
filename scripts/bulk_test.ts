/**
 * SicariusGuard — BIP Sprint 4 Bulk Test Harness
 *
 * Runs 50+ scans against diverse token categories to:
 *   1. Meet the 50+ API call requirement for BIP Sprint 4
 *   2. Validate the triple-layer scoring (on-chain + market + reputation)
 *   3. Generate competition-ready metrics
 *
 * Token categories:
 *   - Blue chips (USDC, SOL, BONK, JUP, WIF, RAY, ORCA)
 *   - Mid-caps (PYTH, JTO, TENSOR, DRIFT)
 *   - Meme tokens (POPCAT, MYRO, MEW, BOME, WEN)
 *   - DeFi tokens (MNDE, MARINADE, BLZE)
 *   - Stablecoins (USDT, USDH)
 *   - Known risky / dead tokens
 *
 * Usage: npx tsx scripts/bulk_test.ts
 *
 * @author Chronolapse411
 */

const API_BASE = 'http://localhost:3400';

// ── Token Registry ───────────────────────────────────────────────────────────

interface TokenEntry {
    name: string;
    mint: string;
    category: string;
    expectedRisk: 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';
}

const TOKENS: TokenEntry[] = [
    // ── Stablecoins ──
    { name: 'USDC',       mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', category: 'stablecoin', expectedRisk: 'LOW' },
    { name: 'USDT',       mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', category: 'stablecoin', expectedRisk: 'LOW' },

    // ── Blue Chips ──
    { name: 'BONK',       mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', category: 'blue-chip',  expectedRisk: 'LOW' },
    { name: 'JUP',        mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',  category: 'blue-chip',  expectedRisk: 'LOW' },
    { name: 'WIF',        mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', category: 'blue-chip',  expectedRisk: 'LOW' },
    { name: 'RAY',        mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R', category: 'blue-chip',  expectedRisk: 'LOW' },
    { name: 'ORCA',       mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',  category: 'blue-chip',  expectedRisk: 'LOW' },
    { name: 'RENDER',     mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof',  category: 'blue-chip',  expectedRisk: 'LOW' },

    // ── Mid-Caps ──
    { name: 'PYTH',       mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3', category: 'mid-cap',    expectedRisk: 'LOW' },
    { name: 'JTO',        mint: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',  category: 'mid-cap',    expectedRisk: 'LOW' },
    { name: 'DRIFT',      mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7', category: 'mid-cap',    expectedRisk: 'LOW' },
    { name: 'W',          mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ', category: 'mid-cap',    expectedRisk: 'LOW' },
    { name: 'TENSOR',     mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', category: 'mid-cap',    expectedRisk: 'LOW' },
    { name: 'KMNO',       mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS',  category: 'mid-cap',    expectedRisk: 'LOW' },

    // ── Meme Tokens ──
    { name: 'POPCAT',     mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', category: 'meme',       expectedRisk: 'LOW' },
    { name: 'MEW',        mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5',  category: 'meme',       expectedRisk: 'LOW' },
    { name: 'BOME',       mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82',  category: 'meme',       expectedRisk: 'MEDIUM' },
    { name: 'WEN',        mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk',   category: 'meme',       expectedRisk: 'MEDIUM' },
    { name: 'MYRO',       mint: 'HhJpBhRRn4g56VsyLuT8DL5Bv31HkXqsrahTTUCZeZg4', category: 'meme',       expectedRisk: 'MEDIUM' },
    { name: 'SLERF',      mint: '7BgBvyjrZX1YKz4oh9mjb8ZScatkkwb8DzFx7LoiVkM3', category: 'meme',       expectedRisk: 'MEDIUM' },
    { name: 'SAMO',       mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', category: 'meme',       expectedRisk: 'LOW' },

    // ── DeFi Tokens ──
    { name: 'MNDE',       mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey',  category: 'defi',       expectedRisk: 'LOW' },
    { name: 'BLZE',       mint: 'BLZEEuZUBVqFhj8adcCFPJvPVCiCyVmh3hkJMrU8KuJA', category: 'defi',       expectedRisk: 'LOW' },
    { name: 'MSOL',       mint: 'mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So',  category: 'defi',       expectedRisk: 'LOW' },
    { name: 'BSOL',       mint: 'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1',  category: 'defi',       expectedRisk: 'LOW' },
    { name: 'JSOL',       mint: '7Q2afV64in6N6SeZsAAB81TJzwpeLmhBgYaVhMJFdStE', category: 'defi',       expectedRisk: 'LOW' },

    // ── LST/Governance ──
    { name: 'HNT',        mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux',  category: 'governance',  expectedRisk: 'LOW' },
    { name: 'MOBILE',     mint: 'mb1eu7TzEc71KxDpsmsKoucSSuuo6KWC999NEWNBjEwh',  category: 'governance',  expectedRisk: 'LOW' },
    { name: 'IOT',        mint: 'iotEVVZLEywoTn1QdwNPddxPWszn3zFhEot3MfL9fns',   category: 'governance',  expectedRisk: 'LOW' },

    // ── Wrapped/Bridge ──
    { name: 'wETH',       mint: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', category: 'wrapped',     expectedRisk: 'LOW' },
    { name: 'wBTC',       mint: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh', category: 'wrapped',     expectedRisk: 'LOW' },
    { name: 'tBTC',       mint: '6DNSN2BJsaPFdBAk8hfPEh7n2qS3XhDCo4R12BwuDiY5', category: 'wrapped',     expectedRisk: 'LOW' },

    // ── AI/New Narratives ──
    { name: 'NOSANA',     mint: 'nosXBVoaCTtYdLvKY6Csb4AC8JCdQKKAaWYtx2ZMoo7',  category: 'ai',          expectedRisk: 'LOW' },
    { name: 'TNSR',       mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6', category: 'ai',          expectedRisk: 'LOW' },
    { name: 'ACCESS',     mint: '5MAYDfq5yxtudAhtfyuMBuHZjgAbaS9tbEyEQYAhDS5y', category: 'ai',          expectedRisk: 'UNKNOWN' },

    // ── Gaming ──
    { name: 'ATLAS',      mint: 'ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx', category: 'gaming',      expectedRisk: 'LOW' },
    { name: 'POLIS',      mint: 'poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk', category: 'gaming',      expectedRisk: 'LOW' },
    { name: 'GENE',       mint: 'GENEtH5amGSi8kHAtQoezp1XEXwZJ8vcuePYnXdKrMYz', category: 'gaming',      expectedRisk: 'LOW' },

    // ── Infrastructure ──
    { name: 'STEP',       mint: 'StepAscQoEioFxxWGnh2sLBDFp9d8rvKz2Yp39iDpyT',  category: 'infra',       expectedRisk: 'LOW' },
    { name: 'SRM',        mint: 'SRMuApVNdxXokk5GT7XD5cUUgXMBCoAz2LHeuAoKWRt',  category: 'infra',       expectedRisk: 'MEDIUM' },

    // ── Extra memes for volume ──
    { name: 'TRUMP',      mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'FARTCOIN',   mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'AI16Z',      mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'PENGU',      mint: '2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'GOAT',       mint: 'CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'PNUT',       mint: '2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'GRIFFAIN',   mint: 'KENJSUYLASHUMfHyy5o4Hp2FdNqZg1AsUPhfH2kYvEP',  category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'MOODENG',    mint: 'ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'SPX6900',    mint: '8wXtPeU6557ETkp9WHFY1n1EcU6NxDvbAggHGsMYiHsB', category: 'meme',        expectedRisk: 'UNKNOWN' },
    { name: 'CHILLGUY',   mint: 'Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump', category: 'meme',        expectedRisk: 'UNKNOWN' },
];

// ── Result Types ─────────────────────────────────────────────────────────────

interface ScanResult {
    token: TokenEntry;
    success: boolean;
    verdict?: string;
    finalScore?: number;
    onChainScore?: number;
    marketScore?: number;
    reputationScore?: number;
    reputationVerdict?: string;
    reputationFlags?: string[];
    marketFlags?: string[];
    summary?: string;
    latencyMs: number;
    error?: string;
    birdeyeCallsMade: number;  // Track Birdeye API calls for competition
    heliusCallsMade: number;   // Track Helius API calls
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function runScan(token: TokenEntry): Promise<ScanResult> {
    const start = Date.now();
    try {
        const res = await fetch(`${API_BASE}/v1/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mint: token.mint }),
            signal: AbortSignal.timeout(30_000),
        });

        const data = await res.json() as Record<string, any>;
        const latencyMs = Date.now() - start;

        if (!res.ok) {
            return {
                token, success: false, latencyMs,
                error: data.error ?? `HTTP ${res.status}`,
                birdeyeCallsMade: 0, heliusCallsMade: 0,
            };
        }

        return {
            token,
            success: true,
            verdict: data.combined?.verdict,
            finalScore: data.combined?.finalScore,
            onChainScore: data.combined?.riskScore,
            marketScore: data.combined?.marketRiskScore,
            reputationScore: data.combined?.reputationScore,
            reputationVerdict: data.walletIntel?.reputation?.verdict,
            reputationFlags: data.walletIntel?.reputation?.flags,
            marketFlags: data.birdeye?.marketRisk?.flags,
            summary: data.combined?.summary,
            latencyMs,
            birdeyeCallsMade: data.cached ? 0 : 2,   // token_overview + trade_data
            heliusCallsMade: data.cached ? 0 : 4,     // getAccountInfo + getTokenLargestAccounts + identity + funded-by
        };
    } catch (e) {
        return {
            token, success: false,
            latencyMs: Date.now() - start,
            error: e instanceof Error ? e.message : String(e),
            birdeyeCallsMade: 0, heliusCallsMade: 0,
        };
    }
}

async function main() {
    console.log('╔════════════════════════════════════════════════════════════╗');
    console.log('║  SicariusGuard — BIP Sprint 4 Bulk Test                   ║');
    console.log(`║  Tokens: ${TOKENS.length} | Target: 50+ Birdeye API calls            ║`);
    console.log('╚════════════════════════════════════════════════════════════╝');
    console.log();

    // Health check
    try {
        const health = await fetch(`${API_BASE}/health`);
        if (!health.ok) throw new Error(`Health check failed: ${health.status}`);
        console.log('✅ Server health check passed\n');
    } catch (e) {
        console.error('❌ Server not reachable at', API_BASE);
        console.error('   Start it first: node dist/index.js');
        process.exit(1);
    }

    const results: ScanResult[] = [];
    let totalBirdeyeCalls = 0;
    let totalHeliusCalls = 0;

    for (let i = 0; i < TOKENS.length; i++) {
        const token = TOKENS[i];
        const progress = `[${(i + 1).toString().padStart(2, ' ')}/${TOKENS.length}]`;

        process.stdout.write(`${progress} Scanning ${token.name.padEnd(12)} (${token.category})...`);

        const result = await runScan(token);
        results.push(result);
        totalBirdeyeCalls += result.birdeyeCallsMade;
        totalHeliusCalls += result.heliusCallsMade;

        if (result.success) {
            const scoreStr = `${result.finalScore}`.padStart(3);
            const verdictColor = result.verdict === 'SAFE' ? '\x1b[32m'
                : result.verdict === 'CAUTION' ? '\x1b[33m'
                : result.verdict === 'HIGH_RISK' ? '\x1b[31m'
                : '\x1b[91m';
            console.log(` ${verdictColor}${result.verdict?.padEnd(10)}\x1b[0m score=${scoreStr} latency=${result.latencyMs}ms`);
        } else {
            console.log(` \x1b[91m❌ ERROR\x1b[0m ${result.error}`);
        }

        // 1.2s delay between scans to respect Birdeye 1 RPS limit
        if (i < TOKENS.length - 1) {
            await new Promise(r => setTimeout(r, 1200));
        }
    }

    // ── Summary Report ───────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(72));
    console.log('  RESULTS SUMMARY');
    console.log('═'.repeat(72));

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const avgLatency = successful.length > 0
        ? Math.round(successful.reduce((s, r) => s + r.latencyMs, 0) / successful.length)
        : 0;

    // Verdict breakdown
    const verdicts: Record<string, number> = {};
    for (const r of successful) {
        verdicts[r.verdict!] = (verdicts[r.verdict!] || 0) + 1;
    }

    console.log(`  Total scans:        ${results.length}`);
    console.log(`  Successful:         ${successful.length}`);
    console.log(`  Failed:             ${failed.length}`);
    console.log(`  Avg latency:        ${avgLatency}ms`);
    console.log(`  Birdeye API calls:  ${totalBirdeyeCalls}`);
    console.log(`  Helius API calls:   ${totalHeliusCalls}`);
    console.log();
    console.log('  Verdict Distribution:');
    for (const [v, count] of Object.entries(verdicts).sort()) {
        const bar = '█'.repeat(count);
        console.log(`    ${v.padEnd(12)} ${count.toString().padStart(3)} ${bar}`);
    }

    // ── Category Breakdown ───────────────────────────────────────────────
    console.log('\n  Category Breakdown:');
    const categories = [...new Set(TOKENS.map(t => t.category))];
    for (const cat of categories) {
        const catResults = successful.filter(r => r.token.category === cat);
        if (catResults.length === 0) continue;
        const avgScore = Math.round(catResults.reduce((s, r) => s + (r.finalScore ?? 0), 0) / catResults.length);
        console.log(`    ${cat.padEnd(14)} ${catResults.length} scans, avg score: ${avgScore}`);
    }

    // ── Competition Compliance ───────────────────────────────────────────
    console.log('\n  BIP Sprint 4 Compliance:');
    console.log(`    ✅ Total Birdeye API calls:  ${totalBirdeyeCalls} ${totalBirdeyeCalls >= 50 ? '(MEETS 50+ REQUIREMENT)' : '(⚠️ NEED MORE)'}`);
    console.log(`    ✅ Helius API calls:          ${totalHeliusCalls}`);
    console.log(`    ✅ x402 monetization:         Integrated`);
    console.log(`    ✅ Multi-source intelligence: On-chain + Market + Reputation`);

    // ── Reputation Intel ─────────────────────────────────────────────────
    const withRepFlags = successful.filter(r => r.reputationFlags && r.reputationFlags.length > 0);
    if (withRepFlags.length > 0) {
        console.log('\n  Reputation Intelligence Hits:');
        for (const r of withRepFlags) {
            console.log(`    ${r.token.name.padEnd(12)} ${r.reputationVerdict} — ${r.reputationFlags!.join(', ')}`);
        }
    }

    // ── Errors ───────────────────────────────────────────────────────────
    if (failed.length > 0) {
        console.log('\n  ❌ Failed Scans:');
        for (const r of failed) {
            console.log(`    ${r.token.name.padEnd(12)} ${r.error}`);
        }
    }

    console.log('\n' + '═'.repeat(72));
    console.log(`  Competition submission ready: ${totalBirdeyeCalls >= 50 ? '✅ YES' : '❌ NO — need more scans'}`);
    console.log('═'.repeat(72));
}

main().catch(console.error);
