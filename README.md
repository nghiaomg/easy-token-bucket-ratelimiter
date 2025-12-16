# Token Bucket Rate Limiter

A tiny, dependency-free Token Bucket rate limiter written in TypeScript. It gives you simple synchronous checks to throttle bursts while refilling at a steady rate.

## What problem does this solve?
Uncontrolled bursts can overload services, exhaust quotas, or trigger upstream rate limits. This library enforces a predictable request budget using the Token Bucket algorithm:
- You set a `capacity` (burst size) and `refillRate` (tokens per second).
- Each call to `allow(cost)` refills based on elapsed time, then consumes `cost` tokens if available.
- When the bucket is empty, calls are rejected immediately, giving you a simple backpressure signal.
This keeps traffic within a steady envelope while still allowing short bursts.

## Features
- Token Bucket algorithm with configurable capacity and refill rate
- Synchronous & Promise-friendly API (`allow`, `check`, `timeToRefill`, `acquire` + `*Async`)
- Optional injected clock for deterministic testing
- Multiple in-memory buckets with TTL via `TokenBucketManager`
- Distributed option with Redis-backed atomic buckets and TTL
- Basic built‑in metrics and rate-limit callbacks (hooks)
- Ships with type definitions and CommonJS output

## Installation
```bash
npm install easy-token-bucket-ratelimiter
```

## Quick Start
```ts
import { TokenBucket } from 'easy-token-bucket-ratelimiter';

// Allow bursts of up to 10 requests, refilling 5 tokens per second
const limiter = new TokenBucket({ capacity: 10, refillRate: 5 });

if (limiter.allow()) {
  // Handle the request
} else {
  // Too many requests; apply backoff
}
```

## API
### `new TokenBucket(options)`
| Option | Type | Description |
| --- | --- | --- |
| `capacity` | `number` | Maximum tokens the bucket can hold (burst size). Must be > 0. |
| `refillRate` | `number` | Tokens added per second. Must be ≥ 0. |
| `currentTime` | `() => number` (optional) | Custom time source returning milliseconds (useful for tests). |
| `onRateLimit` | `(state) => void` (optional) | Called whenever `allow()` is denied; good for logs/metrics. |

### Core methods
- `allow(cost = 1): boolean` — Refill based on elapsed time, then consume `cost` tokens if available. Returns `true` when allowed, `false` otherwise.
- `acquire(cost = 1, timeoutMs?: number): Promise<void>` — Wait until enough tokens are available (or throw if `timeoutMs` is exceeded). This is the **“real async wait”** API.
- `check(cost = 1): boolean` — Refill, then report if at least `cost` tokens remain without consuming them.
- `timeToRefill(cost = 1): number` — Refill, then return the wait time in milliseconds until `cost` tokens are available (0 if already available).
- `getState(): { tokens; capacity; refillRate; lastRefill }` — Refill, then return current internal state (useful for debugging/metrics).
- `reset(): void` — Reset the bucket to “full” (useful for admin overrides or tests).
- Metrics: `getMetrics()` → `{ totalRequests, allowed, limited }`.
- Async variants: `allowAsync`, `checkAsync`, `timeToRefillAsync`, `getStateAsync` simply return Promises for easier `await` chaining.

### Async wait example
```ts
// Wait (optionally with timeout) until we can proceed
try {
  await limiter.acquire(1, 1_000); // wait up to 1s for a token
  // Safe to continue
} catch {
  // Timed out waiting for capacity
}
```

### `TokenBucketManager`
Simple helper to manage many buckets (e.g., per user/route) with optional TTL and hooks:
```ts
import { TokenBucketManager, TokenBucket } from 'easy-token-bucket-ratelimiter';

const manager = new TokenBucketManager({
  createBucket: () => new TokenBucket({ capacity: 10, refillRate: 5 }),
  ttlMs: 60_000, // auto-expire buckets after 60s of inactivity
  onRateLimit: (key, state) => {
    console.warn('rate-limited', { key, state });
  },
});

if (!manager.allow(userId)) {
  return res.status(429).end();
}
```

You can also call `manager.cleanup()` to eagerly drop expired buckets if you want explicit control over memory usage.

