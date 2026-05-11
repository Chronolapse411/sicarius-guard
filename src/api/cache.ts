/**
 * SicariusGuard — In-Memory Result Cache
 *
 * Caches SafetyResult by mint address to avoid redundant RPC calls.
 * TTL-based expiration. Thread-safe for single-process Node.js.
 *
 * @author Chronolapse411
 */

interface CacheEntry<T> {
    value:     T;
    expiresAt: number;
}

export class ResultCache<T = unknown> {
    private store = new Map<string, CacheEntry<T>>();
    private ttlMs: number;
    private cleanupInterval: ReturnType<typeof setInterval>;

    constructor(ttlSeconds: number = 300) {
        this.ttlMs = ttlSeconds * 1000;

        // Periodic cleanup every 60s to prevent memory leak
        this.cleanupInterval = setInterval(() => this.evictExpired(), 60_000);
    }

    get(key: string): T | null {
        const entry = this.store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) {
            this.store.delete(key);
            return null;
        }
        return entry.value;
    }

    set(key: string, value: T): void {
        this.store.set(key, {
            value,
            expiresAt: Date.now() + this.ttlMs,
        });
    }

    has(key: string): boolean {
        return this.get(key) !== null;
    }

    size(): number {
        return this.store.size;
    }

    private evictExpired(): void {
        const now = Date.now();
        for (const [key, entry] of this.store) {
            if (now > entry.expiresAt) {
                this.store.delete(key);
            }
        }
    }

    destroy(): void {
        clearInterval(this.cleanupInterval);
        this.store.clear();
    }
}
