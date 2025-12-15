import { TokenBucket } from './tokenBucket';
import { TokenBucketState } from './types';

export interface TokenBucketManagerOptions {
    createBucket: (key: string) => TokenBucket;
    /** Time-to-live for a bucket (ms); inactive buckets beyond this window are evicted. */
    ttlMs?: number;
    /** Called when a specific key is rate limited. */
    onRateLimit?: (key: string, state: TokenBucketState) => void;
}

/**
 * Helper for managing multiple in‑memory buckets (for example, per user, IP, or route).
 */
export class TokenBucketManager {
    private buckets = new Map<
        string,
        { bucket: TokenBucket; lastAccess: number }
    >();
    private createBucket: (key: string) => TokenBucket;
    private ttlMs?: number;
    private onRateLimit?: (key: string, state: TokenBucketState) => void;

    constructor(createBucket: (key: string) => TokenBucket);
    constructor(options: TokenBucketManagerOptions);
    constructor(
        arg: ((key: string) => TokenBucket) | TokenBucketManagerOptions,
    ) {
        if (typeof arg === 'function') {
            this.createBucket = arg;
        } else {
            this.createBucket = arg.createBucket;
            this.ttlMs = arg.ttlMs;
            this.onRateLimit = arg.onRateLimit;
        }
    }

    private now(): number {
        return Date.now();
    }

    private get(key: string): TokenBucket {
        const now = this.now();

        const entry = this.buckets.get(key);
        if (entry && this.ttlMs !== undefined) {
            if (now - entry.lastAccess > this.ttlMs) {
                this.buckets.delete(key);
            }
        }

        let current = this.buckets.get(key);
        if (!current) {
            current = { bucket: this.createBucket(key), lastAccess: now };
            this.buckets.set(key, current);
        } else {
            current.lastAccess = now;
        }

        return current.bucket;
    }

    public allow(key: string, cost: number = 1): boolean {
        const bucket = this.get(key);
        const allowed = bucket.allow(cost);
        if (!allowed && this.onRateLimit) {
            this.onRateLimit(key, bucket.getState());
        }
        return allowed;
    }

    public check(key: string, cost: number = 1): boolean {
        return this.get(key).check(cost);
    }

    public timeToRefill(key: string, cost: number = 1): number {
        return this.get(key).timeToRefill(cost);
    }

    public getState(key: string): TokenBucketState {
        return this.get(key).getState();
    }

    /**
     * Manually clean up buckets that exceeded their TTL.
     * Usually not required, but can be useful if you want explicit memory control.
     */
    public cleanup(): void {
        if (this.ttlMs === undefined) return;
        const now = this.now();
        for (const [key, entry] of this.buckets) {
            if (now - entry.lastAccess > this.ttlMs) {
                this.buckets.delete(key);
            }
        }
    }
}