### `RedisTokenBucket` (distributed)
Use Redis for atomic, multi-instance limits. Requires a Redis client that supports `eval` (and optionally `evalsha`, e.g., `ioredis` or `ioredis` Cluster):
```ts
import Redis from 'ioredis';
import { RedisTokenBucket } from 'easy-token-bucket-ratelimiter';

const redis = new Redis();
const bucket = new RedisTokenBucket({
  redis,
  key: 'user:123',
  prefix: 'rate',        // optional
  ttlSeconds: 300,       // optional, auto-expire Redis key after 5 minutes idle
  // scriptSha: '...',   // optional, use EVALSHA with a preloaded Lua script for better perf
  onRateLimit: (key, state) => {
    console.warn('redis rate-limited', { key, state });
  },
  capacity: 20,
  refillRate: 5,
});

if (!(await bucket.allow())) {
  return res.status(429).end();
}
```
Notes:
- Uses a Lua script internally (`EVAL`/`EVALSHA`); ensure your Redis settings allow it and that the script SHA is loaded beforehand if you use `scriptSha`.
- Time source defaults to `Date.now()`. For tighter clocks across hosts, consider syncing time or using `currentTime` to inject a shared source.
- State is stored under `prefix:key` as a hash with `tokens` and `lastRefill`; TTL (if set) is applied via `EXPIRE`.
- You can call `reset()` to clear a Redis bucket (useful for admin/debug flows).
- Basic per-instance metrics are available via `getMetrics()` (same shape as the in-memory bucket).
- The Lua script runs atomically per key, so concurrent callers on the same bucket are serialized by Redis; for clustered/sharded setups, prefer clients like `ioredis` Cluster and ensure your keys (or prefixes) map consistently to slots.

### Express middleware helper
99% of users plug rate limiting into a web framework. A lightweight Express-compatible middleware is provided:
```ts
import express from 'express';
import { createExpressRateLimiter } from 'easy-token-bucket-ratelimiter';

const app = express();
const rateLimiter = createExpressRateLimiter({
  // Defaults: capacity 10, refillRate 5/s, key = req.ip, cost = 1
  cost: 1,
  ttlMs: 60_000, // used when the internal manager is created
  setHeaders: true, // X-RateLimit-Remaining
  onReject: (req, res) => res.status(429).send('Too Many Requests'),
});

app.use(rateLimiter);
```
Notes:
- If you already have a `TokenBucketManager`, pass it via `manager` to share state.
- `keyResolver` lets you key by user-id/API-key instead of IP.
- `createBucket` lets you override capacity/refill per key; otherwise the helper uses a default (capacity 10, refill 5/s).

## Usage Examples

### Express with IP-based Rate Limiting

Rate limit by client IP address (default behavior):

```ts
import express from 'express';
import { createExpressRateLimiter } from 'easy-token-bucket-ratelimiter';

const app = express();

// Basic IP-based rate limiting
// Allows bursts of 10 requests, refilling 5 tokens per second per IP
const ipRateLimiter = createExpressRateLimiter({
  capacity: 10,
  refillRate: 5,
  cost: 1,
  ttlMs: 60_000, // Clean up inactive buckets after 60 seconds
  setHeaders: true, // Sets X-RateLimit-Remaining header
  onReject: (req, res, next, state) => {
    // Calculate time until we have enough tokens (cost = 1)
    // If tokens < 1, we need (1 - tokens) tokens, which takes (1 - tokens) / refillRate seconds
    const tokensNeeded = Math.max(0, 1 - state.tokens);
    const timeToRefillSeconds = state.refillRate > 0
      ? Math.ceil((tokensNeeded / state.refillRate))
      : 0;
    
    res.status(429)
      .setHeader('Retry-After', timeToRefillSeconds.toString())
      .json({ 
        error: 'Too Many Requests',
        retryAfter: timeToRefillSeconds
      });
  },
});

app.use(ipRateLimiter);
app.get('/api/data', (req, res) => {
  res.json({ message: 'Success' });
});
```

### Express with User ID-based Rate Limiting

Rate limit by authenticated user ID instead of IP:

