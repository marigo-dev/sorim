const assert = require('assert');
const minecraftData = require('minecraft-data');
const GoalPlanner = require('../src/planner');
const TaskPlanner = require('../src/task-planner');

const registry = minecraftData('1.21');
const Recipe = require('prismarine-recipe')(registry).Recipe;

function createBot(inventory = {}) {
    const items = Object.entries(inventory).map(([name, count]) => ({
        name,
        type: registry.itemsByName[name].id,
        metadata: null,
        count
    }));

    return {
        registry,
        inventory: {
            items: () => items,
            count: id => items
                .filter(item => item.type === id)
                .reduce((total, item) => total + item.count, 0)
        },
        recipesAll: (id, metadata, table) =>
            Recipe.find(id, metadata).filter(recipe => !recipe.requiresTable || table),
        findBlock: () => null
    };
}

function createTaskPlanner(inventory = {}, memory = { data: {} }) {
    const bot = createBot(inventory);
    const goalPlanner = new GoalPlanner(bot, { memory });
    return new TaskPlanner({ goalPlanner, memory });
}

const houseMemory = {
    data: {
        base: { x: 0, y: 64, z: 0 }
    }
};
const houseTasks = createTaskPlanner({
    stone_pickaxe: 1,
    stone_sword: 1,
    bread: 16
}, houseMemory).createQueue({
    type: 'build_house',
    reason: 'Guzel ev kur'
});
assert.deepStrictEqual(
    houseTasks.map(task => task.label),
    [
        'find_food',
        'oak_planks x108',
        'cobblestone x72',
        'return_base',
        'build_house'
    ]
);

const farmMemory = {
    data: {
        base: { x: 0, y: 64, z: 0 },
        farmInProgress: { planted: 3 }
    }
};
const farmTasks = createTaskPlanner({}, farmMemory).createQueue({
    type: 'build_farm',
    dry: true,
    reason: 'Tarla kur'
});
assert.deepStrictEqual(
    farmTasks.map(task => task.label),
    [
        'wheat_seeds x5',
        'stone_hoe x1',
        'return_base',
        'build_farm'
    ]
);

const storageTasks = createTaskPlanner({ chest: 1 }).createQueue({
    type: 'organize_storage',
    reason: 'Depo kur'
});
assert.deepStrictEqual(
    storageTasks.map(task => task.label),
    ['chest x4', 'return_base', 'organize_storage']
);

const axePlanner = createTaskPlanner({ iron_hoe: 1 });
const hoeTask = axePlanner.goalTask({
    type: 'acquire_item',
    item: 'stone_hoe',
    count: 1,
    reason: 'test'
});
assert.strictEqual(axePlanner.isTaskComplete(hoeTask, {
    inventory: { items: { iron_hoe: 1 } }
}), true);

const nextPlanner = createTaskPlanner({ oak_log: 1 });
const queue = nextPlanner.createQueue({
    type: 'acquire_item',
    item: 'wooden_pickaxe',
    count: 1,
    reason: 'test'
});
assert.deepStrictEqual(
    queue.map(task => task.label),
    [
        'oak_log x3',
        'oak_planks x9',
        'stick x2',
        'crafting_table x1',
        'wooden_pickaxe x1'
    ]
);
const next = nextPlanner.nextAction(queue, { nearbyBlocks: [] });
assert.strictEqual(next.task.label, 'oak_log x3');
assert.deepStrictEqual(
    next.action,
    {
        type: 'explore',
        resource: 'herhangi_bir_odun',
        candidates: [
            'oak_log',
            'spruce_log',
            'birch_log',
            'jungle_log',
            'acacia_log',
            'cherry_log',
            'dark_oak_log',
            'mangrove_log',
            'bamboo_block',
            'stripped_spruce_log',
            'stripped_birch_log',
            'stripped_jungle_log'
        ],
        reason: 'herhangi_bir_odun kaynagi ara'
    }
);

assert.deepStrictEqual(
    createTaskPlanner({ wooden_pickaxe: 1 }).createQueue({
        type: 'acquire_item',
        item: 'stone_pickaxe',
        count: 1,
        reason: 'test'
    }).map(task => task.label),
    [
        'cobblestone x3',
        'oak_log x2',
        'oak_planks x6',
        'stick x2',
        'crafting_table x1',
        'stone_pickaxe x1'
    ]
);

assert.deepStrictEqual(
    createTaskPlanner({ raw_iron: 3, oak_log: 1 }).createQueue({
        type: 'acquire_item',
        item: 'iron_ingot',
        count: 3,
        reason: 'test'
    }).map(task => task.label),
    [
        'oak_log x3',
        'oak_planks x9',
        'stick x2',
        'crafting_table x1',
        'wooden_pickaxe x1',
        'cobblestone x8',
        'furnace x1',
        'oak_planks x1',
        'iron_ingot x3'
    ]
);

assert.deepStrictEqual(
    createTaskPlanner({ stick: 1, furnace: 1, oak_log: 1 }).createQueue({
        type: 'acquire_item',
        item: 'torch',
        count: 4,
        reason: 'test'
    }).map(task => task.label),
    [
        'oak_planks x1',
        'charcoal x1',
        'torch x4'
    ]
);

console.log('Task planner tests passed.');
