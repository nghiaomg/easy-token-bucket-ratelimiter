import {
    RedisClientLike,
    RedisTokenBucketOptions,
    TokenBucketState,
} from './types';

/**
 * Lua script implementing a Redis-backed token bucket.
 *
 * Behavior:
 * - Reads current `tokens` and `lastRefill` from an HMGET.
 * - Refills tokens based on elapsed time and `refillRate`, capped at `capacity`.
 * - Optionally consumes `cost` tokens if available.
 * - Writes back `tokens` and `lastRefill` via HMSET.
 * - Optionally applies a TTL via EXPIRE.
 *
 * Returns either:
 * - { allowed, tokens }                       when `returnState == false`
 * - { allowed, tokens, lastRefillTimestamp } when `returnState == true`
 */
const REDIS_TOKEN_BUCKET_LUA = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refillRate = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local nowMs = tonumber(ARGV[4])
local consume = ARGV[5] == "1"
local returnState = ARGV[6] == "1"
local ttlSeconds = tonumber(ARGV[7])

local data = redis.call("HMGET", key, "tokens", "lastRefill")
local tokens = tonumber(data[1])
local lastRefill = tonumber(data[2])
if not tokens then
  tokens = capacity
  lastRefill = nowMs
end

local elapsedMs = nowMs - lastRefill
if elapsedMs > 0 then
  local refill = (elapsedMs / 1000.0) * refillRate
  tokens = tokens + refill
  if tokens > capacity then tokens = capacity end
  lastRefill = nowMs
end

local allowed = 0
if tokens >= cost then
  allowed = 1
  if consume then
    tokens = tokens - cost
  end
end

redis.call("HMSET", key, "tokens", tokens, "lastRefill", lastRefill)
if ttlSeconds and ttlSeconds > 0 then
  redis.call("EXPIRE", key, ttlSeconds)
end

if returnState then
  return {allowed, tokens, lastRefill}
else
  return {allowed, tokens}
end
`;

/**
 * Redis-backed token bucket for distributed rate limiting.
 *
 * All mutations are performed via a small Lua script to guarantee atomic
 * refill + consumption across multiple instances.
 */
export class RedisTokenBucket {
    private capacity: number;
    private refillRate: number;
    private getTime: () => number;
    private redis: RedisClientLike;
    private key: string;
    private ttlSeconds?: number;
    private onRateLimit?: (key: string, state: TokenBucketState) => void;
    private scriptSha?: string;

    // Basic per-instance metrics
    private totalRequests = 0;
    private allowedRequests = 0;
    private limitedRequests = 0;

    constructor(options: RedisTokenBucketOptions) {
        if (options.capacity <= 0 || options.refillRate < 0) {
            throw new Error('capacity must be > 0 and refillRate must be >= 0');
        }

        this.capacity = options.capacity;
        this.refillRate = options.refillRate;
        this.redis = options.redis;
        this.key = `${options.prefix ?? 'tb'}:${options.key}`;
        this.ttlSeconds = options.ttlSeconds;
        this.onRateLimit = options.onRateLimit;
        this.scriptSha = options.scriptSha;
        this.getTime = options.currentTime || (() => Date.now());
    }

    public async allow(cost: number = 1): Promise<boolean> {
        this.totalRequests += 1;
        const [allowed, tokens, lastRefill] = await this.runScript(cost, {
            returnState: !!this.onRateLimit,
        });
        if (allowed === 1) {
            this.allowedRequests += 1;
            return true;
        }
        this.limitedRequests += 1;
        if (this.onRateLimit && tokens !== undefined && lastRefill !== undefined) {
            this.onRateLimit(this.key, {
                tokens: Number(Number(tokens).toFixed(4)),
                capacity: this.capacity,
                refillRate: this.refillRate,
                lastRefill,
            });
        }
        return false;
    }

    public async check(cost: number = 1): Promise<boolean> {
        const [allowed] = await this.runScript(cost, { consume: false });
        return allowed === 1;
    }

    public async timeToRefill(cost: number = 1): Promise<number> {
        const [, tokens] = await this.runScript(0, { consume: false });
        if (tokens >= cost) return 0;
        const needed = cost - tokens;
        return Math.ceil((needed / this.refillRate) * 1000);
    }

    public async getState() {
        const [, tokens, lastRefill] = await this.runScript(0, {
            consume: false,
            returnState: true,
        });
        return {
            tokens: Number(Number(tokens).toFixed(4)),
            capacity: this.capacity,
            refillRate: this.refillRate,
            lastRefill,
        };
    }

    /**
     * Remove the underlying Redis key, effectively resetting the bucket.
     */
    public async reset(): Promise<void> {
        if (typeof this.redis.del === 'function') {
            await this.redis.del(this.key);
        } else {
            const script = `
return redis.call("DEL", KEYS[1])
`;
            await this.redis.eval(script, 1, this.key);
        }
    }

    /**
     * Return basic per-instance metrics for this Redis bucket wrapper.
     */
    public getMetrics() {
        return {
            totalRequests: this.totalRequests,
            allowed: this.allowedRequests,
            limited: this.limitedRequests,
        };
    }

    private async runScript(
        cost: number,
        options?: { consume?: boolean; returnState?: boolean },
    ): Promise<[number, number, number?]> {
        const consume = options?.consume ?? true;
        const returnState = options?.returnState ?? false;
        const now = this.getTime();
        const ttlSeconds = this.ttlSeconds ?? 0;

        const args: Array<string | number> = [
            this.key,
            this.capacity,
            this.refillRate,
            cost,
            now,
            consume ? '1' : '0',
            returnState ? '1' : '0',
            ttlSeconds,
        ];

        let result: any;

        // Prefer EVALSHA when a preloaded script SHA is provided and the client supports it.
        if (this.scriptSha && typeof this.redis.evalsha === 'function') {
            result = await this.redis.evalsha(this.scriptSha, 1, ...args);
        } else {
            result = await this.redis.eval(REDIS_TOKEN_BUCKET_LUA, 1, ...args);
        }

        // ioredis returns an array; node-redis may return number[]
        return result as [number, number, number?];
    }
}