```ts
import express from 'express';
import { createExpressRateLimiter, TokenBucketManager, TokenBucket } from 'easy-token-bucket-ratelimiter';

const app = express();

// Create a manager with custom bucket configuration
const manager = new TokenBucketManager({
  createBucket: (key: string) => {
    // Different limits for different user tiers
    if (key.startsWith('premium:')) {
      return new TokenBucket({ capacity: 100, refillRate: 20 });
    }
    if (key.startsWith('vip:')) {
      return new TokenBucket({ capacity: 500, refillRate: 50 });
    }
    // Default: free tier
    return new TokenBucket({ capacity: 10, refillRate: 5 });
  },
  ttlMs: 300_000, // 5 minutes
  onRateLimit: (key, state) => {
    console.warn(`Rate limit exceeded for user: ${key}`, state);
    // Send to monitoring/logging service
  },
});

// Middleware to extract user ID from request
const getUserRateLimiter = createExpressRateLimiter({
  manager,
  keyResolver: (req: any) => {
    // Extract user ID from authenticated session/token
    const userId = req.user?.id || req.headers['x-user-id'];
    const userTier = req.user?.tier || 'free'; // premium, vip, free
    return `${userTier}:${userId || 'anonymous'}`;
  },
  cost: 1,
  setHeaders: true,
  onReject: (req, res, next, state) => {
    // Calculate time until we have enough tokens (cost = 1)
    const tokensNeeded = Math.max(0, 1 - state.tokens);
    const timeToRefillSeconds = state.refillRate > 0
      ? Math.ceil((tokensNeeded / state.refillRate))
      : 0;
    
    res.status(429).json({
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter: timeToRefillSeconds,
    });
  },
});

// Apply to protected routes
app.use('/api/protected', getUserRateLimiter);
app.get('/api/protected/profile', (req, res) => {
  res.json({ user: req.user });
});
```

### Express with Redis (Distributed Rate Limiting)

Use Redis for rate limiting across multiple server instances:

```ts
import express from 'express';
import Redis from 'ioredis';
import { RedisTokenBucket } from 'easy-token-bucket-ratelimiter';

const app = express();
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// Create Redis bucket factory
const createRedisBucket = (key: string) => {
  return new RedisTokenBucket({
    redis,
    key,
    prefix: 'ratelimit', // Redis key prefix
    capacity: 20,
    refillRate: 5,
    ttlSeconds: 300, // Auto-expire after 5 minutes of inactivity
    onRateLimit: (key, state) => {
      console.warn(`Redis rate limit: ${key}`, state);
      // Send to monitoring service
    },
  });
};

// Express middleware using Redis
app.use(async (req, res, next) => {
  const key = req.ip || 'anonymous';
  const bucket = createRedisBucket(key);
  
  const allowed = await bucket.allow(1);
  if (!allowed) {
    const state = await bucket.getState();
    const timeToRefillMs = await bucket.timeToRefill(1);
    return res.status(429)
      .setHeader('Retry-After', Math.ceil(timeToRefillMs / 1000).toString())
      .json({ error: 'Too Many Requests' });
  }
  
  // Set rate limit headers
  const state = await bucket.getState();
  res.setHeader('X-RateLimit-Remaining', Math.floor(state.tokens));
  res.setHeader('X-RateLimit-Capacity', state.capacity);
  
  next();
});

app.get('/api/data', (req, res) => {
  res.json({ message: 'Success' });
});
```

### Express with Redis and User ID

Combine Redis with user-based rate limiting:

```ts
import express from 'express';
import Redis from 'ioredis';
import { RedisTokenBucket } from 'easy-token-bucket-ratelimiter';

const app = express();
const redis = new Redis();

// Helper to create Redis bucket for a user
function getUserBucket(userId: string, tier: string = 'free') {
  const limits = {
    free: { capacity: 10, refillRate: 5 },
    premium: { capacity: 100, refillRate: 20 },
    vip: { capacity: 500, refillRate: 50 },
  };
  
  const config = limits[tier as keyof typeof limits] || limits.free;
  
  return new RedisTokenBucket({
    redis,
    key: `user:${userId}`,
    prefix: `ratelimit:${tier}`,
    capacity: config.capacity,
    refillRate: config.refillRate,
    ttlSeconds: 600, // 10 minutes
    onRateLimit: (key, state) => {
      console.warn(`User ${userId} (${tier}) rate limited`, { key, state });
    },
  });
}

// Middleware to rate limit by user ID
app.use('/api/user', async (req: any, res, next) => {
  const userId = req.user?.id || req.headers['x-user-id'];
  if (!userId) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  const userTier = req.user?.tier || 'free';
  const bucket = getUserBucket(userId, userTier);
  
  const allowed = await bucket.allow(1);
  if (!allowed) {
    const timeToRefillMs = await bucket.timeToRefill(1);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil(timeToRefillMs / 1000),
    });
  }
  
  const state = await bucket.getState();
  res.setHeader('X-RateLimit-Remaining', Math.floor(state.tokens));
  res.setHeader('X-RateLimit-Capacity', state.capacity);
  
  next();
});

app.get('/api/user/profile', (req, res) => {
  res.json({ user: req.user });
});
```

### Custom Route-specific Rate Limiting

Different rate limits for different routes:

