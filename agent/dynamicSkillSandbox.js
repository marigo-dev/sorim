const MAX_TEMPLATE_STEPS = 12;
const MAX_EXPANDED_STEPS = 24;
const MAX_REPEAT = 3;

const SAFE_TOOL_NAMES = new Set([
    'explore', 'mine_block', 'craft_item', 'place_block', 'collect_stone',
    'craft_stone_tools', 'build_shelter', 'ensure_base', 'eat_food',
    'find_food', 'maintain_food_supply', 'care_for_animals', 'fish',
    'replant_sapling', 'emergency_shelter', 'escape_pit', 'escape_water',
    'return_base', 'wait_safe', 'sleep_bed', 'secure_bed',
    'establish_wheat_farm', 'organize_storage', 'prepare_mining_kit',
    'mine_iron', 'smelt_item', 'craft_iron_kit', 'craft_iron_armor',
    'build_blueprint'
]);

function compile(profile, options = {}) {
    const registry = requireRegistry(options);
    const source = profile && typeof profile === 'object' ? profile : {};
    const id = normalizeId(source.id || source.name);
    if (!id) return failure('Skill id is required.');

    const rawSteps = Array.isArray(source.steps) ? source.steps.slice(0, MAX_TEMPLATE_STEPS) : [];
    if (rawSteps.length === 0) return failure('A dynamic skill needs at least one step.');

    const parameters = sanitizeRecord(source.parameters);
    const steps = [];
    for (const rawStep of rawSteps) {
        const tool = String(rawStep?.tool || '');
        if (!SAFE_TOOL_NAMES.has(tool)) return failure(`Tool ${tool || '(missing)'} is not allowed in dynamic skills.`);
        const repeat = clampInteger(rawStep.repeat, 1, MAX_REPEAT, 1);
        const templateArgs = sanitizeTemplate(rawStep.args || {});
        for (let index = 0; index < repeat; index++) {
            const call = {
                tool,
                args: resolveTemplate(templateArgs, parameters),
                reason: String(rawStep.reason || `${id}: ${tool}`).slice(0, 180)
            };
            const valid = registry.validateToolCall(registry.normalizeToolCall(call), registry.tools);
            if (!valid) return failure(`Step ${tool} does not match its tool schema.`);
            steps.push({ ...valid, repeatIndex: index + 1 });
            if (steps.length > MAX_EXPANDED_STEPS) return failure('Dynamic skill expands beyond the operation limit.');
        }
    }

    return {
        ok: true,
        profile: {
            id,
            displayName: String(source.displayName || source.name || id).slice(0, 80),
            purpose: String(source.purpose || `Player-defined skill ${id}.`).slice(0, 240),
            parameters,
            steps: rawSteps.map(step => ({
                tool: String(step.tool),
                args: sanitizeTemplate(step.args || {}),
                reason: String(step.reason || '').slice(0, 180),
                repeat: clampInteger(step.repeat, 1, MAX_REPEAT, 1)
            })),
            createdAt: Date.now()
        },
        steps: steps.map(({ repeatIndex, ...step }) => step)
    };
}

function instantiate(profile, parameterOverrides = {}, options = {}) {
    const merged = {
        ...profile,
        parameters: { ...sanitizeRecord(profile?.parameters), ...sanitizeRecord(parameterOverrides) }
    };
    return compile(merged, options);
}

function requireRegistry(options) {
    if (!Array.isArray(options.tools) || typeof options.validateToolCall !== 'function' ||
        typeof options.normalizeToolCall !== 'function') {
        throw new Error('Dynamic skill sandbox requires a tool registry.');
    }
    return options;
}

function resolveTemplate(value, parameters) {
    if (typeof value === 'string' && /^\$param\.[a-zA-Z0-9_]+$/.test(value)) {
        return parameters[value.slice(7)];
    }
    if (Array.isArray(value)) return value.map(entry => resolveTemplate(entry, parameters));
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveTemplate(entry, parameters)]));
    }
    return value;
}

function sanitizeTemplate(value, depth = 0) {
    if (depth > 4) return null;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if (Array.isArray(value)) return value.slice(0, 16).map(entry => sanitizeTemplate(entry, depth + 1));
    if (!value || typeof value !== 'object') return null;
    return Object.fromEntries(Object.entries(value).slice(0, 24).map(([key, entry]) => [
        String(key).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40),
        sanitizeTemplate(entry, depth + 1)
    ]).filter(([key]) => key));
}

function sanitizeRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([key, entry]) => [
        String(key).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 40),
        sanitizeTemplate(entry)
    ]).filter(([key]) => key));
}

function normalizeId(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.floor(number))) : fallback;
}

function failure(error) {
    return { ok: false, error };
}

module.exports = {
    SAFE_TOOL_NAMES,
    compile,
    instantiate
};
