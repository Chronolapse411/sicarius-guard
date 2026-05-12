/**
 * SicariusGuard — API Key Authentication & Rate Limiting
 *
 * Auth system with persistent rate limiting:
 * - Free tier: 100 calls/day per IP (no key needed)
 * - Keyed access: unlimited (API key in x-api-key header)
 * - Rate limits stored in Upstash Redis (survives cold starts + works across instances)
 * - Falls back to in-memory Map if Upstash is not configured
 *
 * @author Chronolapse411
 */

import type { Request, Response, NextFunction } from 'express';
import { Redis } from '@upstash/redis';

const FREE_TIER_LIMIT = parseInt(process.env.FREE_TIER_CALLS_PER_DAY || '100', 10);
const DAY_SECONDS = 24 * 60 * 60;

// ── Redis Setup (optional — falls back to in-memory) ─────────────────────────

let redis: Redis | null = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    redis = new Redis({
        url: process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    console.log('[AUTH] Upstash Redis connected — persistent rate limiting enabled');
} else {
    console.log('[AUTH] No Upstash credentials — using in-memory rate limiting (resets on cold start)');
}

// ── In-memory fallback ───────────────────────────────────────────────────────

interface RateEntry {
    count:   number;
    resetAt: number;
}

const rateLimits = new Map<string, RateEntry>();

// Valid API keys (loaded from env, comma-separated)
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
 * Check rate limit via Upstash Redis.
 * Returns { allowed, count, remaining, resetIn } or null if Redis fails.
 */
async function checkRedisRateLimit(ip: string): Promise<{
    allowed: boolean;
    count: number;
    remaining: number;
    resetIn: number;
} | null> {
    if (!redis) return null;

    try {
        const key = `rl:${ip}`;

        // INCR is atomic — creates key with value 1 if it doesn't exist
        const count = await redis.incr(key);

        // If this is the first request, set the TTL to 24 hours
        if (count === 1) {
            await redis.expire(key, DAY_SECONDS);
        }

        // Get remaining TTL for the reset header
        const ttl = await redis.ttl(key);
        const resetIn = ttl > 0 ? ttl : DAY_SECONDS;

        return {
            allowed: count <= FREE_TIER_LIMIT,
            count,
            remaining: Math.max(0, FREE_TIER_LIMIT - count),
            resetIn,
        };
    } catch (err) {
        console.error('[AUTH] Redis error, falling back to in-memory:', err);
        return null; // Fallback to in-memory
    }
}

/**
 * Check rate limit via in-memory Map (fallback).
 */
function checkMemoryRateLimit(ip: string): {
    allowed: boolean;
    count: number;
    remaining: number;
    resetIn: number;
} {
    const now = Date.now();
    const dayMs = DAY_SECONDS * 1000;

    let entry = rateLimits.get(ip);
    if (!entry || now > entry.resetAt) {
        entry = { count: 0, resetAt: now + dayMs };
        rateLimits.set(ip, entry);
    }

    entry.count++;

    return {
        allowed: entry.count <= FREE_TIER_LIMIT,
        count: entry.count,
        remaining: Math.max(0, FREE_TIER_LIMIT - entry.count),
        resetIn: Math.ceil((entry.resetAt - now) / 1000),
    };
}

/**
 * Express middleware: authenticate and rate-limit requests.
 *
 * - If valid x-api-key is provided: allow through (no rate limit)
 * - If no key: rate limit by IP to FREE_TIER_LIMIT calls/day
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
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
        (req as unknown as Record<string, unknown>).authPassed = true;
        next();
        return;
    }

    // Free tier — rate limit by IP
    const ip = getClientIP(req);

    // Try Redis first, fall back to in-memory
    const result = await checkRedisRateLimit(ip) ?? checkMemoryRateLimit(ip);

    if (!result.allowed) {
        // Check if client has x402 payment header — let payment middleware handle it
        const paymentHeader = req.headers['x-payment'] as string | undefined;
        if (paymentHeader) {
            next();
            return;
        }

        res.status(429).json({
            error: 'Rate limit exceeded',
            message: `Free tier limit: ${FREE_TIER_LIMIT} calls/day. Resets in ${result.resetIn}s. Use x-api-key header for unlimited access, or send SOL via x402 payment protocol.`,
            limit: FREE_TIER_LIMIT,
            remaining: 0,
            resetInSeconds: result.resetIn,
            x402: 'Send SOL to treasury and include tx signature in X-PAYMENT header. See /v1/pricing for details.',
        });
        return;
    }

    // Free tier — mark as authenticated so x402 doesn't block
    (req as unknown as Record<string, unknown>).authPassed = true;

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', FREE_TIER_LIMIT);
    res.setHeader('X-RateLimit-Remaining', result.remaining);
    res.setHeader('X-RateLimit-Reset', Math.floor(Date.now() / 1000) + result.resetIn);

    next();
}

/**
 * Cleanup old rate limit entries (in-memory fallback only)
 */
export function cleanupRateLimits(): void {
    const now = Date.now();
    for (const [ip, entry] of rateLimits) {
        if (now > entry.resetAt) {
            rateLimits.delete(ip);
        }
    }
}
