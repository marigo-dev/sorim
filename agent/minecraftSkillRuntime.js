const { Vec3 } = require('vec3');
const movement = require('../skills/movement');
const actionControl = require('../skills/actionControl');
const blockPolicy = require('../safety/blockPolicy');
const shelter = require('../skills/shelter');

const ALLOWED_OPERATIONS = new Set([
    'move', 'look', 'mine', 'place', 'wait'
]);
const ALLOWED_POSTCONDITIONS = new Set([
    'block_equals', 'block_not_equals', 'inventory_at_least',
    'inventory_delta_at_least', 'position_near'
]);

function validateProgram(source = {}) {
    const capabilities = normalizeCapabilities(source.capabilities || {});
    const operations = Array.isArray(source.program) ? source.program : [];
    const postconditions = Array.isArray(source.postconditions) ? source.postconditions : [];
    if (operations.length === 0) return failed('Bytecode program needs at least one operation.');
    if (operations.length > capabilities.maxOperations) return failed('Program exceeds its operation budget.');
    if (postconditions.length === 0) return failed('Bytecode program needs at least one postcondition.');
    if (postconditions.length > 8) return failed('Program has too many postconditions.');

    let mutations = 0;
    const program = [];
    for (const raw of operations) {
        const op = String(raw?.op || '');
        if (!ALLOWED_OPERATIONS.has(op)) return failed(`Operation ${op || '(missing)'} is not allowed.`);
        const operation = normalizeOperation(raw, capabilities);
        if (!operation.ok) return operation;
        if (['mine', 'place'].includes(op)) mutations++;
        if (mutations > capabilities.maxMutations) return failed('Program exceeds its mutation budget.');
        program.push(operation.value);
    }

    const normalizedPostconditions = [];
    for (const raw of postconditions) {
        const condition = normalizePostcondition(raw, capabilities);
        if (!condition.ok) return condition;
        normalizedPostconditions.push(condition.value);
    }

    return {
        ok: true,
        capabilities,
        program,
        postconditions: normalizedPostconditions
    };
}

async function execute(bot, profile) {
    const validated = validateProgram(profile);
    if (!validated.ok) throw new Error(validated.error);
    const { capabilities, program, postconditions } = validated;
    const origin = floorPosition(bot.entity.position);
    const beforeInventory = countInventory(bot);
    const actionVersion = actionControl.snapshot(bot);
    const deadline = Date.now() + capabilities.maxDurationMs;
    let mutations = 0;

    for (let index = 0; index < program.length; index++) {
        assertBudget(bot, actionVersion, deadline);
        const operation = program[index];
        const target = operation.offset ? origin.plus(offsetVector(operation.offset)) : null;
        if (target) assertInsideArea(origin, target, capabilities);
        console.log(`[DYNAMIC_SKILL] id=${profile.id} op=${index + 1}/${program.length} type=${operation.op}`);

        if (operation.op === 'move') {
            await movement.moveNear(bot, target, operation.range, Math.min(10000, remaining(deadline)));
        } else if (operation.op === 'look') {
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
        } else if (operation.op === 'wait') {
            await movement.sleep(Math.min(operation.ms, remaining(deadline)));
        } else if (operation.op === 'mine') {
            assertMutationAllowed(origin, target, operation.block, capabilities, 'mine');
            const block = bot.blockAt(target);
            if (!block || block.name !== operation.block) {
                throw new Error(`Expected ${operation.block} at ${target.toString()}, found ${block?.name || 'nothing'}.`);
            }
            const policy = blockPolicy.canBreak(bot, block, 'dynamic_skill');
            if (!policy.allowed) throw new Error(`Dynamic mining denied: ${policy.reason}`);
            if (hasUnsafeMiningNeighbor(bot, target)) {
                throw new Error('Dynamic mining denied near fluid, gravity, or redstone updates.');
            }
            await approachReach(bot, target, deadline);
            await require('../skills/mine').clearBlock(bot, block);
            const after = bot.blockAt(target);
            if (after?.name === operation.block) throw new Error(`Mining ${operation.block} was not reflected in the world.`);
            mutations++;
        } else if (operation.op === 'place') {
            assertMutationAllowed(origin, target, operation.item, capabilities, 'place');
            if (blockPolicy.protectedZoneAt(target)) throw new Error('Dynamic placement denied inside a protected zone.');
            const current = bot.blockAt(target);
            if (!isAir(current)) throw new Error(`Placement target contains ${current?.name || 'an unknown block'}.`);
            await approachReach(bot, target, deadline);
            const placed = await shelter.placeSpecific(bot, operation.item, target);
            if (!placed || bot.blockAt(target)?.name !== operation.item) {
                throw new Error(`Placement of ${operation.item} was not confirmed.`);
            }
            mutations++;
        }
    }

    assertBudget(bot, actionVersion, deadline);
    const assertions = postconditions.map(condition => evaluatePostcondition(
        bot, condition, origin, beforeInventory, capabilities
    ));
    const failedAssertions = assertions.filter(assertion => !assertion.ok);
    if (failedAssertions.length > 0) {
        throw new Error(`Dynamic skill postcondition failed: ${failedAssertions.map(entry => entry.reason).join('; ')}`);
    }
    return {
        status: 'verified',
        skillId: profile.id,
        operations: program.length,
        mutations,
        origin: vector(origin),
        assertions
    };
}

