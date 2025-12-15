import { TokenBucketOptions, TokenBucketState } from './types';

const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * In‑memory token bucket rate limiter.
 *
 * - Tokens are refilled continuously over time at a fixed rate.
 * - A request spends a number of tokens (`cost`); if there are not enough
 *   tokens available, the request is rejected.
 * - The bucket caps at `capacity` tokens to allow short bursts.
 */
export class TokenBucket {
    private capacity: number;
    private refillRate: number; // tokens per second
    private tokens: number;
    private lastRefillTimestamp: number;
    private getTime: () => number;
    private onRateLimit?: (state: TokenBucketState) => void;

    // Basic per-instance metrics
    private totalRequests = 0;
    private allowedRequests = 0;
    private limitedRequests = 0;

    constructor(options: TokenBucketOptions) {
        if (options.capacity <= 0 || options.refillRate < 0) {
            throw new Error('capacity must be > 0 and refillRate must be >= 0');
        }

        this.capacity = options.capacity;
        this.refillRate = options.refillRate;
        this.tokens = options.capacity; // bucket starts full
        this.lastRefillTimestamp = Date.now();
        this.getTime = options.currentTime || (() => Date.now());
        this.onRateLimit = options.onRateLimit;
    }

    /**
     * Try to consume `cost` tokens.
     *
     * @returns true if the request is allowed, false if it is rate limited.
     */
    public allow(cost: number = 1): boolean {
        this.totalRequests += 1;
        this.refill();

        if (this.tokens >= cost) {
            this.tokens -= cost;
            this.allowedRequests += 1;
            return true;
        }

        this.limitedRequests += 1;
        if (this.onRateLimit) {
            this.onRateLimit(this.getState());
        }

        return false;
    }

    /**
     * Promise wrapper for `allow` (handy in async flows).
     */
    public async allowAsync(cost: number = 1): Promise<boolean> {
        return this.allow(cost);
    }

    /**
     * Block (asynchronously) until enough tokens are available or an optional timeout is reached.
     *
     * @throws Error when `timeoutMs` is provided and capacity cannot be obtained in time.
     */
    public async acquire(cost: number = 1, timeoutMs?: number): Promise<void> {
        const start = this.getTime();

        // Degenerate case: no refill and bucket already empty
        if (this.refillRate <= 0 && !this.check(cost)) {
            throw new Error(
                'Cannot acquire tokens: refillRate is 0 and bucket is empty',
            );
        }

        // Loop until allowance succeeds. We sleep based on `timeToRefill`
        // to avoid busy waiting.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            if (this.allow(cost)) return;

            const wait = this.timeToRefill(cost);
            if (wait <= 0) {
                // We might have just refilled, try again immediately.
                continue;
            }

            if (timeoutMs !== undefined) {
                const elapsed = this.getTime() - start;
                if (elapsed + wait > timeoutMs) {
                    throw new Error(
                        `Timeout while waiting for ${cost} token(s)`,
                    );
                }
            }

            await delay(wait);
        }
    }

    /**
     * Check if there are at least `cost` tokens without consuming them.
     */
    public check(cost: number = 1): boolean {
        this.refill();
        return this.tokens >= cost;
    }

    /**
     * Promise wrapper for `check`.
     */
    public async checkAsync(cost: number = 1): Promise<boolean> {
        return this.check(cost);
    }

    /**
     * Compute how long (in ms) until `cost` tokens are available.
     * Returns 0 when there is already enough capacity.
     */
    public timeToRefill(cost: number = 1): number {
        this.refill();
        if (this.tokens >= cost) return 0;

        const needed = cost - this.tokens;
        return Math.ceil((needed / this.refillRate) * 1000);
    }

    /**
     * Promise wrapper for `timeToRefill`.
     */
    public async timeToRefillAsync(cost: number = 1): Promise<number> {
        return this.timeToRefill(cost);
    }

    /**
     * Refill tokens based on elapsed time since the last refill.
     */
    private refill(): void {
        const now = this.getTime();
        const elapsedSeconds = (now - this.lastRefillTimestamp) / 1000;

        if (elapsedSeconds > 0) {
            const newTokens = this.tokens + elapsedSeconds * this.refillRate;
            this.tokens = Math.min(newTokens, this.capacity);
            this.lastRefillTimestamp = now;
        }
    }

    /**
     * Get the current bucket state (after applying a refill).
     */
    public getState(): TokenBucketState {
        this.refill();
        return {
            tokens: Number(this.tokens.toFixed(4)),
            capacity: this.capacity,
            refillRate: this.refillRate,
            lastRefill: this.lastRefillTimestamp,
        };
    }

    /**
     * Promise wrapper for `getState`.
     */
    public async getStateAsync(): Promise<TokenBucketState> {
        return this.getState();
    }

    /**
     * Reset the bucket to a full state.
     */
    public reset(): void {
        this.tokens = this.capacity;
        this.lastRefillTimestamp = this.getTime();
    }

    /**
     * Return basic counters collected since the bucket was created.
     */
    public getMetrics() {
        return {
            totalRequests: this.totalRequests,
            allowed: this.allowedRequests,
            limited: this.limitedRequests,
        };
    }
}


