/**
 * SicariusGuard — Express REST API Server
 *
 * Endpoints:
 *   POST /v1/check          — full token safety analysis
 *   POST /v1/honeypot       — honeypot-only check (Jupiter sell sim)
 *   POST /v1/holders        — holder concentration analysis
 *   GET  /v1/check/:mint    — convenience GET for simple checks
 *   GET  /health            — health check
 *
 * @author Chronolapse411
 */

import express from 'express';
import cors from 'cors';
import { Connection } from '@solana/web3.js';
import { analyzeTokenSafety, type SafetyResult } from '../core/token_safety.js';
import { checkHoneypot, type HoneypotResult } from '../core/honeypot_sim.js';
import { analyzeHolders, type HolderResult } from '../core/holder_analysis.js';
import { authMiddleware, cleanupRateLimits } from './auth.js';
import { ResultCache } from './cache.js';
import { enrichWithBirdeye, type BirdeyeEnrichment } from '../core/birdeye.js';
import { enrichCreatorReputation, extractHeliusApiKey, type WalletIntelligence } from '../core/helius_wallet.js';
import { x402PaymentMiddleware, cleanupPaymentCache, getPricing, getPaymentStats } from './x402.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface FullCheckResult {
    safety:   SafetyResult;
    honeypot: HoneypotResult;
    holders:  HolderResult;
    combined: {
        safe:      boolean;
        riskScore: number;
        verdict:   string;
        summary:   string;
    };
}

interface FullScanResult {
    safety:    SafetyResult;
    honeypot:  HoneypotResult;
    holders:   HolderResult;
    birdeye:   BirdeyeEnrichment;
    walletIntel: WalletIntelligence;
    combined:  {
        safe:           boolean;
        riskScore:      number;
        marketRiskScore: number;
        reputationScore: number;
        finalScore:     number;
        verdict:        string;
        summary:        string;
    };
}

// ── Server Setup ─────────────────────────────────────────────────────────────

const RPC_URL   = process.env.HELIUS_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PORT      = parseInt(process.env.PORT || '3400', 10);
const HOST      = process.env.HOST || '0.0.0.0';
const CACHE_TTL = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);

// Solana connection with finalized commitment for safety-critical reads
const connection = new Connection(RPC_URL, 'finalized');

// Result caches
const safetyCache   = new ResultCache<SafetyResult>(CACHE_TTL);
const honeypotCache = new ResultCache<HoneypotResult>(CACHE_TTL);
const holderCache   = new ResultCache<HolderResult>(CACHE_TTL);
const fullCache     = new ResultCache<FullCheckResult>(CACHE_TTL);
const scanCache     = new ResultCache<FullScanResult>(CACHE_TTL);

const BIRDEYE_API_KEY = process.env.BIRDEYE_API_KEY || '';
const HELIUS_API_KEY  = extractHeliusApiKey(RPC_URL);

// Solana address validation (base58, 32-44 chars)
const MINT_REGEX = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function isValidMint(mint: unknown): mint is string {
    return typeof mint === 'string' && MINT_REGEX.test(mint);
}

// ── Express App ──────────────────────────────────────────────────────────────

