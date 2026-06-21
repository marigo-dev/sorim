const assert = require('assert');
const LifeManager = require('../src/life-manager');

function createBot(items, options = {}) {
    return {
        inventory: {
            items: () => items
        },
        registry: {
            foodsByName: {
                bread: { effectiveQuality: 11 },
                apple: { effectiveQuality: 6.4 },
                rotten_flesh: { effectiveQuality: 4.8 }
            },
            blocksByName: {
                chest: { id: 1 }
            }
        },
        findBlock: options.findBlock || (() => null),
        isABed: block => block?.name?.endsWith('_bed'),
        game: options.game || { difficulty: 'normal' },
        entity: options.entity || { position: { y: 64 } }
    };
}

const hungry = new LifeManager(createBot([
    { name: 'rotten_flesh', count: 3 },
    { name: 'apple', count: 1 },
    { name: 'bread', count: 1 }
]));

assert.deepStrictEqual(
    hungry.chooseImmediateAction({
        health: 20,
        food: 9,
        isNight: false,
        inventory: { emptySlots: 20, items: {} }
    }),
    {
        type: 'eat',
        item: 'bread',
        reason: 'Aclik seviyesi 9/20'
    }
);

const starving = new LifeManager(createBot([]));
assert.deepStrictEqual(
    starving.createPriorityGoals({
        food: 4,
        isNight: false,
        inventory: { emptySlots: 20, items: {} }
    }),
    [{
        type: 'find_food',
        reason: 'Aclik kritik seviyede: 4/20'
    }]
);

const healing = new LifeManager(createBot([]));
const healingAction = healing.chooseImmediateAction({
    health: 10,
    food: 18,
    hostileMobs: [],
    isNight: false,
    inventory: { emptySlots: 20, items: {} }
});
assert.strictEqual(healingAction.type, 'idle');
assert.strictEqual(
    healingAction.reason,
    'Can cok dusuk (10/20); iyilesmeyi bekle'
);
assert.ok(healingAction.until > Date.now());

const emergency = new LifeManager(createBot([
    { name: 'rotten_flesh', count: 1 }
]));
assert.deepStrictEqual(
    emergency.chooseImmediateAction({
        health: 20,
        food: 3,
        isNight: false,
        inventory: { emptySlots: 20, items: { rotten_flesh: 1 } }
    }),
    {
        type: 'eat',
        item: 'rotten_flesh',
        reason: 'Aclik seviyesi 3/20'
    }
);

const nightBed = { name: 'white_bed' };
const sleepy = new LifeManager(createBot([
    { name: 'wooden_pickaxe', count: 1 }
], {
    findBlock: options => options.matching(nightBed) ? nightBed : null
}), { data: { home: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    sleepy.chooseImmediateAction({
        food: 20,
        isNight: true,
        position: { x: 0, y: 64, z: 0 },
        inventory: { emptySlots: 20, items: {} }
    }),
    {
        type: 'survive_night',
        reason: 'Gece yuzeyde; yatak/base/siginak oncelikli'
    }
);

const hungryNight = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    hungryNight.choosePriority({
        health: 20,
        food: 5,
        isNight: true,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: {} }
    }),
    {
        type: 'goals',
        goals: [{
            type: 'find_food',
            reason: 'Aclik kritik seviyede: 5/20'
        }]
    }
);

const starvingNight = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    starvingNight.choosePriority({
        health: 20,
        food: 2,
        isNight: true,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: {} }
    }),
    {
        type: 'goals',
        goals: [{
            type: 'find_food',
            reason: 'Aclik kritik seviyede: 2/20'
        }]
    }
);

const hungryNightNoFood = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    hungryNightNoFood.choosePriority({
        health: 20,
        food: 7,
        isNight: true,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: {} }
    }),
    {
        type: 'goals',
        goals: [{
            type: 'find_food',
            reason: 'Aclik kritik seviyede: 7/20'
        }]
    }
);

const recoverBeforeFood = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 }
]), {
    data: {
        deathPosition: { x: 0, y: 64, z: 0, itemCount: 8 }
    }
});
assert.strictEqual(
    recoverBeforeFood.choosePriority({
        health: 8,
        food: 11,
        isNight: true,
        position: { x: 20, y: 64, z: 20 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: {} }
    }),
    null
);

const caveNight = new LifeManager(createBot([
    { name: 'wooden_pickaxe', count: 1 }
]), { data: { home: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    caveNight.createPriorityGoals({
        food: 20,
        isNight: true,
        position: { x: 0, y: 50, z: 0 },
        inventory: { emptySlots: 20, items: {} }
    }),
    []
);

const stockKeeper = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 },
    { name: 'bread', count: 3 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    stockKeeper.createPriorityGoals({
        health: 20,
        food: 20,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: { bread: 3 } }
    }),
    [{
        type: 'find_food',
        count: 16,
        reason: 'Yemek stogu dusuk: 3/16'
    }]
);

const stocked = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 },
    { name: 'bread', count: 16 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    stocked.createPriorityGoals({
        health: 20,
        food: 20,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: { bread: 16 } }
    }),
    []
);

const woundedStockKeeper = new LifeManager(createBot([
    { name: 'stone_pickaxe', count: 1 },
    { name: 'stone_sword', count: 1 },
    { name: 'bread', count: 3 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    woundedStockKeeper.createPriorityGoals({
        health: 12,
        food: 20,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: { bread: 3 } }
    }),
    []
);

const recoveryEater = new LifeManager(createBot([
    { name: 'bread', count: 2 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    recoveryEater.chooseImmediateAction({
        health: 14,
        food: 15,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        hostileMobs: [],
        inventory: { emptySlots: 20, items: { bread: 2 } }
    }),
    {
        type: 'eat',
        item: 'bread',
        reason: 'Can 14/20; iyilesmek icin acligi doldur'
    }
);

const lowHealthFoodSeeker = new LifeManager(createBot([
    { name: 'wooden_pickaxe', count: 1 },
    { name: 'wooden_sword', count: 1 }
]), { data: { shelter: { x: 0, y: 64, z: 0 } } });
assert.deepStrictEqual(
    lowHealthFoodSeeker.createPriorityGoals({
        health: 1,
        food: 15,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        nearbyMobs: [],
        inventory: { emptySlots: 20, items: {} }
    }),
    [{
        type: 'find_food',
        reason: 'Aclik kritik seviyede: 15/20'
    }]
);

console.log('Life manager tests passed.');
