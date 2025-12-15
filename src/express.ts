import { TokenBucket } from './tokenBucket';
import { TokenBucketManager, TokenBucketManagerOptions } from './manager';
import { TokenBucketState } from './types';

// Minimal Express-like types to avoid introducing a hard dependency.
type NextFunction = (err?: any) => void;
type RequestLike = { ip?: string; [key: string]: any };
type ResponseLike = {
    status(code: number): ResponseLike;
    setHeader?(name: string, value: string | number): void;
    send?(body?: any): void;
    end?(): void;
    [key: string]: any;
};

export interface ExpressRateLimitOptions {
    /**
    * Token cost per request (default: 1).
    */
    cost?: number;

    /**
     * Resolve a bucket key from the incoming request.
     * Defaults to req.ip or 'anonymous'.
     */
    keyResolver?: (req: RequestLike) => string;

    /**
     * Optional manager. If omitted, an internal manager is created.
     */
    manager?: TokenBucketManager;

    /**
     * Options used when creating the internal manager (ignored if manager is provided).
     */
    managerOptions?: Omit<TokenBucketManagerOptions, 'createBucket'>;

    /**
     * Factory to create a bucket when using the internal manager.
     * Defaults to capacity 10, refillRate 5 tokens/second.
     */
    createBucket?: (key: string) => TokenBucket;

    /**
     * Custom handler when a request is rejected.
     * If provided, you are responsible for ending the response.
     */
    onReject?: (
        req: RequestLike,
        res: ResponseLike,
        next: NextFunction,
        state: TokenBucketState,
    ) => void;

    /**
     * If true, sets simple rate-limit headers (remaining tokens).
     */
    setHeaders?: boolean;
}

/**
 * Express-compatible middleware that uses TokenBucketManager to enforce rate limits.
 *
 * By default:
 * - Uses req.ip as the key.
 * - Bucket capacity = 10, refillRate = 5 tokens/second.
 * - Returns 429 when limited.
 */
export function createExpressRateLimiter(
    options: ExpressRateLimitOptions = {},
) {
    const {
        cost = 1,
        keyResolver = (req: RequestLike) => req.ip || 'anonymous',
        manager = new TokenBucketManager({
            createBucket:
                options.createBucket ||
                (() => new TokenBucket({ capacity: 10, refillRate: 5 })),
            ttlMs: options.managerOptions?.ttlMs,
            onRateLimit: options.managerOptions?.onRateLimit,
        }),
        onReject,
        setHeaders = true,
    } = options;

    return (req: RequestLike, res: ResponseLike, next: NextFunction) => {
        const key = keyResolver(req);
        const allowed = manager.allow(key, cost);
        const state = manager.getState(key);

        if (allowed) {
            if (setHeaders && res.setHeader) {
                res.setHeader('X-RateLimit-Remaining', state.tokens.toFixed(4));
            }
            return next();
        }

        if (onReject) {
            return onReject(req, res, next, state);
        }

        if (res.status) res.status(429);
        if (res.setHeader) {
            res.setHeader('Retry-After', state.lastRefill.toString());
        }
        if (res.send) return res.send('Too Many Requests');
        if (res.end) return res.end();
        return next(new Error('Too Many Requests'));
    };
}

