/**
 * SicariusGuard — Unified Composite Risk Scoring Engine
 *
 * Centralizes all risk score computation into a single module.
 * Eliminates the 6x score duplication across MCP and API servers.
 *
 * Architecture:
 *   Each analysis layer produces an independent 0-100 score.
 *   This engine applies configurable weights to produce a single
 *   `finalScore` and categorical verdict.
 *
 * Weight rationale:
 *   - On-chain (0.45): Hardest signals — authority flags, extensions, honeypot, holders
 *   - LP Lock  (0.15): #1 rug mechanism — unlocked liquidity = pullable
 *   - Market   (0.22): Volume, liquidity depth, wash trading detection
 *   - Reputation (0.13): Deployer wallet age, funding chain, identity
 *   - Token Age (0.05): Soft signal — newer tokens slightly riskier
 *
 * @author Chronolapse411
 * @version 1.0.0
 */

// ── Public Types ─────────────────────────────────────────────────────────────

/** Individual scores from each analysis layer, all 0-100. */
export interface LayerScores {
    onChain:     number;
    lpLock:      number;
    tokenAge:    number;
    market:      number;
    reputation:  number;
}

/** Weight configuration for composite scoring. Values must sum to 1.0. */
export interface ScoringWeights {
    onChain:     number;
    lpLock:      number;
    tokenAge:    number;
    market:      number;
    reputation:  number;
}

/** Final composite risk assessment. */
export interface CompositeScore {
    finalScore:  number;
    verdict:     Verdict;
    safe:        boolean;
    breakdown:   LayerScores;
    weights:     ScoringWeights;
    layerCount:  number;
}

export type Verdict = 'SAFE' | 'CAUTION' | 'HIGH_RISK' | 'CRITICAL';

// ── Default Configuration ────────────────────────────────────────────────────

/**
 * Default weights for the 10-layer scan.
 * These can be overridden per-call for experimentation.
 */
export const DEFAULT_WEIGHTS: ScoringWeights = {
    onChain:    0.45,
    lpLock:     0.15,
    tokenAge:   0.05,
    market:     0.22,
    reputation: 0.13,
};

/**
 * Reduced weights for the lightweight scan (no Birdeye/Helius).
 * Redistributes market/reputation weight across available layers.
 */
export const LIGHTWEIGHT_WEIGHTS: ScoringWeights = {
    onChain:    0.60,
    lpLock:     0.20,
    tokenAge:   0.08,
    market:     0.00,
    reputation: 0.12,
};

// ── Verdict Thresholds ───────────────────────────────────────────────────────

/**
 * Map a 0-100 score to a categorical verdict.
 *
 * 0       → SAFE       — all checks passed, no issues detected
 * 1-15    → CAUTION    — minor flags, probably fine but be aware
 * 16-50   → HIGH_RISK  — significant red flags, proceed with extreme caution
 * 51-100  → CRITICAL   — do not interact, probable rug/scam
 */
function resolveVerdict(score: number): Verdict {
    if (score === 0) return 'SAFE';
    if (score <= 15) return 'CAUTION';
    if (score <= 50) return 'HIGH_RISK';
    return 'CRITICAL';
}

/**
 * Determine if the token should be considered safe based on
 * both the composite score AND individual layer thresholds.
 *
 * A token is "safe" only when ALL layers are clean — even if the
 * weighted score is low, a single critical layer can flip this.
 */
function resolveSafety(layers: LayerScores, finalScore: number): boolean {
    // Hard safety gates — any single high-risk layer blocks safe status
    if (layers.onChain > 25) return false;
    if (layers.lpLock >= 20) return false;
    if (layers.market >= 30) return false;
    if (layers.reputation >= 30) return false;

    // Composite gate
    return finalScore <= 15;
}

// ── Core Scoring Function ────────────────────────────────────────────────────

