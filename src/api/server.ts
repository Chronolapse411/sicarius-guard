/**
 * SicariusGuard — Express REST API Server
 *
 * v1.1.0: 11-layer analysis engine — adds LP lock detection,
 * token age analysis, unified composite scoring, deployer recon,
 * and NFT intelligence (Magic Eden + DAS).
 *
 * Endpoints:
 *   POST /v1/check          — full token safety analysis
 *   POST /v1/honeypot       — honeypot-only check (Jupiter sell sim)
 *   POST /v1/holders        — holder concentration analysis
 *   GET  /v1/check/:mint    — convenience GET for simple checks
 *   GET  /v1/lp-lock/:mint  — LP lock status check
 *   GET  /v1/token-age/:mint — token age check
 *   GET  /v1/deployer/:address — deployer reconnaissance
 *   GET  /v1/nft-check/:mint — NFT safety check (ME + DAS)
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
import { analyzeLpLock, type LpLockResult } from '../core/lp_lock.js';
import { analyzeTokenAge, type TokenAgeResult } from '../core/token_age.js';
import { reconDeployer, type DeployerDossier } from '../core/deployer_recon.js';
import { analyzeNft, type NftCheckResult } from '../core/nft_intel.js';
import {
    computeCompositeScore,
    buildLightweightLayers,
    buildFullLayers,
    buildSummary,
    LIGHTWEIGHT_WEIGHTS,
    DEFAULT_WEIGHTS,
    type LayerScores,
} from '../core/scoring.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface FullCheckResult {
    safety:   SafetyResult;
    honeypot: HoneypotResult;
    holders:  HolderResult;
    lpLock:   LpLockResult;
    tokenAge: TokenAgeResult;
    combined: {
        safe:      boolean;
        riskScore: number;
        verdict:   string;
        summary:   string;
        breakdown: LayerScores;
    };
}

interface FullScanResult {
    safety:    SafetyResult;
    honeypot:  HoneypotResult;
    holders:   HolderResult;
    lpLock:    LpLockResult;
    tokenAge:  TokenAgeResult;
    birdeye:   BirdeyeEnrichment;
    walletIntel: WalletIntelligence;
    deployerRecon: DeployerDossier | null;
    combined:  {
        safe:           boolean;
        riskScore:      number;
        marketRiskScore: number;
        reputationScore: number;
        finalScore:     number;
        verdict:        string;
        summary:        string;
        breakdown:      LayerScores;
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
const lpLockCache   = new ResultCache<LpLockResult>(CACHE_TTL);
const tokenAgeCache   = new ResultCache<TokenAgeResult>(CACHE_TTL);
const reconCache      = new ResultCache<DeployerDossier>(CACHE_TTL);
const fullCache       = new ResultCache<FullCheckResult>(CACHE_TTL);
const scanCache       = new ResultCache<FullScanResult>(CACHE_TTL);
const nftCache        = new ResultCache<NftCheckResult>(CACHE_TTL);

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
            version: '1.1.0',
            uptime: process.uptime(),
            cacheSize: {
                safety: safetyCache.size(),
                honeypot: honeypotCache.size(),
                holders: holderCache.size(),
                lpLock: lpLockCache.size(),
                tokenAge: tokenAgeCache.size(),
                nftCheck: nftCache.size(),
                full: fullCache.size(),
            },
        });
    });

    // Favicon — return 204 to prevent crawler 404s
    app.get('/favicon.ico', (_req, res) => res.status(204).end());

    // robots.txt for search engine crawlers
    app.get('/robots.txt', (_req, res) => {
        res.type('text/plain').send([
            'User-agent: *',
            'Allow: /',
            'Disallow: /v1/',
            '',
            `Sitemap: ${_req.protocol}://${_req.get('host')}/sitemap.xml`,
        ].join('\n'));
    });

    // Sitemap for search engine indexing
    app.get('/sitemap.xml', (_req, res) => {
        const base = `${_req.protocol}://${_req.get('host')}`;
        res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${base}/health</loc><changefreq>always</changefreq><priority>0.5</priority></url>
  <url><loc>${base}/v1/pricing</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>
</urlset>`);
    });

    // MCP Server Card for Smithery/registry discovery
    app.get('/.well-known/mcp/server-card.json', (_req, res) => {
        res.json({
            name: 'sicarius-guard',
            version: '1.1.0',
            description: 'Solana Token Safety Oracle — 10-layer rug pull, honeypot, LP lock, and market risk analysis for AI agents and trading bots.',
            homepage: 'https://github.com/Chronolapse411/sicarius-guard',
            author: 'Chronolapse411',
            capabilities: {
                tools: true,
                resources: false,
                prompts: false,
            },
            tools: [
                { name: 'check_token_safety', description: 'Analyze a Solana SPL token for rug pull, honeypot, and safety risks. 8 checks with combined risk score. Read-only, no side effects.' },
                { name: 'check_honeypot', description: 'Simulate a sell via Jupiter DEX to detect honeypot tokens. Zero cost, quote-only, no gas.' },
                { name: 'check_holder_concentration', description: 'Analyze token holder distribution for rug pull indicators. Flags top-heavy supply concentration.' },
                { name: 'check_lp_lock', description: 'Check LP burn status and locker detection for Raydium pools.' },
                { name: 'check_token_age', description: 'Determine token creation timestamp and age category.' },
                { name: 'full_token_scan', description: 'Comprehensive 10-layer safety analysis: on-chain + LP lock + token age + Birdeye market intel + Helius wallet reputation.' },
                { name: 'get_wallet_reputation', description: 'Investigate wallet reputation via Helius DAS identity data and funding chain analysis.' },
                { name: 'get_market_intel', description: 'Real-time market data from Birdeye (price, volume, liquidity, market risk flags).' },
                { name: 'batch_scan', description: 'Scan up to 10 tokens in parallel for portfolio-level risk assessment. Full 10-layer analysis each.' },
            ],
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
  <h2>10-Layer Safety Analysis</h2>
  <div class="layers">
    <div class="layer"><strong>🔓 Mint Authority</strong><p>Raw SPL byte inspection — can deployer print tokens?</p></div>
    <div class="layer"><strong>🧊 Freeze Authority</strong><p>SPL offset 46 — can deployer freeze wallets?</p></div>
    <div class="layer"><strong>⚠️ Token-2022</strong><p>Extension scan — PermanentDelegate, TransferHook</p></div>
    <div class="layer"><strong>🍯 Honeypot</strong><p>Jupiter sell simulation — can you actually sell?</p></div>
    <div class="layer"><strong>📊 Holders</strong><p>Concentration analysis — top wallets vs supply</p></div>
    <div class="layer"><strong>🔒 LP Lock</strong><p>Raydium pool decode — LP burned or in locker?</p></div>
    <div class="layer"><strong>⏰ Token Age</strong><p>Creation timestamp — newborn, young, or mature?</p></div>
    <div class="layer"><strong>📈 Market Intel</strong><p>Birdeye API — liquidity, volume, wash trading</p></div>
    <div class="layer"><strong>🔎 Wallet Rep</strong><p>Helius Identity — deployer funding chain analysis</p></div>
  </div>

  <div class="scoring">
    finalScore = (onChain × 0.45) + (lpLock × 0.15) + (age × 0.05) + (market × 0.22) + (rep × 0.13)<br>
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
            const [safety, honeypot, holders, lpLock, tokenAge] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
                analyzeLpLock(connection, mint),
                analyzeTokenAge(connection, mint),
            ]);

            // Build on-chain sub-score
            let onChainScore = safety.riskScore;
            if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
            if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

            const layers = buildLightweightLayers(onChainScore, lpLock.riskScore, tokenAge.riskScore);
            const composite = computeCompositeScore(layers, LIGHTWEIGHT_WEIGHTS);
            const summary = buildSummary(composite, {
                safetyReason: !safety.safe ? safety.reason : undefined,
                honeypotDetected: honeypot.isHoneypot,
                holderReason: holders.concentrated ? holders.reason : undefined,
                lpFlags: lpLock.flags,
                ageFlags: tokenAge.flags,
            });

            const result: FullCheckResult = {
                safety,
                honeypot,
                holders,
                lpLock,
                tokenAge,
                combined: {
                    safe: composite.safe,
                    riskScore: composite.finalScore,
                    verdict: composite.verdict,
                    summary,
                    breakdown: composite.breakdown,
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

        const [safety, honeypot, holders, lpLock, tokenAge] = await Promise.all([
            analyzeTokenSafety(connection, mint),
            checkHoneypot(mint),
            analyzeHolders(connection, mint),
            analyzeLpLock(connection, mint),
            analyzeTokenAge(connection, mint),
        ]);

        let onChainScore = safety.riskScore;
        if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
        if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

        const layers = buildLightweightLayers(onChainScore, lpLock.riskScore, tokenAge.riskScore);
        const composite = computeCompositeScore(layers, LIGHTWEIGHT_WEIGHTS);
        const summary = buildSummary(composite, {
            safetyReason: !safety.safe ? safety.reason : undefined,
            honeypotDetected: honeypot.isHoneypot,
            holderReason: holders.concentrated ? holders.reason : undefined,
            lpFlags: lpLock.flags,
            ageFlags: tokenAge.flags,
        });

        const result: FullCheckResult = {
            safety,
            honeypot,
            holders,
            lpLock,
            tokenAge,
            combined: {
                safe: composite.safe,
                riskScore: composite.finalScore,
                verdict: composite.verdict,
                summary,
                breakdown: composite.breakdown,
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

            // Run ALL checks in parallel — on-chain + LP + age + Birdeye + Helius
            const [safety, honeypot, holders, birdeye, walletIntel, lpLock, tokenAge] = await Promise.all([
                analyzeTokenSafety(connection, mint, txInfo, isPumpSwap ?? false),
                checkHoneypot(mint),
                analyzeHolders(connection, mint),
                enrichWithBirdeye(mint, BIRDEYE_API_KEY),
                enrichCreatorReputation(mint, HELIUS_API_KEY),
                analyzeLpLock(connection, mint),
                analyzeTokenAge(connection, mint),
            ]);

            // Build on-chain sub-score
            let onChainScore = safety.riskScore;
            if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
            if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

            const reputationScore = walletIntel.reputation?.riskScore ?? 0;
            const layers = buildFullLayers(
                onChainScore, lpLock.riskScore, tokenAge.riskScore,
                birdeye.marketRisk.score, reputationScore,
            );
            const composite = computeCompositeScore(layers, DEFAULT_WEIGHTS);
            const summary = buildSummary(composite, {
                safetyReason: !safety.safe ? safety.reason : undefined,
                honeypotDetected: honeypot.isHoneypot,
                holderReason: holders.concentrated ? holders.reason : undefined,
                lpFlags: lpLock.flags,
                ageFlags: tokenAge.flags,
                marketFlags: birdeye.marketRisk.flags,
                reputationFlags: walletIntel.reputation?.flags,
            });

            // Deployer recon — use poolCreator from LP lock if available
            let deployerRecon: DeployerDossier | null = null;
            const deployerAddr = lpLock.poolCreator ?? null;
            if (deployerAddr) {
                const cachedRecon = reconCache.get(deployerAddr);
                if (cachedRecon) {
                    deployerRecon = cachedRecon;
                } else {
                    try {
                        deployerRecon = await reconDeployer(deployerAddr);
                        reconCache.set(deployerAddr, deployerRecon);
                    } catch { /* non-fatal — recon is best-effort enrichment */ }
                }
            }

            const result: FullScanResult = {
                safety,
                honeypot,
                holders,
                lpLock,
                tokenAge,
                birdeye,
                walletIntel,
                deployerRecon,
                combined: {
                    safe: composite.safe,
                    riskScore: onChainScore,
                    marketRiskScore: birdeye.marketRisk.score,
                    reputationScore,
                    finalScore: composite.finalScore,
                    verdict: composite.verdict,
                    summary,
                    breakdown: composite.breakdown,
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

        const [safety, honeypot, holders, birdeye, walletIntel, lpLock, tokenAge] = await Promise.all([
            analyzeTokenSafety(connection, mint),
            checkHoneypot(mint),
            analyzeHolders(connection, mint),
            enrichWithBirdeye(mint, BIRDEYE_API_KEY),
            enrichCreatorReputation(mint, HELIUS_API_KEY),
            analyzeLpLock(connection, mint),
            analyzeTokenAge(connection, mint),
        ]);

        let onChainScore = safety.riskScore;
        if (honeypot.isHoneypot) onChainScore = Math.min(onChainScore + 30, 100);
        if (holders.concentrated) onChainScore = Math.min(onChainScore + 15, 100);

        const reputationScore = walletIntel.reputation?.riskScore ?? 0;
        const layers = buildFullLayers(
            onChainScore, lpLock.riskScore, tokenAge.riskScore,
            birdeye.marketRisk.score, reputationScore,
        );
        const composite = computeCompositeScore(layers, DEFAULT_WEIGHTS);
        const summary = buildSummary(composite, {
            safetyReason: !safety.safe ? safety.reason : undefined,
            honeypotDetected: honeypot.isHoneypot,
            holderReason: holders.concentrated ? holders.reason : undefined,
            lpFlags: lpLock.flags,
            ageFlags: tokenAge.flags,
            marketFlags: birdeye.marketRisk.flags,
            reputationFlags: walletIntel.reputation?.flags,
        });

        // Deployer recon — use poolCreator from LP lock if available
        let deployerRecon: DeployerDossier | null = null;
        const deployerAddr = lpLock.poolCreator ?? null;
        if (deployerAddr) {
            const cachedRecon = reconCache.get(deployerAddr);
            if (cachedRecon) {
                deployerRecon = cachedRecon;
            } else {
                try {
                    deployerRecon = await reconDeployer(deployerAddr);
                    reconCache.set(deployerAddr, deployerRecon);
                } catch { /* non-fatal */ }
            }
        }

        const result: FullScanResult = {
            safety,
            honeypot,
            holders,
            lpLock,
            tokenAge,
            birdeye,
            walletIntel,
            deployerRecon,
            combined: {
                safe: composite.safe,
                riskScore: onChainScore,
                marketRiskScore: birdeye.marketRisk.score,
                reputationScore,
                finalScore: composite.finalScore,
                verdict: composite.verdict,
                summary,
                breakdown: composite.breakdown,
            },
        };

        scanCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    // ── GET /v1/lp-lock/:mint — Standalone LP lock check ─────────────────────
    app.get('/v1/lp-lock/:mint', async (req, res) => {
        const { mint } = req.params;
        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }
        const cached = lpLockCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }
        const result = await analyzeLpLock(connection, mint);
        lpLockCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    // ── GET /v1/token-age/:mint — Standalone token age check ─────────────────
    app.get('/v1/token-age/:mint', async (req, res) => {
        const { mint } = req.params;
        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }
        const cached = tokenAgeCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }
        const result = await analyzeTokenAge(connection, mint);
        tokenAgeCache.set(mint, result);
        res.json({ ...result, cached: false });
    });

    // ── GET /v1/deployer/:address — Standalone deployer reconnaissance ───────
    app.get('/v1/deployer/:address', async (req, res) => {
        const { address } = req.params;
        if (!isValidMint(address)) {
            res.status(400).json({ error: 'Invalid wallet address' });
            return;
        }
        const cached = reconCache.get(address);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }
        try {
            const dossier = await reconDeployer(address);
            reconCache.set(address, dossier);
            res.json({ ...dossier, cached: false });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'Deployer recon failed', message: msg });
        }
    });

    // ── GET /v1/nft-check/:mint — NFT safety check (ME + DAS) ────────────
    app.get('/v1/nft-check/:mint', async (req, res) => {
        const { mint } = req.params;
        if (!isValidMint(mint)) {
            res.status(400).json({ error: 'Invalid mint address' });
            return;
        }
        const cached = nftCache.get(mint);
        if (cached) {
            res.json({ ...cached, cached: true });
            return;
        }
        try {
            const result = await analyzeNft(mint);
            nftCache.set(mint, result);
            res.json({ ...result, cached: false });
        } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            res.status(500).json({ error: 'NFT analysis failed', message: msg });
        }
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

