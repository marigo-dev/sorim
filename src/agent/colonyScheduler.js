const LeaseManager = require('./leaseManager');

class ColonyScheduler {
    constructor(store, options = {}) {
        this.store = store;
        this.now = options.now || Date.now;
        this.leaseTtlMs = Math.max(1000, Number(options.leaseTtlMs || 120000));
        this.leases = options.leaseManager || new LeaseManager(store, {
            defaultTtlMs: this.leaseTtlMs,
            now: this.now
        });
    }

    enqueue(order) {
        if (!order?.id || !order?.tool) throw new Error('Work order id and tool are required');
        const state = this.read();
        const semanticKey = semanticTaskKey(order);
        const duplicate = state.workOrders.find(item =>
            !['failed', 'cancelled', 'complete'].includes(item.status) && (
                (order.dedupeKey && item.dedupeKey === order.dedupeKey) ||
                semanticTaskKey(item) === semanticKey
            )
        );
        if (duplicate) return clone(duplicate);
        const existing = state.workOrders.find(item => item.id === order.id);
        if (existing && !['failed', 'cancelled', 'complete'].includes(existing.status)) return clone(existing);
        const now = this.now();
        const workOrder = {
            priority: 50,
            professions: [],
            args: {},
            maxAttempts: 3,
            attempts: 0,
            status: 'queued',
            createdAt: now,
            semanticKey,
            ...clone(order),
            updatedAt: now
        };
        if (existing) state.workOrders[state.workOrders.indexOf(existing)] = workOrder;
        else state.workOrders.push(workOrder);
        this.write(state);
        return clone(workOrder);
    }

    dispatch(agent) {
        this.reconcileExpiredAssignments();
        const state = this.read();
        const current = state.workOrders.find(order =>
            order.status === 'assigned' && order.assignedTo === agent.id
        );
        if (current) {
            return {
                order: clone(current),
                lease: this.heartbeat(current.id, agent.id),
                resumed: true
            };
        }
        const candidates = state.workOrders
            .filter(order => order.status === 'queued')
            .filter(order => eligible(order, agent))
            .sort((left, right) => right.priority - left.priority || left.createdAt - right.createdAt);

        for (const order of candidates) {
            if (!this.claimReservations(order, agent.id)) continue;
            const lease = this.leases.claim(`work:${order.id}`, agent.id, {
                tool: order.tool,
                profession: agent.profession || null
            }, this.leaseTtlMs);
            if (!lease) {
                this.releaseReservations(order, agent.id);
                continue;
            }
            // LeaseManager persists independently. Reload before writing the
            // assignment so this write cannot overwrite the new leases.
            const latest = this.read();
            const assigned = latest.workOrders.find(item => item.id === order.id);
            if (!assigned || assigned.status !== 'queued') {
                this.leases.release(`work:${order.id}`, agent.id);
                this.releaseReservations(order, agent.id);
                continue;
            }
            assigned.status = 'assigned';
            assigned.assignedTo = agent.id;
            assigned.assignedAt = this.now();
            assigned.updatedAt = assigned.assignedAt;
            this.write(latest);
            return { order: clone(assigned), lease };
        }
        return null;
    }

    heartbeat(orderId, agentId) {
        const lease = this.leases.renew(`work:${orderId}`, agentId, this.leaseTtlMs);
        if (!lease) return null;
        const state = this.read();
        const order = state.workOrders.find(item => item.id === orderId && item.assignedTo === agentId);
        if (order) {
            order.updatedAt = this.now();
            this.renewReservations(order, agentId);
            this.write(state);
        }
        return lease;
    }

    complete(orderId, agentId, evidence = {}) {
        return this.finish(orderId, agentId, 'complete', evidence);
    }

    fail(orderId, agentId, error, retryable = true) {
        const state = this.read();
        const order = state.workOrders.find(item => item.id === orderId && item.assignedTo === agentId);
        if (!order) return null;
        order.attempts = Number(order.attempts || 0) + 1;
        order.lastError = String(error || 'unknown error').slice(0, 240);
        order.assignedTo = null;
        order.status = retryable && order.attempts < order.maxAttempts ? 'queued' : 'failed';
        order.updatedAt = this.now();
        this.write(state);
        this.leases.release(`work:${order.id}`, agentId);
        this.releaseReservations(order, agentId);
        return clone(order);
    }

