const ID_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
const MAX_ROUTINES = 10;

function validateProfile(input, allowedToolNames) {
    if (!input || typeof input !== 'object') return failure('Profession profile is missing');
    const allowed = new Set(allowedToolNames || []);
    const id = slug(input.id || input.displayName);
    if (!ID_PATTERN.test(id)) return failure('Profession id must be a short ASCII identifier');

    const routines = (Array.isArray(input.routines) ? input.routines : [])
        .slice(0, MAX_ROUTINES)
        .map(normalizeRoutine)
        .filter(Boolean);
    const invalid = routines.find(routine => !allowed.has(routine.tool));
    if (invalid) return failure(`Profession requested unavailable tool ${invalid.tool}`);
    if (routines.length === 0) return failure('Profession needs at least one available routine');

    const profile = {
        id,
        displayName: String(input.displayName || id).slice(0, 48),
        purpose: String(input.purpose || `Work as ${id}`).slice(0, 240),
        aliases: unique([id, ...(Array.isArray(input.aliases) ? input.aliases : [])]
            .map(value => String(value).toLocaleLowerCase('tr-TR').slice(0, 40))),
        routines,
        protectedBlocks: unique((input.protectedBlocks || []).map(value => String(value).slice(0, 64))).slice(0, 24),
        stockTargets: normalizeStockTargets(input.stockTargets),
        custom: true,
        version: 1
    };
    return { ok: true, profile };
}

function selectRoutine(profile, observation, cursor = 0) {
    const routines = (profile?.routines || []).filter(routine =>
        matches(routine.when, observation) && hasImplicitResources(routine, observation)
    );
    if (routines.length === 0) return null;
    return routines[Math.abs(Number(cursor || 0)) % routines.length];
}

function normalizeRoutine(value) {
    if (!value || typeof value.tool !== 'string') return null;
    return {
        tool: value.tool,
        args: value.args && typeof value.args === 'object' && !Array.isArray(value.args) ? { ...value.args } : {},
        reason: String(value.reason || `Profession routine: ${value.tool}`).slice(0, 180),
        when: normalizeCondition(value.when)
    };
}

function normalizeCondition(value) {
    if (!value || typeof value !== 'object') return { type: 'always' };
    const type = ['always', 'inventory_below', 'inventory_at_least', 'observation_equals'].includes(value.type)
        ? value.type : 'always';
    if (type === 'inventory_below' || type === 'inventory_at_least') {
        return { type, item: String(value.item || '').slice(0, 64), count: Math.max(0, Number(value.count || 0)) };
    }
    if (type === 'observation_equals') {
        return { type, field: String(value.field || '').slice(0, 64), value: primitive(value.value) };
    }
    return { type: 'always' };
}

function matches(condition, observation) {
    if (!condition || condition.type === 'always') return true;
    if (condition.type === 'inventory_below') {
        return inventoryCount(observation?.inventory, condition.item) < condition.count;
    }
    if (condition.type === 'inventory_at_least') {
        return inventoryCount(observation?.inventory, condition.item) >= condition.count;
    }
    if (condition.type === 'observation_equals') return observation?.[condition.field] === condition.value;
    return false;
}

function hasImplicitResources(routine, observation) {
    if (routine.tool === 'replant_sapling') {
        return inventoryCount(observation?.inventory, 'sapling') > 0;
    }
    return true;
}

function inventoryCount(inventory, item) {
    const entries = Object.entries(inventory || {});
    if (['log', 'logs', 'any_log'].includes(item)) {
        return entries.filter(([name]) => name.endsWith('_log')).reduce((sum, [, count]) => sum + Number(count || 0), 0);
    }
    if (['sapling', 'saplings', 'any_sapling'].includes(item)) {
        return entries.filter(([name]) => name.endsWith('_sapling')).reduce((sum, [, count]) => sum + Number(count || 0), 0);
    }
    if (['food', 'edible'].includes(item)) {
        const foods = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_cod', 'cooked_salmon', 'apple', 'carrot', 'baked_potato']);
        return entries.filter(([name]) => foods.has(name)).reduce((sum, [, count]) => sum + Number(count || 0), 0);
    }
    return Number(inventory?.[item] || 0);
}

function normalizeStockTargets(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 24)
        .map(([name, count]) => [String(name).slice(0, 64), Math.max(0, Math.min(4096, Number(count || 0)))]));
}

function slug(value) {
    return String(value || '').toLocaleLowerCase('en-US')
        .normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
}

function primitive(value) {
    return ['string', 'number', 'boolean'].includes(typeof value) ? value : null;
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function failure(error) {
    return { ok: false, error };
}

module.exports = { validateProfile, selectRoutine };
