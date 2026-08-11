class LeaseManager {
    constructor(store, options = {}) {
        this.store = store;
        this.defaultTtlMs = Math.max(1000, Number(options.defaultTtlMs || 120000));
        this.now = options.now || Date.now;
    }

    claim(key, owner, details = {}, ttlMs = this.defaultTtlMs) {
        if (!key || !owner) return null;
        const state = this.read();
        this.reapState(state);
        const existing = state.leases[key];
        if (existing && existing.owner !== owner) {
            this.write(state);
            return null;
        }
        const now = this.now();
        const lease = {
            key,
            owner,
            details: plainObject(details),
            claimedAt: existing?.claimedAt || now,
            renewedAt: now,
            expiresAt: now + Math.max(1000, Number(ttlMs || this.defaultTtlMs))
        };
        state.leases[key] = lease;
        this.write(state);
        return clone(lease);
    }

    renew(key, owner, ttlMs = this.defaultTtlMs) {
        const state = this.read();
        this.reapState(state);
        const lease = state.leases[key];
        if (!lease || lease.owner !== owner) return null;
        lease.renewedAt = this.now();
        lease.expiresAt = lease.renewedAt + Math.max(1000, Number(ttlMs || this.defaultTtlMs));
        this.write(state);
        return clone(lease);
    }

    release(key, owner = null) {
        const state = this.read();
        const lease = state.leases[key];
        if (!lease || (owner && lease.owner !== owner)) return false;
        delete state.leases[key];
        this.write(state);
        return true;
    }

    releaseOwner(owner) {
        const state = this.read();
        let released = 0;
        for (const [key, lease] of Object.entries(state.leases)) {
            if (lease.owner !== owner) continue;
            delete state.leases[key];
            released++;
        }
        if (released > 0) this.write(state);
        return released;
    }

    active() {
        const state = this.read();
        const reaped = this.reapState(state);
        if (reaped) this.write(state);
        return clone(state.leases);
    }

    read() {
        const state = this.store.load();
        state.leases = plainObject(state.leases);
        return state;
    }

    write(state) {
        state.updatedAt = new Date(this.now()).toISOString();
        this.store.save(state);
    }

    reapState(state) {
        let changed = false;
        const now = this.now();
        for (const [key, lease] of Object.entries(state.leases || {})) {
            if (Number(lease.expiresAt || 0) > now) continue;
            delete state.leases[key];
            changed = true;
        }
        return changed;
    }
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = LeaseManager;
