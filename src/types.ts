/**
 * Public state snapshot of a token bucket.
 */
export interface TokenBucketState {
    tokens: number;
    capacity: number;
    refillRate: number;
    lastRefill: number;
}

/**
 * Options for the in‑memory TokenBucket implementation.
 */
export interface TokenBucketOptions {
    /** Maximum number of tokens the bucket can hold (burst size). */
    capacity: number;

    /** Token refill rate in tokens per second. */
    refillRate: number;

    /**
     * Time source returning milliseconds.
     * Useful for tests or custom clocks; defaults to Date.now.
     */
    currentTime?: () => number;

    /**
     * Called whenever a request is rejected by allow().
     * Good place to push logs/metrics/alerts.
     */
    onRateLimit?: (state: TokenBucketState) => void;
}

/**
 * Minimal Redis client interface compatible with ioredis-style eval.
 */
export interface RedisClientLike {
    eval(
        script: string,
        keys: number | string[],
        ...args: Array<string | number>
    ): Promise<any> | any;
    /**
     * Optional EVALSHA support, used when a preloaded script SHA is provided.
     */
    evalsha?(
        sha: string,
        keys: number | string[],
        ...args: Array<string | number>
    ): Promise<any> | any;
    del?(key: string): Promise<any> | any;
}

/**
 * Options for the Redis-backed TokenBucket variant.
 */
export interface RedisTokenBucketOptions
    extends Omit<TokenBucketOptions, 'onRateLimit'> {
    /** Redis client instance that supports eval / evalsha. */
    redis: RedisClientLike;

    /** Logical bucket key, will be prefixed if prefix is provided. */
    key: string;

    /** Optional prefix to avoid key collisions across buckets. */
    prefix?: string;

    /** TTL for the Redis key in seconds (0 or undefined means no TTL). */
    ttlSeconds?: number;

    /**
     * Optional pre-loaded Lua script SHA; when provided and the client exposes
     * evalsha(), it will be used instead of sending the full script each time.
     */
    scriptSha?: string;

    /**
     * Called whenever a Redis-backed bucket denies a request.
     * Receives the resolved Redis key and the current bucket state.
     */
    onRateLimit?: (key: string, state: TokenBucketState) => void;
}


