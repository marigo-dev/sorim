const assert = require('assert');
const minecraftData = require('minecraft-data');
const GoalPlanner = require('../src/planner');
const Skills = require('../src/skills');

const registry = minecraftData('1.21');
const Recipe = require('prismarine-recipe')(registry).Recipe;

function createBot(inventory = {}, placedTable = false) {
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
        findBlock: () => placedTable ? { name: 'crafting_table' } : null
    };
}

function plan(inventory, nearbyBlocks, placedTable = false) {
    const planner = new GoalPlanner(createBot(inventory, placedTable));
    return planner.plan({
        type: 'acquire_item',
        item: 'wooden_pickaxe',
        count: 1
    }, {
        nearbyBlocks: nearbyBlocks.map((name, index) => ({
            name,
            distance: index + 1
        }))
    });
}

function planItem(item, inventory, nearbyBlocks, placedTable = false) {
    const planner = new GoalPlanner(createBot(inventory, placedTable));
    return planner.plan({
        type: 'acquire_item',
        item,
        count: 1
    }, {
        nearbyBlocks: nearbyBlocks.map((name, index) => ({
            name,
            distance: index + 1
        }))
    });
}

assert.deepStrictEqual(
    plan({}, ['oak_log']),
    { type: 'mine', block: 'oak_log', item: 'oak_log', count: 1 }
);

assert.deepStrictEqual(
    plan({}, ['spruce_log']),
    { type: 'mine', block: 'spruce_log', item: 'spruce_log', count: 1 }
);

assert.deepStrictEqual(
    plan({ oak_log: 2 }, []),
    { type: 'craft', item: 'oak_planks', count: 3, requiresTable: false }
);

assert.deepStrictEqual(
    plan({ oak_planks: 5 }, []),
    { type: 'craft', item: 'stick', count: 2, requiresTable: false }
);

assert.deepStrictEqual(
    plan({ oak_planks: 3, stick: 2, crafting_table: 1 }, []),
    { type: 'place_workstation', workstation: 'crafting_table' }
);

assert.deepStrictEqual(
    plan({ oak_planks: 3, stick: 2 }, [], true),
    { type: 'craft', item: 'wooden_pickaxe', count: 1, requiresTable: true }
);

assert.deepStrictEqual(
    plan({ oak_planks: 2, birch_log: 1, stick: 2, crafting_table: 1 }, []),
    { type: 'craft', item: 'birch_planks', count: 1, requiresTable: false }
);

assert.deepStrictEqual(
    planItem('cobblestone', { wooden_pickaxe: 1 }, []),
    {
        type: 'dig_staircase',
        resource: 'cobblestone',
        reason: 'cobblestone yuzeyde gorunmuyor; guvenli maden girisi ac'
    }
);

assert.deepStrictEqual(
    planItem('charcoal', { oak_log: 4, furnace: 1 }, []),
    { type: 'craft', item: 'oak_planks', count: 1, requiresTable: false }
);

assert.deepStrictEqual(
    planItem('charcoal', { oak_log: 3, oak_planks: 1, furnace: 1 }, []),
    {
        type: 'smelt',
        input: 'oak_log',
        output: 'charcoal',
        count: 1
    }
);

assert.deepStrictEqual(
    planItem('iron_ingot', { raw_iron: 3, oak_log: 1, furnace: 1 }, []),
    { type: 'craft', item: 'oak_planks', count: 1, requiresTable: false }
);

assert.deepStrictEqual(
    planItem('iron_ingot', { raw_iron: 3, oak_planks: 1, furnace: 1 }, []),
    {
        type: 'smelt',
        input: 'raw_iron',
        output: 'iron_ingot',
        count: 1
    }
);

assert.deepStrictEqual(
    new GoalPlanner(createBot({ raw_iron: 8, oak_planks: 4, oak_log: 1, furnace: 1 })).plan({
        type: 'acquire_item',
        item: 'iron_ingot',
        count: 8
    }, { nearbyBlocks: [] }),
    { type: 'craft', item: 'oak_planks', count: 2, requiresTable: false }
);

assert.strictEqual(
    planItem('raw_iron', { stone_pickaxe: 1 }, []).type,
    'mine_tunnel'
);

assert.deepStrictEqual(
    new GoalPlanner(createBot({ wheat_seeds: 7 })).plan({
        type: 'acquire_item',
        item: 'wheat_seeds',
        count: 8
    }, { nearbyBlocks: [] }),
    { type: 'gather_seeds', count: 8 }
);

