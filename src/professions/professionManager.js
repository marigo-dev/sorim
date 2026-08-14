const { resolveProfession } = require('./professionRegistry');
const { validateProfile, selectRoutine } = require('./professionFactory');

class ProfessionManager {
    constructor(memory, options = {}) {
        this.memory = memory;
        this.allowedToolNames = (options.tools || []).map(tool => typeof tool === 'string' ? tool : tool.name).filter(Boolean);
        this.validateToolCall = options.validateToolCall || (call => call);
        this.lastActionAt = 0;
        this.minimumIntervalMs = 1200;
        this.routineCursor = 0;
    }

    assign(value, assignedBy) {
        const profile = this.resolve(value);
        if (!profile) return null;
        this.memory.setProfession(profile.id, assignedBy);
        return profile;
    }

    createAndAssign(value, assignedBy) {
        const validation = validateProfile(value, this.allowedToolNames);
        if (!validation.ok) return validation;
        const invalidRoutine = validation.profile.routines.find(routine => !this.validateToolCall({
            tool: routine.tool,
            args: routine.args,
            reason: routine.reason
        }));
        if (invalidRoutine) {
            return { ok: false, error: `Routine arguments are invalid for ${invalidRoutine.tool}` };
        }
        this.memory.saveCustomProfession(validation.profile);
        this.memory.setProfession(validation.profile.id, assignedBy);
        return { ok: true, profile: validation.profile };
    }

    stop() {
        this.memory.stopProfession();
    }

    current() {
        const saved = this.memory.getProfession();
        if (!saved) return null;
        const profile = this.resolve(saved.id);
        return profile ? { ...profile, ...saved } : null;
    }

    resolve(value) {
        const builtIn = resolveProfession(value);
        if (builtIn) return builtIn;
        const normalized = String(value || '').toLocaleLowerCase('tr-TR');
        return Object.values(this.memory.getCustomProfessions?.() || {}).find(profile =>
            profile.id === normalized || profile.aliases?.includes(normalized)
        ) || null;
    }

    nextTool(observation) {
        const profession = this.current();
        if (!profession || profession.status !== 'active') return null;
        if (Date.now() - this.lastActionAt < this.minimumIntervalMs) return null;
        const call = profession.custom
            ? selectCustomProfessionTool(profession, observation, this.routineCursor++)
            : selectProfessionTool(profession.id, observation);
        const validated = call ? this.validateToolCall(call) : null;
        if (validated) this.lastActionAt = Date.now();
        return validated;
    }
}

function selectCustomProfessionTool(profile, observation, cursor) {
    const routine = selectRoutine(profile, observation, cursor);
    if (routine?.tool === 'organize_storage' && !observation?.base) {
        return call('ensure_base', {}, `${profile.displayName}: establish a safe workplace before storage`);
    }
    return routine ? call(routine.tool, routine.args, `${profile.displayName}: ${routine.reason}`) : null;
}

function selectProfessionTool(id, observation) {
    const inventory = observation?.inventory || {};
    if (id === 'farmer') {
        if (!observation.farmReady) return call('establish_wheat_farm', {}, 'Farmer: establish a sustainable food farm');
        if (observation.hasMatureCrop) {
            return call('maintain_food_supply', {}, 'Farmer: harvest, replant, expand, or inspect crops');
        }
        return call('care_for_animals', {}, 'Farmer: tend animals while crops are growing');
    }
    if (id === 'rancher') {
        return call('care_for_animals', {}, 'Rancher: feed and breed nearby livestock');
    }
    if (id === 'lumberjack') {
        const logs = totalBySuffix(inventory, '_log');
        if (logs >= 32 && observation.hasUsableChest) return call('organize_storage', {}, 'Lumberjack: deposit the wood stock');
        if (totalBySuffix(inventory, '_sapling') >= 1) {
            return call('replant_sapling', {}, 'Lumberjack: replace harvested trees outside protected builds');
        }
        return call('mine_block', { target: 'any_log' }, 'Lumberjack: harvest a safe natural tree');
    }
    if (id === 'miner') {
        const torches = inventory.torch || 0;
        const hasStonePick = (inventory.stone_pickaxe || 0) + (inventory.iron_pickaxe || 0) > 0;
        if (!hasStonePick || torches < 16) return call('prepare_mining_kit', {}, 'Miner: prepare tools, food, and torches');
        return call('mine_iron', { count: 16 }, 'Miner: operate the safe stair mine');
    }
    if (id === 'builder') {
        if (!observation.base) return call('ensure_base', {}, 'Builder: establish a safe first base on suitable terrain');
        return call('organize_storage', {}, 'Builder: maintain the established base');
    }
    if (id === 'quartermaster') return call('organize_storage', {}, 'Quartermaster: maintain categorized supplies');
    if (id === 'guard') return call('wait_safe', { ms: 1200 }, 'Guard: patrol is quiet; stay alert near base');
    if (id === 'fisher') return call('fish', {}, 'Fisher: catch food from safe open water');
    return null;
}

function call(tool, args, reason) {
    return { tool, args, reason };
}

function totalBySuffix(inventory, suffix) {
    return Object.entries(inventory)
        .filter(([name]) => name.endsWith(suffix))
        .reduce((sum, [, count]) => sum + count, 0);
}

module.exports = ProfessionManager;
