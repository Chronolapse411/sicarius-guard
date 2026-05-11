/**
 * SicariusGuard — API Key Authentication & Rate Limiting
 *
 * MVP auth system:
 * - Free tier: 100 calls/day per IP (no key needed)
 * - Keyed access: unlimited (API key in x-api-key header)
 * - Keys stored in-memory (loaded from env for MVP)
 *
 * @author Chronolapse411
 */

import type { Request, Response, NextFunction } from 'express';

const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_CALLS_PER_DAY || '100', 10);

// In-memory rate tracking: IP → { count, resetAt }
interface RateEntry {
    count:   number;
    resetAt: number;
}

const rateLimits = new Map<string, RateEntry>();

// Valid API keys (MVP: loaded from env, comma-separated)
const validKeys = new Set(
    (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean)
);

/**
 * Get client IP from request (handles proxies)
 */
function getClientIP(req: Request): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
    return req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * Express middleware: authenticate and rate-limit requests.
 *
 * - If valid x-api-key is provided: allow through (no rate limit)
 * - If no key: rate limit by IP to FREE_TIER_LIMIT calls/day
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
    const apiKey = req.headers['x-api-key'] as string | undefined;

    // Keyed access — check validity, skip rate limiting
    if (apiKey) {
        if (validKeys.size > 0 && !validKeys.has(apiKey)) {
            res.status(401).json({
                error: 'Invalid API key',
                message: 'Provide a valid API key in the x-api-key header',
            });
            return;
        }
        // Valid key (or no keys configured = open access)
        next();
        return;
    }

    // Free tier — rate limit by IP
    const ip = getClientIP(req);
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;

    let entry = rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + dayMs };
        rateLimits.set(ip, entry);
    }

    entry.count++;

    if (entry.count > FREE_TIER_LIMIT) {
        const resetIn = Math.ceil((entry.resetAt - now) / 1000);
        res.status(429).json({
            error: 'Rate limit exceeded',
            message: `Free tier limit: ${FREE_TIER_LIMIT} calls/day. Resets in ${resetIn}s. Add an x-api-key header for unlimited access.`,
            limit: FREE_TIER_LIMIT,
            remaining: 0,
            resetInSeconds: resetIn,
        });
        return;
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', FREE_TIER_LIMIT);
    res.setHeader('X-RateLimit-Remaining', FREE_TIER_LIMIT - entry.count);
    res.setHeader('X-RateLimit-Reset', Math.floor(entry.resetAt / 1000));

    next();
}

/**
 * Cleanup old rate limit entries (call periodically)
 */
export function cleanupRateLimits(): void {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
        if (now > entry.resetAt) {
            rateLimits.delete(ip);
        }
    }
}
