/**
 * In-memory sliding-window rate limiter
 * No external dependencies — pure Map-based
 */
class RateLimiter {
    constructor() {
        this.windows = new Map(); // key -> { count, resetAt }
        // Periodic cleanup every 60s to prevent memory leak
        setInterval(() => this._cleanup(), 60_000);
    }

    /**
     * Express middleware factory
     * @param {number} maxRequests - max requests per window
     * @param {number} windowMs - window size in milliseconds
     * @param {string} keyPrefix - optional prefix for the key
     */
    middleware(maxRequests = 100, windowMs = 60_000, keyPrefix = 'global') {
        return (req, res, next) => {
            const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
            const key = `${keyPrefix}:${ip}`;
            const now = Date.now();

            let entry = this.windows.get(key);

            if (!entry || now > entry.resetAt) {
                entry = { count: 0, resetAt: now + windowMs };
                this.windows.set(key, entry);
            }

            entry.count++;

            // Set rate limit headers
            res.set('X-RateLimit-Limit', String(maxRequests));
            res.set('X-RateLimit-Remaining', String(Math.max(0, maxRequests - entry.count)));
            res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

            if (entry.count > maxRequests) {
                return res.status(429).json({
                    status: false,
                    error: 'Too many requests. Please slow down.',
                    retry_after_ms: entry.resetAt - now
                });
            }

            next();
        };
    }

    _cleanup() {
        const now = Date.now();
        for (const [key, entry] of this.windows) {
            if (now > entry.resetAt) {
                this.windows.delete(key);
            }
        }
    }
}

// Singleton
module.exports = new RateLimiter();
