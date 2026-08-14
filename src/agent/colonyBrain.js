class ColonyBrain {
    constructor(options) {
        this.scheduler = options.scheduler;
        this.blackboard = options.blackboard;
        this.planWithLlm = options.planWithLlm || null;
        this.now = options.now || Date.now;
        this.minimumPlanIntervalMs = Number(options.minimumPlanIntervalMs || 30000);
        this.allowedTools = new Set(options.allowedTools || []);
        this.normalizeToolCall = options.normalizeToolCall || null;
        this.lastPlanAt = 0;
        this.sequence = 0;
    }

    async plan(options = {}) {
        const snapshot = this.blackboard.snapshot();
        const existing = this.scheduler.list().filter(order => ['queued', 'assigned'].includes(order.status));
        if (!options.force && this.now() - this.lastPlanAt < this.minimumPlanIntervalMs) {
            return { source: 'cooldown', created: [], snapshot };
        }
        this.lastPlanAt = this.now();

        let proposals = [];
        if (this.planWithLlm) {
            try {
                proposals = sanitizeProposals(await this.planWithLlm({ snapshot, existing }), this.allowedTools);
            } catch (error) {
                this.blackboard.pushEvent('brain_error', { message: error.message });
            }
        }
        if (proposals.length === 0) proposals = deterministicPlan(snapshot, existing);
        proposals = proposals
            .map(proposal => normalizeProposal(proposal, this.normalizeToolCall))
            .filter(Boolean)
            .map(proposal => adaptProfessions(proposal, snapshot))
            .filter(proposal => isProposalRelevant(proposal, snapshot));
        if (proposals.length === 0) {
            proposals = deterministicPlan(snapshot, existing)
                .map(proposal => normalizeProposal(proposal, this.normalizeToolCall))
                .filter(Boolean)
                .map(proposal => adaptProfessions(proposal, snapshot))
                .filter(proposal => isProposalRelevant(proposal, snapshot));
        }
        const created = proposals.map(proposal => this.scheduler.enqueue({
            id: proposal.id || `brain_${this.now()}_${++this.sequence}`,
            ...proposal
        }));
        this.blackboard.pushEvent('colony_plan', {
            source: proposals.some(proposal => proposal.source === 'llm') ? 'llm' : 'deterministic',
            workOrderIds: created.map(order => order.id)
        });
        return { source: proposals.some(proposal => proposal.source === 'llm') ? 'llm' : 'deterministic', created, snapshot };
    }
}

function deterministicPlan(snapshot, existing) {
    const activeKeys = new Set(existing.map(order => order.dedupeKey || `${order.tool}:${JSON.stringify(order.args || {})}`));
    const proposals = [];
    const add = proposal => {
        const key = proposal.dedupeKey || `${proposal.tool}:${JSON.stringify(proposal.args || {})}`;
        if (activeKeys.has(key)) return;
        activeKeys.add(key);
        proposals.push({ ...proposal, dedupeKey: key, source: 'deterministic' });
    };

    for (const agentId of snapshot.shortages.hungryAgents) {
        add({
            tool: 'maintain_food_supply',
            args: {},
            priority: 90,
            professions: ['farmer', 'rancher', 'fisher'],
            dedupeKey: 'colony:food_emergency',
            reason: `${agentId} needs a reliable food reserve`
        });
    }
    if ((snapshot.totals.cobblestone || 0) < 32) {
        add({ tool: 'collect_stone', args: { count: 16 }, priority: 60, professions: ['miner'], dedupeKey: 'stock:cobblestone', reason: 'Replenish colony building stone' });
    }
    const logs = Object.entries(snapshot.totals).filter(([name]) => name.endsWith('_log')).reduce((sum, [, count]) => sum + count, 0);
    if (logs < 16) {
        add({ tool: 'mine_block', args: { target: 'any_log' }, priority: 55, professions: ['lumberjack'], dedupeKey: 'stock:logs', reason: 'Replenish protected wood stock' });
    }
    if (snapshot.shortages.agentsWithoutBase.length > 0) {
        add({ tool: 'ensure_base', args: {}, priority: 75, professions: ['builder'], dedupeKey: 'colony:starter_base', reason: 'Establish a safe shared settlement' });
    }
    return proposals;
}

