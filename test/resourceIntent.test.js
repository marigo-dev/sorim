const assert = require('node:assert/strict');
const { parseResourceIntent } = require('../agent/resourceIntent');
const { PreconditionResolver } = require('../agent/preconditionResolver');
const taskVerifier = require('../agent/taskVerifier');
const toolRegistry = require('../toolRegistry');
const mine = require('../skills/mine');

assert.deepEqual(parseResourceIntent('Marigo 16 odun topla'), {
    resource: 'wood', tool: 'mine_block', target: 'any_log', count: 16
});
assert.deepEqual(parseResourceIntent('on alti agac kutugu kes'), {
    resource: 'wood', tool: 'mine_block', target: 'any_log', count: 16
});
assert.deepEqual(parseResourceIntent('collect 12 cobblestone'), {
    resource: 'stone', tool: 'collect_stone', count: 12
});
assert.equal(parseResourceIntent('wooden pickaxe yap'), null);

const resolver = new PreconditionResolver();
const parent = { id: 'base', tool: 'ensure_base', args: {} };
assert.deepEqual(
    resolver.resolve(parent, { observation: { inventory: {}, base: null } })[0].args,
    { target: 'any_log', count: 22 }
);
assert.equal(
    resolver.resolve(
        { id: 'stone', tool: 'collect_stone', args: { count: 16 } },
        { observation: { inventory: {} } }
    )[0].args.item,
    'wooden_pickaxe'
);
assert.deepEqual(
    resolver.resolve(
        { id: 'pick', tool: 'craft_item', args: { item: 'wooden_pickaxe', count: 1 } },
        { observation: { inventory: {}, nearbyBlocks: [] } }
    )[0].args,
    { target: 'any_log', count: 3 }
);
assert.deepEqual(
    resolver.resolve(
        { id: 'pick', tool: 'craft_item', args: { item: 'wooden_pickaxe', count: 1 } },
        { observation: { inventory: { oak_log: 3 }, nearbyBlocks: [] } }
    )[0].args,
    { item: 'oak_planks', count: 9 }
);

assert.equal(taskVerifier.verify(
    { tool: 'mine_block', args: { target: 'any_log', count: 8 } },
    { inventory: {}, position: { x: 0, y: 64, z: 0 } },
    { inventory: { oak_log: 4 }, position: { x: 0, y: 64, z: 0 } }
).ok, false);

async function verifyCountedExecution() {
    const original = mine.mineBlock;
    const slots = [];
    const bot = { inventory: { items: () => slots } };
    mine.mineBlock = async () => {
        const item = slots.find(entry => entry.name === 'oak_log');
        if (item) item.count += 4;
        else slots.push({ name: 'oak_log', count: 4 });
    };
    try {
        const result = await toolRegistry.executeToolCall(bot, {
            tool: 'mine_block', args: { target: 'any_log', count: 8 }
        });
        assert.deepEqual(result, { target: 'any_log', requested: 8, gained: 8, attempts: 2 });
    } finally {
        mine.mineBlock = original;
    }
}

verifyCountedExecution().then(() => console.log('Counted resource intent and preconditions passed.'));