function normalizeCapabilities(raw) {
    return {
        radius: clampInteger(raw.radius, 1, 8, 5),
        vertical: clampInteger(raw.vertical, 1, 6, 4),
        maxOperations: clampInteger(raw.maxOperations, 1, 32, 16),
        maxMutations: clampInteger(raw.maxMutations, 0, 16, 8),
        maxDurationMs: clampInteger(raw.maxDurationMs, 1000, 60000, 30000),
        mutableBlocks: [...new Set((Array.isArray(raw.mutableBlocks) ? raw.mutableBlocks : [])
            .map(normalizeName).filter(name => name && !isDangerousMutable(name)))].slice(0, 16)
    };
}

function normalizeOperation(raw, capabilities) {
    const op = String(raw.op);
    if (op === 'wait') return passed({ op, ms: clampInteger(raw.ms, 50, 2000, 250) });
    const offset = normalizeOffset(raw.offset);
    if (!offset || !offsetInside(offset, capabilities)) return failed(`${op} has an invalid or out-of-bounds offset.`);
    if (op === 'move') return passed({ op, offset, range: clampNumber(raw.range, 0.5, 3, 1) });
    if (op === 'look') return passed({ op, offset });
    if (op === 'mine') {
        const block = normalizeName(raw.block);
        if (!block || !capabilities.mutableBlocks.includes(block)) return failed(`Mining ${block || '(missing)'} is not permitted.`);
        return passed({ op, offset, block });
    }
    if (op === 'place') {
        const item = normalizeName(raw.item);
        if (!item || !capabilities.mutableBlocks.includes(item)) return failed(`Placing ${item || '(missing)'} is not permitted.`);
        return passed({ op, offset, item });
    }
    return failed(`Unsupported operation ${op}.`);
}

function normalizePostcondition(raw, capabilities) {
    const type = String(raw?.type || '');
    if (!ALLOWED_POSTCONDITIONS.has(type)) return failed(`Postcondition ${type || '(missing)'} is not allowed.`);
    if (['inventory_at_least', 'inventory_delta_at_least'].includes(type)) {
        const item = normalizeName(raw.item);
        if (!item) return failed(`${type} requires an item.`);
        return passed({ type, item, count: clampInteger(raw.count, 1, 64, 1) });
    }
    const offset = normalizeOffset(raw.offset);
    if (!offset || !offsetInside(offset, capabilities)) return failed(`${type} has an invalid or out-of-bounds offset.`);
    if (type === 'position_near') {
        return passed({ type, offset, range: clampNumber(raw.range, 0.5, 4, 1.5) });
    }
    const block = normalizeName(raw.block);
    if (!block) return failed(`${type} requires a block.`);
    return passed({ type, offset, block });
}

function evaluatePostcondition(bot, condition, origin, beforeInventory, capabilities) {
    if (condition.type === 'inventory_at_least') {
        const actual = countInventory(bot)[condition.item] || 0;
        return assertion(actual >= condition.count, `${condition.item}=${actual}, expected >=${condition.count}`);
    }
    if (condition.type === 'inventory_delta_at_least') {
        const actual = (countInventory(bot)[condition.item] || 0) - (beforeInventory[condition.item] || 0);
        return assertion(actual >= condition.count, `${condition.item} delta=${actual}, expected >=${condition.count}`);
    }
    const target = origin.plus(offsetVector(condition.offset));
    assertInsideArea(origin, target, capabilities);
    if (condition.type === 'position_near') {
        const distance = bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5));
        return assertion(distance <= condition.range, `position distance=${distance.toFixed(2)}, expected <=${condition.range}`);
    }
    const actual = bot.blockAt(target)?.name || 'unknown';
    const ok = condition.type === 'block_equals' ? actual === condition.block : actual !== condition.block;
    return assertion(ok, `block=${actual}, ${condition.type} ${condition.block}`);
}