assert.deepStrictEqual(
    planItem('crafting_table', {}, []),
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

const undergroundSkills = Object.create(Skills.prototype);
undergroundSkills.surfaceAnchor = { y: 74 };
undergroundSkills.bot = { entity: { position: { x: 0, y: 70, z: 0 } } };

assert.strictEqual(
    undergroundSkills.shouldReturnToSurface({
        type: 'mine',
        block: 'oak_log'
    }),
    true
);

assert.strictEqual(
    undergroundSkills.shouldReturnToSurface({
        type: 'mine',
        block: 'stone'
    }),
    false
);

assert.strictEqual(
    undergroundSkills.shouldReturnToSurface({
        type: 'explore',
        resource: 'sheep'
    }),
    true
);

undergroundSkills.memory = {
    data: {
        base: { x: 0, y: 74, z: 0 }
    }
};
undergroundSkills.bot.entity.position.x = 30;
undergroundSkills.bot.entity.position.z = 0;

assert.strictEqual(
    undergroundSkills.shouldReturnToBase({ type: 'smelt' }),
    false
);
assert.strictEqual(
    undergroundSkills.shouldReturnToSurface({ type: 'smelt' }),
    true
);

const shelterMemory = { data: { shelter: null } };
const shelterPlanner = new GoalPlanner(createBot({ cobblestone: 24 }), {
    memory: shelterMemory
});
const shelterGoal = {
    type: 'build_shelter',
    reason: 'Guvenli bir ilk barinak kur'
};

assert.deepStrictEqual(
    shelterPlanner.plan(shelterGoal, { nearbyBlocks: [], nearbyMobs: [] }),
    {
        type: 'build_shelter',
        reason: 'Guvenli bir ilk barinak kur'
    }
);
assert.strictEqual(shelterPlanner.isGoalComplete(shelterGoal), false);
shelterMemory.data.shelter = { x: 0, y: 64, z: 0 };
assert.strictEqual(shelterPlanner.isGoalComplete(shelterGoal), true);

const underpreparedShelterPlanner = new GoalPlanner(createBot({ wooden_pickaxe: 1 }), {
    memory: { data: { shelter: null } }
});
assert.deepStrictEqual(
    underpreparedShelterPlanner.plan(shelterGoal, { nearbyBlocks: [], nearbyMobs: [] }),
    {
        type: 'dig_staircase',
        resource: 'cobblestone',
        reason: 'cobblestone yuzeyde gorunmuyor; guvenli maden girisi ac'
    }
);

const foodStockPlanner = new GoalPlanner(createBot({ bread: 2 }));
const foodStockGoal = {
    type: 'find_food',
    count: 16,
    reason: 'Yemek stogu yap'
};
assert.deepStrictEqual(
    foodStockPlanner.plan(foodStockGoal, { nearbyBlocks: [], nearbyMobs: [] }),
    {
        type: 'hunt_food',
        count: 16,
        reason: 'Yemek stogu yap'
    }
);
assert.strictEqual(
    foodStockPlanner.isGoalComplete(foodStockGoal, {
        health: 20,
        food: 20
    }),
    false
);
assert.strictEqual(
    new GoalPlanner(createBot({ bread: 16 })).isGoalComplete(foodStockGoal, {
        health: 20,
        food: 20
    }),
    true
);

const lowHealthFoodGoal = {
    type: 'find_food',
    count: 1,
    reason: 'Can yenilemek icin yemek bul'
};
assert.strictEqual(
    new GoalPlanner(createBot({})).isGoalComplete(lowHealthFoodGoal, {
        health: 2.7,
        food: 17
    }),
    false
);
assert.strictEqual(
    new GoalPlanner(createBot({ bread: 1 })).isGoalComplete(lowHealthFoodGoal, {
        health: 2.7,
        food: 17
    }),
    true
);

const dryFarmPlanner = new GoalPlanner(createBot({
    wheat_seeds: 8,
    stone_hoe: 1
}), {
    memory: { data: { farmInProgress: null, waterUnavailable: false } }
});
assert.deepStrictEqual(
    dryFarmPlanner.plan({
        type: 'build_farm',
        dry: true,
        reason: 'Erken yemek guvencesi icin kuru baslangic bugday tarlasi kur'
    }, { nearbyBlocks: [], nearbyMobs: [] }),
    {
        type: 'build_farm',
        dry: true,
        reason: 'Erken yemek guvencesi icin kuru baslangic bugday tarlasi kur'
    }
);

const storagePlanner = new GoalPlanner(createBot({ oak_planks: 32 }), {
    memory: { data: { base: { x: 0, y: 64, z: 0 } } }
});
assert.deepStrictEqual(
    storagePlanner.plan({
        type: 'organize_storage',
        reason: 'Depo kur'
    }, { nearbyBlocks: [], nearbyMobs: [] }),
    { type: 'craft', item: 'crafting_table', count: 1, requiresTable: false }
);

const storagePlannerWithTable = new GoalPlanner(createBot({ oak_planks: 32 }, true), {
    memory: { data: { base: { x: 0, y: 64, z: 0 } } }
});
assert.deepStrictEqual(
    storagePlannerWithTable.plan({
        type: 'organize_storage',
        reason: 'Depo kur'
    }, { nearbyBlocks: [], nearbyMobs: [] }),
    { type: 'craft', item: 'chest', count: 4, requiresTable: true }
);

console.log('Planner recipe-chain tests passed.');