export function createApp(): express.Express {
    const app = express();

    app.use(cors());
    app.use(express.json({ limit: '1mb' }));

    // Health check (no auth)
    app.get('/health', (_req, res) => {
        res.json({
            status: 'ok',
            service: 'sicarius-guard',
            version: '1.0.0',
            uptime: process.uptime(),
            cacheSize: {
                safety: safetyCache.size(),
                honeypot: honeypotCache.size(),
                holders: holderCache.size(),
                full: fullCache.size(),
            },
        });
    });

    // ── Landing Page ─────────────────────────────────────────────────────────
    app.get('/', (_req, res) => {
        const baseUrl = `${_req.protocol}://${_req.get('host')}`;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SicariusGuard — Solana Token Safety Oracle</title>
<meta name="description" content="Real-time token safety analysis for AI agents and trading bots. 7-layer inspection with Birdeye market intelligence and Helius wallet reputation.">
<meta property="og:type" content="website">
<meta property="og:title" content="SicariusGuard — Solana Token Safety Oracle">
<meta property="og:description" content="7-layer token safety analysis for AI agents. Byte-level SPL inspection, Birdeye market intel, Helius wallet reputation. x402 pay-per-call.">
<meta property="og:url" content="${baseUrl}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="SicariusGuard — Solana Token Safety Oracle">
<meta name="twitter:description" content="7-layer token safety for AI agents. Birdeye + Helius + x402 micropayments.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#0a0a0f;--surface:#12121a;--border:#1e1e2e;--accent:#6c5ce7;--accent2:#a29bfe;--green:#00b894;--red:#ff6b6b;--yellow:#fdcb6e;--text:#e0e0e0;--muted:#8888a0;--mono:'JetBrains Mono',monospace}
body{font-family:'Inter',sans-serif;background:var(--bg);color:var(--text);line-height:1.6;min-height:100vh}
.container{max-width:900px;margin:0 auto;padding:2rem 1.5rem}
header{text-align:center;padding:3rem 0 2rem;border-bottom:1px solid var(--border)}
h1{font-size:2.2rem;font-weight:700;margin-bottom:.5rem}
h1 span{background:linear-gradient(135deg,var(--accent),var(--accent2));-webkit-background-clip:text;-webkit-text-fill-color:transparent}
.tagline{color:var(--muted);font-size:1.05rem;margin-bottom:1.5rem}
.badge{display:inline-block;background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:.3rem .8rem;font-size:.8rem;color:var(--green);font-family:var(--mono);margin:.2rem}
.try-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:1.2rem;margin:2rem 0;position:relative}
.try-box label{font-size:.75rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;display:block;margin-bottom:.5rem}
.try-box code{font-family:var(--mono);font-size:.85rem;color:var(--accent2);word-break:break-all}
.try-box a{color:var(--accent2);text-decoration:none}
.try-box a:hover{text-decoration:underline}
section{padding:2rem 0;border-bottom:1px solid var(--border)}
h2{font-size:1.3rem;font-weight:600;margin-bottom:1rem;color:#fff}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;padding:.6rem .8rem;background:var(--surface);color:var(--muted);font-weight:500;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid var(--border)}
td{padding:.6rem .8rem;border-bottom:1px solid var(--border)}
td code{font-family:var(--mono);font-size:.82rem;color:var(--accent2)}
.method{font-family:var(--mono);font-size:.75rem;font-weight:600;padding:.15rem .4rem;border-radius:4px;background:#1a3a2a;color:var(--green)}
.layers{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:.8rem;margin-top:1rem}
.layer{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:.8rem 1rem}
.layer strong{color:#fff;font-size:.9rem}
.layer p{color:var(--muted);font-size:.82rem;margin-top:.25rem}
.scoring{font-family:var(--mono);font-size:.85rem;background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:1rem;margin-top:1rem}
.tier-row{display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)}
.tier-row:last-child{border:none}
footer{text-align:center;padding:2rem 0;color:var(--muted);font-size:.85rem}
footer a{color:var(--accent2);text-decoration:none}
.pulse{display:inline-block;width:8px;height:8px;background:var(--green);border-radius:50%;margin-right:6px;animation:pulse 2s ease infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
@media(max-width:600px){h1{font-size:1.6rem}.layers{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🛡️ <span>SicariusGuard</span></h1>
  <p class="tagline">Solana Token Safety Oracle for AI Agents &amp; Trading Bots</p>
  <div>
    <span class="badge"><span class="pulse"></span>Live on Mainnet</span>
    <span class="badge">x402 Payments</span>
    <span class="badge">MCP Server</span>
    <span class="badge">100 Free/Day</span>
  </div>
</header>

<div class="try-box">
  <label>Scan any Solana token — no auth required</label>
  <div style="display:flex;gap:.5rem;margin-top:.5rem">
    <input id="mint-input" type="text" placeholder="Paste a Solana mint address..." value="DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" style="flex:1;font-family:var(--mono);font-size:.82rem;padding:.5rem .75rem;background:var(--bg);border:1px solid var(--border);border-radius:6px;color:var(--text);outline:none" onfocus="this.select()">
    <button onclick="scanToken()" style="font-family:'Inter',sans-serif;font-weight:600;font-size:.85rem;padding:.5rem 1.2rem;background:linear-gradient(135deg,var(--accent),var(--accent2));color:#fff;border:none;border-radius:6px;cursor:pointer">Scan →</button>
  </div>
  <div id="scan-result" style="margin-top:.75rem;font-size:.82rem;color:var(--muted)">Click Scan or press Enter to analyze a token</div>
</div>

<section>
  <h2>7-Layer Safety Analysis</h2>
  <div class="layers">
    <div class="layer"><strong>🔓 Mint Authority</strong><p>Raw SPL byte inspection — can deployer print tokens?</p></div>
    <div class="layer"><strong>🧊 Freeze Authority</strong><p>SPL offset 46 — can deployer freeze wallets?</p></div>
    <div class="layer"><strong>⚠️ Token-2022</strong><p>Extension scan — PermanentDelegate, TransferHook</p></div>
    <div class="layer"><strong>🍯 Honeypot</strong><p>Jupiter sell simulation — can you actually sell?</p></div>
    <div class="layer"><strong>📊 Holders</strong><p>Concentration analysis — top wallets vs supply</p></div>
    <div class="layer"><strong>📈 Market Intel</strong><p>Birdeye API — liquidity, volume, wash trading</p></div>
    <div class="layer"><strong>🔎 Wallet Rep</strong><p>Helius Identity — deployer funding chain analysis</p></div>
  </div>

  <div class="scoring">
    finalScore = (onChain × 0.60) + (market × 0.25) + (reputation × 0.15)<br>
    <span style="color:var(--green)">0 SAFE</span> · <span style="color:var(--yellow)">1-15 CAUTION</span> · <span style="color:var(--red)">16-50 HIGH_RISK</span> · <span style="color:#ff4444">51-100 CRITICAL</span>
  </div>
</section>

<section>
  <h2>API Endpoints</h2>
  <table>
    <tr><th>Method</th><th>Endpoint</th><th>Description</th></tr>
    <tr><td><span class="method">GET</span></td><td><code><a href="${baseUrl}/v1/check/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263">/v1/check/:mint</a></code></td><td>On-chain safety analysis</td></tr>
    <tr><td><span class="method">GET</span></td><td><code><a href="${baseUrl}/v1/scan/DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263">/v1/scan/:mint</a></code></td><td>Full scan + Birdeye + Helius</td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/v1/honeypot</code></td><td>Honeypot detection (Jupiter sim)</td></tr>
    <tr><td><span class="method">POST</span></td><td><code>/v1/holders</code></td><td>Holder concentration analysis</td></tr>
    <tr><td><span class="method">GET</span></td><td><code><a href="${baseUrl}/v1/pricing">/v1/pricing</a></code></td><td>x402 payment pricing</td></tr>
    <tr><td><span class="method">GET</span></td><td><code><a href="${baseUrl}/health">/health</a></code></td><td>Service health check</td></tr>
  </table>
</section>

<section>
  <h2>Access Tiers</h2>
  <table>
    <tr><th>Tier</th><th>Auth</th><th>Limit</th></tr>
    <tr><td>Free</td><td>None</td><td>100 calls/day per IP</td></tr>
    <tr><td>x402</td><td><code>X-PAYMENT</code> header</td><td>Unlimited — pay per call in SOL</td></tr>
  </table>
</section>

<section>
  <h2>x402 Payment Protocol</h2>
  <div class="scoring">
    1. GET /v1/pricing → see SOL prices + treasury address<br>
    2. Send SOL to treasury wallet on Solana mainnet<br>
    3. Retry request with <code>X-PAYMENT: &lt;tx_signature&gt;</code><br>
    4. Server verifies on-chain → returns data
  </div>
  <table style="margin-top:1rem">
    <tr><th>Endpoint</th><th>Price (SOL)</th></tr>
    <tr><td><code>/v1/check</code></td><td>0.001</td></tr>
    <tr><td><code>/v1/scan</code></td><td>0.002</td></tr>
    <tr><td><code>/v1/honeypot</code></td><td>0.0005</td></tr>
    <tr><td><code>/v1/holders</code></td><td>0.0005</td></tr>
  </table>
</section>

<footer>
  <p>Built by <a href="https://github.com/Chronolapse411">@Chronolapse411</a> · <a href="https://github.com/Chronolapse411/sicarius-guard">GitHub</a></p>
</footer>
</div>
<script>
document.getElementById('mint-input').addEventListener('keydown',e=>{if(e.key==='Enter')scanToken()});
async function scanToken(){
  const mint=document.getElementById('mint-input').value.trim();
  const out=document.getElementById('scan-result');
  if(!mint||mint.length<32){out.textContent='Enter a valid Solana mint address';return}
  out.innerHTML='<span style="color:var(--accent2)">Scanning...</span>';
  try{
    const r=await fetch('/v1/scan/'+mint);
    const d=await r.json();
    if(d.combined){
      const c=d.combined;
      const color=c.verdict==='SAFE'?'var(--green)':c.verdict==='CAUTION'?'var(--yellow)':'var(--red)';
      out.innerHTML=\`<span style="color:\${color};font-weight:600;font-size:1rem">\${c.verdict}</span> <span style="color:var(--muted)">Score: \${c.finalScore ?? c.riskScore}/100</span><br><span style="color:var(--text);font-size:.8rem">\${c.summary}</span>\`;
    } else if(d.error){
      out.innerHTML='<span style="color:var(--red)">'+d.error+': '+(d.message||'')+'</span>';
    }
  }catch(e){out.innerHTML='<span style="color:var(--red)">Request failed: '+e.message+'</span>'}
}
</script>
</body>
</html>`);
    });

    // Payment stats endpoint (no auth)
    app.get('/x402/stats', (_req, res) => {
        res.json({
            protocol: 'x402',
            ...getPaymentStats(),
            pricing: getPricing(),
        });
    });

    // All /v1/* endpoints: try API key auth first, then x402 payment
    app.use('/v1', authMiddleware);
    app.use('/v1', x402PaymentMiddleware);

    // Pricing endpoint (no auth required)
    app.get('/v1/pricing', (_req, res) => {
        res.json({
            protocol: 'x402',
            network: 'solana',
            currency: 'SOL',
            pricing: getPricing(),
            instructions: 'Send SOL to the recipient address, then include the tx signature in the X-PAYMENT header. Or use a free API key via x-api-key header.',
        });
    });

    // ── POST /v1/check — Full analysis ───────────────────────────────────────
    app.post('/v1/check', async (req, res) => {
        try {
            const { mint, txSignature, isPumpSwap } = req.body as {
                mint?: unknown;
                txSignature?: string;
                isPumpSwap?: boolean;
            };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address', message: 'Provide a valid Solana mint address' });
                return;
            }

            // Check cache
            const cached = fullCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            // Fetch tx if signature provided
            let txInfo: unknown = undefined;
            if (txSignature) {
                try {
                    txInfo = await connection.getParsedTransaction(txSignature, {
                        maxSupportedTransactionVersion: 0,
                    });
                } catch { /* best-effort */ }
            }

            // Run all checks in parallel
            const [safety, honeypot, holders] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
            ]);

            // Combine scores
            let combinedScore = safety.riskScore;
            if (honeypot.isHoneypot) combinedScore = Math.min(combinedScore + 30, 100);
            if (holders.concentrated) combinedScore = Math.min(combinedScore + 15, 100);

            const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated;
            const verdict = combinedScore === 0 ? 'SAFE'
                : combinedScore <= 15 ? 'CAUTION'
                : combinedScore <= 50 ? 'HIGH_RISK'
                : 'CRITICAL';

            const summaryParts: string[] = [];
            if (!safety.safe) summaryParts.push(safety.reason);
            if (honeypot.isHoneypot) summaryParts.push('Honeypot detected');
            if (holders.concentrated) summaryParts.push(holders.reason);

            const result: FullCheckResult = {
                safety,
                honeypot,
                holders,
                combined: {
                    safe: combinedSafe,
                    riskScore: combinedScore,
                    verdict,
                    summary: combinedSafe ? 'All checks passed' : summaryParts.join('; '),
                },
            };

            fullCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[API] /v1/check error:', msg);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── GET /v1/check/:mint — Convenience GET ────────────────────────────────
    app.get('/v1/check/:mint', async (req, res) => {
        const { mint } = req.params;

        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }

        // Check cache
        const cached = fullCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }

        const [safety, honeypot, holders] = await Promise.all([
            analyzeTokenSafety(connection, mint),
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

        const result: FullCheckResult = {
            safety,
            honeypot,
            holders,
            combined: {
                safe: combinedSafe,
                riskScore: combinedScore,
                verdict,
                summary: combinedSafe ? 'All checks passed' : [
                    !safety.safe ? safety.reason : '',
                    honeypot.isHoneypot ? 'Honeypot detected' : '',
                    holders.concentrated ? holders.reason : '',
                ].filter(Boolean).join('; '),
            },
        };

        fullCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    // ── POST /v1/honeypot — Honeypot-only check ──────────────────────────────
    app.post('/v1/honeypot', async (req, res) => {
        try {
            const { mint, amount } = req.body as { mint?: unknown; amount?: string };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            const cached = honeypotCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            const result = await checkHoneypot(mint, amount);
            honeypotCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── POST /v1/holders — Holder concentration check ────────────────────────
    app.post('/v1/holders', async (req, res) => {
        try {
            const { mint } = req.body as { mint?: unknown };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            const cached = holderCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            const result = await analyzeHolders(connection, mint);
            holderCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── POST /v1/scan — Full analysis + Birdeye enrichment ────────────────────
    app.post('/v1/scan', async (req, res) => {
        try {
            const { mint, txSignature, isPumpSwap } = req.body as {
                mint?: unknown;
                txSignature?: string;
                isPumpSwap?: boolean;
            };

            if (!isValidMint(mint)) {
                res.status(400).json({ error: 'Invalid mint address' });
                return;
            }

            // Check cache
            const cached = scanCache.get(mint);
            if (cached) {
                res.json({ ...cached, cached: true });
                return;
            }

            // Fetch tx if provided
            let txInfo: unknown = undefined;
            if (txSignature) {
                try {
                    txInfo = await connection.getParsedTransaction(txSignature, {
                        maxSupportedTransactionVersion: 0,
                    });
                } catch { /* best-effort */ }
            }

            // Run ALL checks in parallel — on-chain + Birdeye + Helius Wallet Intel
            const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
                enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                enrichCreatorReputation(mint, HELIUS_API_KEY),  // Look up mint in Orb identity DB
            ]);

            // Combine on-chain score
            let onChainScore = safety.riskScore;
            if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
            if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

            // Reputation score from Helius wallet intelligence
            const reputationScore = walletIntel.reputation?.riskScore ?? 0;

            // Weighted final score: 60% on-chain, 25% market data, 15% reputation
            const marketScore = birdeye.marketRisk.score;
            const finalScore = Math.round(
                onChainScore * 0.60 +
                marketScore * 0.25 +
                reputationScore * 0.15
            );

            const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated
                && marketScore < 30 && reputationScore < 30;

            const verdict = finalScore === 0 ? 'SAFE'
                : finalScore <= 15 ? 'CAUTION'
                : finalScore <= 50 ? 'HIGH_RISK'
                : 'CRITICAL';

            const summaryParts: string[] = [];
            if (!safety.safe) summaryParts.push(safety.reason);
            if (honeypot.isHoneypot) summaryParts.push('Honeypot detected');
            if (holders.concentrated) summaryParts.push(holders.reason);
            if (birdeye.marketRisk.flags.length > 0) {
                summaryParts.push(`Market flags: ${birdeye.marketRisk.flags.join(', ')}`);
            }
            if (walletIntel.reputation && walletIntel.reputation.flags.length > 0) {
                summaryParts.push(`Reputation: ${walletIntel.reputation.flags.join(', ')}`);
            }

            const result: FullScanResult = {
                safety,
                honeypot,
                holders,
                birdeye,
                walletIntel,
                combined: {
                    safe: combinedSafe,
                    riskScore: onChainScore,
                    marketRiskScore: marketScore,
                    reputationScore,
                    finalScore,
                    verdict,
                    summary: combinedSafe ? 'All checks passed — token appears safe' : summaryParts.join('; '),
                },
            };

            scanCache.set(mint, result);
            res.json({ ...result, cached: false });

        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[API] /v1/scan error:', msg);
            res.status(500).json({ error: 'Internal server error', message: msg });
        }
    });

    // ── GET /v1/scan/:mint — Convenience GET for scan ────────────────────────
    app.get('/v1/scan/:mint', async (req, res) => {
        const { mint } = req.params;

        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }

        const cached = scanCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }

        const [safety, honeypot, holders, birdeye, walletIntel] = await Promise.all([
            analyzeTokenSafety(connection, mint),
            checkHoneypot(mint),
            analyzeHolders(connection, mint),
            enrichWithBirdeye(mint, BIRDEYE_API_KEY),
            enrichCreatorReputation(mint, HELIUS_API_KEY),
        ]);

        let onChainScore = safety.riskScore;
        if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
        if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

        const reputationScore = walletIntel.reputation?.riskScore ?? 0;
        const marketScore = birdeye.marketRisk.score;
        const finalScore = Math.round(
            onChainScore * 0.60 +
            marketScore * 0.25 +
            reputationScore * 0.15
        );
        const combinedSafe = safety.safe && !honeypot.isHoneypot && !holders.concentrated
            && marketScore < 30 && reputationScore < 30;

        const verdict = finalScore === 0 ? 'SAFE'
            : finalScore <= 15 ? 'CAUTION'
            : finalScore <= 50 ? 'HIGH_RISK'
            : 'CRITICAL';

        const result: FullScanResult = {
            safety,
            honeypot,
            holders,
            birdeye,
            walletIntel,
            combined: {
                safe: combinedSafe,
                riskScore: onChainScore,
                marketRiskScore: marketScore,
                reputationScore,
                finalScore,
                verdict,
                summary: combinedSafe ? 'All checks passed — token appears safe' : [
                    !safety.safe ? safety.reason : '',
                    honeypot.isHoneypot ? 'Honeypot detected' : '',
                    holders.concentrated ? holders.reason : '',
                    birdeye.marketRisk.flags.length > 0 ? `Market: ${birdeye.marketRisk.flags.join(', ')}` : '',
                    walletIntel.reputation?.flags.length ? `Reputation: ${walletIntel.reputation.flags.join(', ')}` : '',
                ].filter(Boolean).join('; '),
            },
        };

        scanCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    return app;
}

// ── Start Server ─────────────────────────────────────────────────────────────

export function startServer(): void {
    const app = createApp();

    // Periodic cleanup of rate limit entries + payment cache
    setInterval(cleanupRateLimits, 60_000);
    setInterval(cleanupPaymentCache, 120_000);

    app.listen(PORT, HOST, () => {
        console.log(`
╔══════════════════════════════════════════════════════════╗
║                                                          ║
║   🛡️  SicariusGuard — Token Safety API                   ║
║                                                          ║
║   Server:    http://${HOST}:${PORT}                       ║
║   Health:    http://${HOST}:${PORT}/health                ║
║   Pricing:   http://${HOST}:${PORT}/v1/pricing           ║
║   x402:      http://${HOST}:${PORT}/x402/stats           ║
║   Docs:      POST /v1/check  { "mint": "..." }           ║
║   Payment:   x402 SOL → ${process.env.TREASURY_WALLET?.slice(0, 20) ?? 'not set'}...   ║
║   RPC:       ${RPC_URL.slice(0, 45)}...                  ║
║   Cache TTL: ${CACHE_TTL}s                               ║
║                                                          ║
╚══════════════════════════════════════════════════════════╝
        `.trim());
    });
}

