class ColonyBlackboard {
    constructor(options = {}) {
        this.now = options.now || Date.now;
        this.agentTtlMs = Math.max(1000, Number(options.agentTtlMs || 15000));
        this.agents = new Map();
        this.events = [];
        this.maxEvents = Math.max(10, Number(options.maxEvents || 80));
    }

    publish(agentId, observation, metadata = {}) {
        if (!agentId) throw new Error('agentId is required');
        const state = compactObservation(observation);
        const entry = {
            agentId,
            username: metadata.username || agentId,
            characterId: metadata.characterId || null,
            profession: metadata.profession || null,
            status: metadata.status || 'running',
            taskId: metadata.taskId || null,
            updatedAt: this.now(),
            state
        };
        this.agents.set(agentId, entry);
        return clone(entry);
    }

    markOffline(agentId, reason = 'disconnected') {
        const current = this.agents.get(agentId);
        if (!current) return null;
        current.status = 'offline';
        current.offlineReason = reason;
        current.updatedAt = this.now();
        this.pushEvent('agent_offline', { agentId, reason });
        return clone(current);
    }

    pushEvent(type, data = {}) {
        const event = { type, at: this.now(), ...clone(data) };
        this.events.push(event);
        this.events = this.events.slice(-this.maxEvents);
        return clone(event);
    }

    snapshot() {
        const now = this.now();
        const agents = Array.from(this.agents.values()).map(entry => ({
            ...entry,
            stale: entry.status !== 'offline' && now - entry.updatedAt > this.agentTtlMs
        }));
        return {
            generatedAt: now,
            agents: clone(agents),
            totals: aggregateInventories(agents),
            shortages: summarizeShortages(agents),
            events: clone(this.events.slice(-20))
        };
    }
}

function compactObservation(observation = {}) {
    return {
        health: finite(observation.health, 20),
        food: finite(observation.food, 20),
        oxygen: finite(observation.oxygen ?? observation.oxygenLevel, 20),
        position: vector(observation.position),
        dimension: observation.worldState?.environment?.dimension || observation.dimension || 'overworld',
        phase: observation.worldState?.environment?.phase || observation.phase || 'unknown',
        inventory: compactInventory(observation.inventory),
        hostiles: (observation.nearbyMobs || observation.hostiles || [])
            .filter(entity => isHostile(entity.name))
            .slice(0, 5)
            .map(entity => ({ name: entity.name, distance: finite(entity.distance, null) })),
        baseDistance: distance(observation.position, observation.base),
        baseKnown: Boolean(observation.base),
        lastError: observation.lastError ? String(observation.lastError).slice(0, 160) : null
    };
}

function compactInventory(inventory = {}) {
    return Object.fromEntries(Object.entries(inventory)
        .filter(([, count]) => Number(count) > 0)
        .sort(([left], [right]) => left.localeCompare(right))
        .slice(0, 48)
        .map(([name, count]) => [name, Number(count)]));
}

function aggregateInventories(agents) {
    const totals = {};
    for (const agent of agents) {
        if (agent.status === 'offline') continue;
        for (const [name, count] of Object.entries(agent.state.inventory || {})) {
            totals[name] = (totals[name] || 0) + Number(count || 0);
        }
    }
    return totals;
}

function summarizeShortages(agents) {
    const active = agents.filter(agent => agent.status !== 'offline');
    return {
        hungryAgents: active.filter(agent => agent.state.food <= 12).map(agent => agent.agentId),
        injuredAgents: active.filter(agent => agent.state.health <= 12).map(agent => agent.agentId),
        agentsWithoutBase: active.filter(agent =>
            !agent.state.baseKnown || agent.state.baseDistance == null || agent.state.baseDistance > 64
        ).map(agent => agent.agentId),
        offlineAgents: agents.filter(agent => agent.status === 'offline').map(agent => agent.agentId)
    };
}

function isHostile(name) {
    return ['zombie', 'skeleton', 'creeper', 'spider', 'witch', 'drowned', 'husk', 'stray', 'phantom']
        .includes(String(name || '').toLowerCase());
}

function vector(value) {
    if (!value) return null;
    return { x: finite(value.x, 0), y: finite(value.y, 0), z: finite(value.z, 0) };
}

function distance(left, right) {
    if (!left || !right) return null;
    return Number(Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z).toFixed(1));
}

function finite(value, fallback) {
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

module.exports = ColonyBlackboard;
module.exports.compactObservation = compactObservation;