/**
 * Compute the final composite risk score from individual layer scores.
 *
 * @param layers   Individual 0-100 scores from each analysis layer
 * @param weights  Optional weight overrides (must sum to ~1.0)
 * @returns        CompositeScore with verdict, safety flag, and breakdown
 */
export function computeCompositeScore(
    layers: LayerScores,
    weights: ScoringWeights = DEFAULT_WEIGHTS,
): CompositeScore {
    // Clamp all layer scores to [0, 100]
    const clamped: LayerScores = {
        onChain:    Math.max(0, Math.min(100, layers.onChain)),
        lpLock:     Math.max(0, Math.min(100, layers.lpLock)),
        tokenAge:   Math.max(0, Math.min(100, layers.tokenAge)),
        market:     Math.max(0, Math.min(100, layers.market)),
        reputation: Math.max(0, Math.min(100, layers.reputation)),
    };

    // Weighted sum
    const raw =
        clamped.onChain    * weights.onChain +
        clamped.lpLock     * weights.lpLock +
        clamped.tokenAge   * weights.tokenAge +
        clamped.market     * weights.market +
        clamped.reputation * weights.reputation;

    const finalScore = Math.round(Math.max(0, Math.min(100, raw)));
    const verdict = resolveVerdict(finalScore);
    const safe = resolveSafety(clamped, finalScore);

    // Count how many layers actually contributed (non-zero weight)
    const layerCount = Object.values(weights).filter(w => w > 0).length;

    return {
        finalScore,
        verdict,
        safe,
        breakdown: clamped,
        weights,
        layerCount,
    };
}

// ── Convenience Builders ─────────────────────────────────────────────────────

/**
 * Build layer scores for the lightweight scan
 * (on-chain + LP lock + token age + holders only — no Birdeye/Helius).
 */
export function buildLightweightLayers(
    onChainScore: number,
    lpLockScore: number,
    tokenAgeScore: number,
): LayerScores {
    return {
        onChain: onChainScore,
        lpLock: lpLockScore,
        tokenAge: tokenAgeScore,
        market: 0,
        reputation: 0,
    };
}

/**
 * Build layer scores for the full scan
 * (all 5 axes — on-chain + LP + age + Birdeye + Helius).
 */
export function buildFullLayers(
    onChainScore: number,
    lpLockScore: number,
    tokenAgeScore: number,
    marketScore: number,
    reputationScore: number,
): LayerScores {
    return {
        onChain: onChainScore,
        lpLock: lpLockScore,
        tokenAge: tokenAgeScore,
        market: marketScore,
        reputation: reputationScore,
    };
}

/**
 * Generate a human-readable summary from layer scores and flags.
 */
export function buildSummary(
    composite: CompositeScore,
    layerFlags: {
        safetyReason?: string;
        honeypotDetected?: boolean;
        holderReason?: string;
        lpFlags?: string[];
        ageFlags?: string[];
        marketFlags?: string[];
        reputationFlags?: string[];
    },
): string {
    if (composite.safe) return 'All checks passed — token appears safe';

    const parts: string[] = [];

    if (layerFlags.safetyReason) parts.push(layerFlags.safetyReason);
    if (layerFlags.honeypotDetected) parts.push('Honeypot detected');
    if (layerFlags.holderReason) parts.push(layerFlags.holderReason);

    if (layerFlags.lpFlags?.length) {
        parts.push(`LP: ${layerFlags.lpFlags.join(', ')}`);
    }
    if (layerFlags.ageFlags?.length) {
        parts.push(`Age: ${layerFlags.ageFlags.join(', ')}`);
    }
    if (layerFlags.marketFlags?.length) {
        parts.push(`Market: ${layerFlags.marketFlags.join(', ')}`);
    }
    if (layerFlags.reputationFlags?.length) {
        parts.push(`Reputation: ${layerFlags.reputationFlags.join(', ')}`);
    }

    return parts.length > 0 ? parts.join('; ') : 'Risk flags detected';
}