    disconnect(agentId) {
        const state = this.read();
        let reassigned = 0;
        for (const order of state.workOrders) {
            if (order.assignedTo !== agentId || order.status !== 'assigned') continue;
            order.status = 'queued';
            order.assignedTo = null;
            order.updatedAt = this.now();
            reassigned++;
        }
        this.write(state);
        this.leases.releaseOwner(agentId);
        return reassigned;
    }

    cancel(orderId, reason = 'cancelled') {
        const state = this.read();
        const order = state.workOrders.find(item => item.id === orderId);
        if (!order || ['complete', 'failed', 'cancelled'].includes(order.status)) return null;
        const owner = order.assignedTo;
        order.status = 'cancelled';
        order.cancelReason = reason;
        order.assignedTo = null;
        order.updatedAt = this.now();
        this.write(state);
        if (owner) this.leases.release(`work:${order.id}`, owner);
        if (owner) this.releaseReservations(order, owner);
        return clone(order);
    }

    list(status = null) {
        this.reconcileExpiredAssignments();
        const state = this.read();
        return clone(status ? state.workOrders.filter(order => order.status === status) : state.workOrders);
    }

    finish(orderId, agentId, status, evidence) {
        const state = this.read();
        const order = state.workOrders.find(item => item.id === orderId && item.assignedTo === agentId);
        if (!order) return null;
        order.status = status;
        order.evidence = clone(evidence);
        order.completedAt = this.now();
        order.updatedAt = order.completedAt;
        this.write(state);
        this.leases.release(`work:${order.id}`, agentId);
        this.releaseReservations(order, agentId);
        return clone(order);
    }

    claimReservations(order, owner) {
        const claimed = [];
        for (const resource of order.reservations || []) {
            const key = `resource:${resource.key}`;
            const lease = this.leases.claim(key, owner, { orderId: order.id, amount: resource.amount || 1 }, this.leaseTtlMs);
            if (lease) {
                claimed.push(key);
                continue;
            }
            for (const claimedKey of claimed) this.leases.release(claimedKey, owner);
            return false;
        }
        return true;
    }

    renewReservations(order, owner) {
        for (const resource of order.reservations || []) {
            this.leases.renew(`resource:${resource.key}`, owner, this.leaseTtlMs);
        }
    }

    releaseReservations(order, owner) {
        for (const resource of order.reservations || []) {
            this.leases.release(`resource:${resource.key}`, owner);
        }
    }

    reconcileExpiredAssignments() {
        const leases = this.leases.active();
        const state = this.read();
        const released = [];
        let changed = false;
        for (const order of state.workOrders) {
            if (order.status !== 'assigned') continue;
            if (leases[`work:${order.id}`]?.owner === order.assignedTo) continue;
            released.push({ order: clone(order), owner: order.assignedTo });
            order.status = 'queued';
            order.assignedTo = null;
            order.updatedAt = this.now();
            changed = true;
        }
        if (changed) this.write(state);
        for (const entry of released) this.releaseReservations(entry.order, entry.owner);
        return changed;
    }

    read() {
        const state = this.store.load();
        state.workOrders = Array.isArray(state.workOrders) ? state.workOrders : [];
        return state;
    }

    write(state) {
        state.updatedAt = new Date(this.now()).toISOString();
        this.store.save(state);
    }
}

function eligible(order, agent) {
    if (agent.status === 'offline') return false;
    if (order.preferredAgent && order.preferredAgent !== agent.id) return false;
    return !order.professions?.length || order.professions.includes(agent.profession);
}

function semanticTaskKey(order) {
    if (order.semanticKey) return order.semanticKey;
    const args = Object.entries(order.args || {}).sort(([left], [right]) => left.localeCompare(right));
    return `${order.tool}:${JSON.stringify(Object.fromEntries(args))}`;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = ColonyScheduler;
