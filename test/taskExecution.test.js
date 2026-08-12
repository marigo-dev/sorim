const assert = require('node:assert/strict');

const TaskQueue = require('../agent/taskQueue');
const taskVerifier = require('../agent/taskVerifier');
const { PreconditionResolver, materialPotential } = require('../agent/preconditionResolver');
const storage = require('../skills/storage');
const shelter = require('../skills/shelter');
const { TOOL_DEFINITIONS } = require('../toolRegistry');
const { Vec3 } = require('vec3');

const before = {
    inventory: { oak_log: 1, dirt: 2 },
    position: { x: 20, y: 64, z: 20 },
    base: { x: 0, y: 64, z: 0 },
    hasUsableChest: false
};
const afterMine = {
    ...before,
    inventory: { oak_log: 5, dirt: 2 }
};

assert.equal(taskVerifier.verify(
    { tool: 'ensure_base', args: {} },
    before,
    { ...before, base: { x: 0, y: 64, z: 0 } },
    {
        bot: { blockAt: () => ({ name: 'crafting_table' }) },
        executionResult: { shellScore: 39 }
    }
).ok, false, 'A partial 5x5 shell must never verify as a safe base');

assert.equal(taskVerifier.verify(
    { tool: 'ensure_base', args: {} },
    before,
    { ...before, base: { x: 20, y: 64, z: 20 } },
    {
        bot: {
            blockAt: position => ({
                name: position.x === 21 && position.y === 64 && position.z === 21
                    ? 'crafting_table'
                    : 'air'
            })
        },
        executionResult: { shellScore: shelter.SHELL_TARGET }
    }
).ok, true, 'A complete shell with the table at the real interior offset must verify');

const unsupported = TOOL_DEFINITIONS.map(tool => tool.name).filter(tool => !taskVerifier.supports(tool));
assert.deepEqual(unsupported, [], `Tools without verification contracts: ${unsupported.join(', ')}`);
assert.equal(taskVerifier.verify({ tool: 'invented_tool', args: {} }, before, before).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'explore', args: { target: 'wood' } },
    before,
    { ...before, position: { x: 22, y: 64, z: 20 } },
    { executionResult: { recovered: true } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'explore', args: { target: 'wood' } },
    before,
    before,
    { executionResult: { recovered: false } }
).ok, false);

const placedBlock = { name: 'crafting_table', position: { x: 21, y: 64, z: 20 } };
assert.equal(taskVerifier.verify(
    { tool: 'place_block', args: { item: 'crafting_table' } },
    before,
    before,
    { executionResult: placedBlock, bot: { blockAt: () => placedBlock } }
).ok, true);

assert.equal(taskVerifier.verify(
    { tool: 'wait_safe', args: { ms: 1000 } },
    { ...before, timestamp: 1000 },
    { ...before, timestamp: 2050 },
    { executionResult: { status: 'waited', durationMs: 1000 } }
).ok, true);

const openExitBot = {
    entity: { position: new Vec3(22, 65, 20) },
    blockAt: () => ({ name: 'air', boundingBox: 'empty' })
};
assert.equal(taskVerifier.verify(
    { tool: 'escape_pit', args: {} },
    before,
    { ...before, position: { x: 22, y: 65, z: 20 } },
    { bot: openExitBot }
).ok, true);
const sealedPitBot = {
    entity: { position: new Vec3(20, 64, 20) },
    blockAt: () => ({ name: 'stone', boundingBox: 'block' })
};
assert.equal(taskVerifier.verify(
    { tool: 'escape_pit', args: {} },
    before,
    { ...before, position: { x: 23, y: 64, z: 20 } },
    { bot: sealedPitBot }
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'craft_iron_kit', args: {} },
    before,
    { ...before, inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, shield: 1, iron_ingot: 8 }, equipment: [] }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'craft_iron_kit', args: {} },
    before,
    { ...before, inventory: { iron_pickaxe: 1, iron_sword: 1, iron_axe: 1, shield: 1 }, equipment: [] }
).ok, false, 'Iron kit verification must preserve eight reserve ingots');

const completeMiningKit = {
    stone_pickaxe: 1,
    stone_sword: 1,
    furnace: 1,
    coal: 1,
    torch: 16,
    cobblestone: 16,
    bread: 16
};
assert.equal(taskVerifier.verify(
    { tool: 'prepare_mining_kit', args: {} },
    before,
    { ...before, inventory: completeMiningKit },
    { afterObservation: { inventory: completeMiningKit, nearbyBlocks: [] } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'prepare_mining_kit', args: {} },
    before,
    { ...before, inventory: { ...completeMiningKit, bread: 15 } },
    { afterObservation: { inventory: { ...completeMiningKit, bread: 15 }, nearbyBlocks: [] } }
).ok, false, 'Mining kit verification must reject a partial food reserve');

assert.equal(taskVerifier.verify(
    { tool: 'build_blueprint', args: { name: 'spruce_cottage' } },
    before,
    before,
    { executionResult: { name: 'spruce_cottage', verified: true, matched: 80, expected: 80 } }
).ok, true);