function assertMutationAllowed(origin, target, name, capabilities, operation) {
    assertInsideArea(origin, target, capabilities);
    if (!capabilities.mutableBlocks.includes(name)) throw new Error(`${operation} of ${name} is outside the capability list.`);
}

async function approachReach(bot, target, deadline) {
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(target.offset(0.5, 0.5, 0.5)) <= 4.25) return;
    await movement.moveNear(bot, target, 3, Math.min(8000, remaining(deadline)));
}

function assertBudget(bot, version, deadline) {
    actionControl.assertActive(bot, version);
    if (Date.now() > deadline) throw new Error('Dynamic skill exceeded its duration budget.');
}

function assertInsideArea(origin, target, capabilities) {
    const horizontal = Math.hypot(target.x - origin.x, target.z - origin.z);
    const vertical = Math.abs(target.y - origin.y);
    if (horizontal > capabilities.radius || vertical > capabilities.vertical) {
        throw new Error('Dynamic skill attempted to leave its mutable area.');
    }
}

function normalizeOffset(value) {
    const numbers = [Number(value?.x), Number(value?.y), Number(value?.z)];
    if (!numbers.every(Number.isFinite)) return null;
    return { x: Math.trunc(numbers[0]), y: Math.trunc(numbers[1]), z: Math.trunc(numbers[2]) };
}

function offsetInside(offset, capabilities) {
    return Math.hypot(offset.x, offset.z) <= capabilities.radius && Math.abs(offset.y) <= capabilities.vertical;
}

function offsetVector(offset) {
    return new Vec3(offset.x, offset.y, offset.z);
}

function floorPosition(value) {
    return new Vec3(Math.floor(value.x), Math.floor(value.y), Math.floor(value.z));
}

function countInventory(bot) {
    const result = {};
    for (const item of bot.inventory.items()) result[item.name] = (result[item.name] || 0) + item.count;
    return result;
}

function normalizeName(value) {
    const name = String(value || '').toLowerCase();
    return /^[a-z0-9_]{1,64}$/.test(name) ? name : '';
}

function isDangerousMutable(name) {
    const exact = new Set([
        'tnt', 'respawn_anchor', 'end_crystal', 'fire', 'soul_fire',
        'lava', 'water', 'lava_bucket', 'water_bucket', 'powder_snow_bucket',
        'piston', 'sticky_piston', 'observer', 'dispenser', 'dropper',
        'redstone_block', 'redstone_wire', 'redstone_torch', 'repeater',
        'comparator', 'target', 'sculk_sensor', 'calibrated_sculk_sensor',
        'command_block', 'chain_command_block', 'repeating_command_block',
        'structure_block', 'jigsaw', 'sand', 'red_sand', 'gravel',
        'anvil', 'chipped_anvil', 'damaged_anvil', 'dragon_egg'
    ]);
    return exact.has(name) || name.endsWith('_bed') || name.endsWith('_door') ||
        name.endsWith('_trapdoor') || name.endsWith('_button') || name.endsWith('_pressure_plate') ||
        name.endsWith('_concrete_powder');
}

function hasUnsafeMiningNeighbor(bot, target) {
    const neighbors = [
        target.offset(0, 1, 0), target.offset(1, 0, 0), target.offset(-1, 0, 0),
        target.offset(0, 0, 1), target.offset(0, 0, -1)
    ].map(position => bot.blockAt(position)?.name || '');
    return neighbors.some(name =>
        ['water', 'lava', 'sand', 'red_sand', 'gravel', 'dragon_egg'].includes(name) ||
        name.endsWith('_concrete_powder') || name.includes('redstone') ||
        ['piston', 'sticky_piston', 'observer', 'sculk_sensor', 'calibrated_sculk_sensor'].includes(name)
    );
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function remaining(deadline) {
    return Math.max(1, deadline - Date.now());
}

function vector(value) {
    return { x: value.x, y: value.y, z: value.z };
}

function assertion(ok, reason) {
    return { ok: Boolean(ok), reason };
}

function passed(value) {
    return { ok: true, value };
}

function failed(error) {
    return { ok: false, error };
}

function clampInteger(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.trunc(number))) : fallback;
}

function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

module.exports = {
    ALLOWED_OPERATIONS,
    ALLOWED_POSTCONDITIONS,
    validateProgram,
    execute
};