```ts
import express from 'express';
import { TokenBucketManager, TokenBucket, createExpressRateLimiter } from 'easy-token-bucket-ratelimiter';

const app = express();

// API route rate limiter (stricter)
const apiLimiter = createExpressRateLimiter({
  createBucket: () => new TokenBucket({ capacity: 5, refillRate: 2 }),
  cost: 1,
  ttlMs: 60_000,
});

// Upload route rate limiter (more lenient, higher cost)
const uploadLimiter = createExpressRateLimiter({
  createBucket: () => new TokenBucket({ capacity: 3, refillRate: 1 }),
  cost: 2, // Uploads cost 2 tokens
  ttlMs: 300_000,
});

// Login route rate limiter (very strict)
const loginLimiter = createExpressRateLimiter({
  createBucket: () => new TokenBucket({ capacity: 3, refillRate: 0.5 }),
  cost: 1,
  ttlMs: 900_000, // 15 minutes
  keyResolver: (req) => `login:${req.ip}`,
});

app.use('/api/', apiLimiter);
app.use('/upload', uploadLimiter);
app.use('/auth/login', loginLimiter);

app.post('/api/data', (req, res) => {
  res.json({ success: true });
});

app.post('/upload', (req, res) => {
  res.json({ uploaded: true });
});

app.post('/auth/login', (req, res) => {
  res.json({ token: '...' });
});
```

### Manual Rate Limiting (Without Express Middleware)

Direct usage in your route handlers:

```ts
import express from 'express';
import { TokenBucketManager, TokenBucket } from 'easy-token-bucket-ratelimiter';

const app = express();

const manager = new TokenBucketManager({
  createBucket: () => new TokenBucket({ capacity: 10, refillRate: 5 }),
  ttlMs: 60_000,
});

app.get('/api/data', (req, res) => {
  const key = req.ip || 'anonymous';
  
  if (!manager.allow(key, 1)) {
    const state = manager.getState(key);
    return res.status(429).json({
      error: 'Too Many Requests',
      retryAfter: Math.ceil(manager.timeToRefill(key, 1) / 1000),
    });
  }
  
  // Process request
  res.json({ data: 'success' });
});
```

### Redis with Preloaded Script (Performance Optimization)

For high-throughput scenarios, preload the Lua script:

```ts
import Redis from 'ioredis';
import { RedisTokenBucket } from 'easy-token-bucket-ratelimiter';

const redis = new Redis();

// Preload the Lua script once at startup
const scriptSha = await redis.script('LOAD', `
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
`);

// Use the preloaded script SHA for better performance
const bucket = new RedisTokenBucket({
  redis,
  key: 'user:123',
  capacity: 20,
  refillRate: 5,
  scriptSha, // Use EVALSHA instead of EVAL
  ttlSeconds: 300,
});

const allowed = await bucket.allow(1);
```

### Monitoring and Metrics

Track rate limiting metrics:

```ts
import { TokenBucketManager, TokenBucket } from 'easy-token-bucket-ratelimiter';

// Track metrics manually
let totalRateLimited = 0;

const manager = new TokenBucketManager({
  createBucket: () => new TokenBucket({ 
    capacity: 10, 
    refillRate: 5,
    onRateLimit: (state) => {
      // Send to monitoring service
      console.log('Rate limit hit:', state);
    },
  }),
  onRateLimit: (key, state) => {
    // Track per-key rate limits
    totalRateLimited++;
    console.log(`Rate limit for ${key}:`, state);
    // Send to your monitoring service (e.g., Prometheus, DataDog)
  },
});

// Get metrics for a specific bucket
const key = 'user:123';
const bucketState = manager.getState(key);
console.log('Bucket state:', bucketState);
console.log('Tokens remaining:', bucketState.tokens);
console.log('Time until refill:', manager.timeToRefill(key, 1), 'ms');

// For Redis buckets, you can get per-instance metrics
import { RedisTokenBucket } from 'easy-token-bucket-ratelimiter';
import Redis from 'ioredis';

const redis = new Redis();
const redisBucket = new RedisTokenBucket({
  redis,
  key: 'user:123',
  capacity: 20,
  refillRate: 5,
});

const allowed = await redisBucket.allow(1);
const metrics = redisBucket.getMetrics();
console.log('Redis bucket metrics:', metrics);
// { totalRequests: 100, allowed: 95, limited: 5 }
```

## Testing
```bash
npm test
```

## Build
```bash
npm run build
```

## Notes
- All core operations are O(1) and side-effect free except for internal state updates.
- In-memory buckets are per-process; use `RedisTokenBucket` for cross-instance enforcement.