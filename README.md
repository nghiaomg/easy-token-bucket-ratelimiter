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