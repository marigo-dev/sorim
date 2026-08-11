const assert = require('node:assert/strict');

const TaskQueue = require('../agent/taskQueue');
const taskVerifier = require('../agent/taskVerifier');
const { PreconditionResolver, materialPotential } = require('../agent/preconditionResolver');
const storage = require('../skills/storage');

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
    { tool: 'organize_storage', args: {} },
    { ...before, inventory: { oak_log: 12 } },
    { ...before, inventory: { oak_log: 1 }, hasUsableChest: true },
    { executionResult: { deposited: { oak_log: 11 } } }
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

console.log('Task verification and dynamic precondition resolution passed.');
