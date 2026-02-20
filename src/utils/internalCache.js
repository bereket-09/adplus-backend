class InternalCache {
    constructor(ttlSeconds = 60) {
        this.cache = new Map();
        this.ttl = ttlSeconds * 1000;
    }

    set(key, value, ttl = this.ttl) {
        const expiry = Date.now() + ttl;
        this.cache.set(key, { value, expiry });
    }

    get(key) {
        const item = this.cache.get(key);
        if (!item) return null;

        if (Date.now() > item.expiry) {
            this.cache.delete(key);
            return null;
        }

        return item.value;
    }

    del(key) {
        this.cache.delete(key);
    }

    flush() {
        this.cache.clear();
    }

    // Clean up expired items periodically if needed, 
    // but for simple use, lazy expiration in get() is often enough.
}

const globalCache = new InternalCache(300); // 5 minutes default

module.exports = globalCache;