function sanitizeProposals(value, allowedTools = new Set()) {
    const proposals = Array.isArray(value) ? value : value?.orders;
    if (!Array.isArray(proposals)) return [];
    return proposals.filter(order => order && typeof order.tool === 'string')
        .filter(order => allowedTools.size === 0 || allowedTools.has(order.tool))
        .slice(0, 8)
        .map(order => ({
            tool: order.tool,
            args: plainObject(order.args),
            priority: Math.max(1, Math.min(100, Number(order.priority || 50))),
            professions: Array.isArray(order.professions) ? order.professions.slice(0, 4) : [],
            reason: String(order.reason || 'Colony AI work order').slice(0, 160),
            dedupeKey: order.dedupeKey ? String(order.dedupeKey).slice(0, 100) : undefined,
            source: 'llm'
        }));
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function normalizeProposal(proposal, normalizer) {
    if (!normalizer) return proposal;
    const call = normalizer({ tool: proposal.tool, args: proposal.args, reason: proposal.reason });
    return call ? { ...proposal, tool: call.tool, args: call.args, reason: call.reason } : null;
}

function adaptProfessions(proposal, snapshot) {
    const available = new Set((snapshot.agents || [])
        .filter(agent => agent.status !== 'offline' && !agent.stale)
        .map(agent => agent.profession)
        .filter(Boolean));
    const canonical = canonicalProfessions(proposal);
    const requested = canonical.length > 0 ? canonical : (proposal.professions || []);
    const eligible = requested.filter(profession => available.has(profession));
    if (eligible.length > 0) {
        return { ...proposal, professions: eligible };
    }
    return { ...proposal, professions: [] };
}

function canonicalProfessions(proposal) {
    if (['collect_stone', 'prepare_mining_kit', 'mine_iron'].includes(proposal.tool)) return ['miner'];
    if (proposal.tool === 'mine_block' && proposal.args?.target === 'any_log') return ['lumberjack'];
    if (proposal.tool === 'fish') return ['fisher'];
    if (proposal.tool === 'care_for_animals') return ['farmer', 'rancher'];
    if (proposal.tool === 'maintain_food_supply') return ['farmer', 'rancher', 'fisher'];
    if (proposal.tool === 'build_colony_marker') return ['builder'];
    if (proposal.tool === 'organize_storage') return ['quartermaster', 'builder'];
    return [];
}

function isProposalRelevant(proposal, snapshot) {
    if (proposal.tool === 'ensure_base') return snapshot.shortages.agentsWithoutBase.length > 0;
    if (['maintain_food_supply', 'care_for_animals', 'fish'].includes(proposal.tool)) {
        return snapshot.shortages.hungryAgents.length > 0 || totalFood(snapshot.totals) < 16;
    }
    if (proposal.tool === 'collect_stone') return Number(snapshot.totals.cobblestone || 0) < 32;
    if (proposal.tool === 'mine_block' && proposal.args?.target === 'any_log') {
        const logs = Object.entries(snapshot.totals || {})
            .filter(([name]) => name.endsWith('_log'))
            .reduce((sum, [, count]) => sum + Number(count || 0), 0);
        return logs < 16;
    }
    return true;
}

function totalFood(inventory) {
    const food = new Set([
        'bread', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken',
        'beef', 'porkchop', 'mutton', 'chicken', 'apple', 'carrot', 'potato',
        'baked_potato', 'cod', 'salmon', 'cooked_cod', 'cooked_salmon'
    ]);
    return Object.entries(inventory || {}).filter(([name]) => food.has(name))
        .reduce((sum, [, count]) => sum + Number(count || 0), 0);
}

module.exports = ColonyBrain;
module.exports.deterministicPlan = deterministicPlan;