assert.equal(taskVerifier.verify(
    { tool: 'count_shared_storage', args: {} },
    before,
    { ...before, sharedInventory: { bread: 8, cobblestone: 32 } },
    { executionResult: { bread: 8, cobblestone: 32 } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'mine_block', args: { target: 'any_log' } },
    before,
    afterMine
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'mine_block', args: { target: 'any_log' } },
    before,
    before
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'find_food', args: {} },
    before,
    { ...before, inventory: { ...before.inventory, beef: 2 } },
    { executionResult: { status: 'hunted' } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'find_food', args: {} },
    before,
    { ...before, position: { x: 23, y: 64, z: 20 } },
    { executionResult: { status: 'searched', moved: 3 } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'find_food', args: {} },
    before,
    before,
    { executionResult: { status: 'failed' } }
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'fight_mob', args: { entityId: 42 } },
    before,
    before,
    { bot: { entities: {} } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'fight_mob', args: { entityId: 42 } },
    before,
    before,
    { bot: { entities: { 42: { id: 42, isValid: true } } } }
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'smelt_item', args: { input: 'birch_log', output: 'charcoal', count: 1 } },
    { ...before, inventory: { birch_log: 2 } },
    { ...before, inventory: { birch_log: 1, charcoal: 1 } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'smelt_item', args: { input: 'birch_log', output: 'charcoal', count: 1 } },
    before,
    before
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'return_base', args: {} },
    before,
    { ...before, position: { x: 3, y: 64, z: 0 } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'return_base', args: {} },
    before,
    { ...before, position: { x: 8, y: 64, z: 0 } }
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'move_near', args: { x: 10, y: 64, z: 10, range: 2 } },
    before,
    { ...before, position: { x: 11, y: 64, z: 10 } }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'move_near', args: { x: 10, y: 64, z: 10, range: 2 } },
    before,
    { ...before, position: { x: 20, y: 64, z: 20 } }
).ok, false);

assert.equal(taskVerifier.verify(
    { tool: 'organize_storage', args: {} },
    { ...before, inventory: { oak_log: 12 } },
    { ...before, inventory: { oak_log: 1 }, hasUsableChest: true },
    { executionResult: { deposited: { oak_log: 11 } } }
).ok, true);

assert.equal(taskVerifier.verify(
    { tool: 'maintain_food_supply', args: { minimum: 16 } },
    { ...before, inventory: { bread: 8 } },
    { ...before, inventory: { bread: 12 } },
    { executionResult: { status: 'harvested' } }
).ok, false, 'A minimum food task must not complete after a merely partial harvest');
assert.equal(taskVerifier.verify(
    { tool: 'maintain_food_supply', args: { minimum: 16 } },
    { ...before, inventory: { bread: 12 } },
    { ...before, inventory: { bread: 16 } },
    { executionResult: { status: 'stock_ready' } }
).ok, true);

assert.equal(taskVerifier.verify(
    { tool: 'deposit_shared_storage', args: { item: 'cobblestone', count: 16 } },
    { ...before, inventory: { cobblestone: 20 }, sharedInventory: { cobblestone: 10 } },
    { ...before, inventory: { cobblestone: 4 }, sharedInventory: { cobblestone: 26 } },
    { executionResult: 16 }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'withdraw_shared_storage', args: { item: 'bread', count: 8 } },
    { ...before, inventory: {}, sharedInventory: { bread: 20 } },
    { ...before, inventory: { bread: 8 }, sharedInventory: { bread: 12 } },
    { executionResult: 8 }
).ok, true);
assert.equal(taskVerifier.verify(
    { tool: 'ensure_shared_storage', args: {} },
    { ...before, sharedInventory: {} },
    { ...before, sharedInventory: {} },
    { executionResult: { name: 'chest', position: { x: 1, y: 64, z: 1 } } }
).ok, true);

const saved = [];
const store = {
    getTaskQueue: () => [],
    setTaskQueue: tasks => saved.splice(0, saved.length, ...JSON.parse(JSON.stringify(tasks)))
};
const queue = new TaskQueue(store, { preconditionResolver: new PreconditionResolver() });
queue.enqueue({
    id: 'store_without_base',
    goal: 'store wood',
    steps: [{ id: 'storage', tool: 'organize_storage', args: {} }]
});
const first = queue.toolCall({ observation: { inventory: {}, base: null } });
assert.equal(first.tool, 'mine_block');
assert.equal(first.args.target, 'any_log');
assert.equal(saved[0].steps.some(step => step.tool === 'ensure_base'), true);
assert.equal(saved[0].steps.some(step => step.preconditionFor === 'storage'), true);

assert.equal(materialPotential({ oak_log: 4, dirt: 12, oak_planks: 8 }), 36);
assert.deepEqual(storage.deposableInventory({ oak_planks: 48, bread: 20, stone_pickaxe: 1 }), {
    oak_planks: 32,
    bread: 4
});

queue.completeCurrentStep({ ok: true, reason: 'wood gained', details: { gained: 4 } });
assert.equal(saved[0].steps[0].verification.ok, true);
assert.match(saved[0].steps[0].verification.reason, /wood gained/);

const progressQueue = new TaskQueue({ getTaskQueue: () => [], setTaskQueue: () => {} });
progressQueue.enqueue({
    id: 'counted_progress',
    goal: 'collect sixteen logs',
    steps: [{ id: 'logs', tool: 'mine_block', args: { target: 'any_log', count: 16 } }]
});
progressQueue.toolCall();
progressQueue.failCurrentStep(new taskVerifier.TaskVerificationError(
    'Inventory gained only 5/16 for any_log',
    { gained: 5, requested: 16 }
));
assert.equal(progressQueue.currentStep().args.count, 11);
assert.equal(progressQueue.currentStep().attempts, 0, 'Verified partial progress must not consume a retry');

console.log('Task verification and dynamic precondition resolution passed.');
