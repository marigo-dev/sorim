const assert = require('assert');
const SurvivalStateMachine = require('../src/state-machine');

function createMachine(overrides = {}) {
    const bot = {
        registry: {
            foodsByName: {
                bread: {},
                cooked_beef: {}
            }
        },
        entity: {
            position: { y: 64 }
        }
    };
    const memory = {
        data: {
            base: { x: 0, y: 64, z: 0 }
        }
    };
    return new SurvivalStateMachine({
        bot,
        memory,
        lifeManager: overrides.lifeManager || null
    });
}

function observation(overrides = {}) {
    return {
        health: 20,
        food: 20,
        inWater: false,
        isNight: false,
        position: { x: 0, y: 64, z: 0 },
        inventory: {
            emptySlots: 20,
            items: {}
        },
        ...overrides
    };
}

const dangerMachine = createMachine();
assert.deepStrictEqual(
    dangerMachine.choose(observation({ inWater: true }), {
        dangerReflex: {
            type: 'fight',
            threat: 'zombie',
            reason: 'test'
        }
    }),
    {
        state: 'COMBAT_DEFENSE',
        type: 'action',
        action: {
            type: 'fight',
            threat: 'zombie',
            reason: 'test'
        },
        danger: true
    }
);

const waterMachine = createMachine();
assert.deepStrictEqual(
    waterMachine.choose(observation({ inWater: true })),
    {
        state: 'SURVIVAL_CRITICAL',
        type: 'action',
        action: { type: 'swim' },
        survival: true
    }
);

const lifeActionMachine = createMachine({
    lifeManager: {
        choosePriority: () => ({
            type: 'action',
            action: {
                type: 'eat',
                item: 'bread',
                reason: 'hungry'
            }
        })
    }
});
assert.deepStrictEqual(
    lifeActionMachine.choose(observation({ food: 10 })),
    {
        state: 'SURVIVAL_CRITICAL',
        type: 'action',
        action: {
            type: 'eat',
            item: 'bread',
            reason: 'hungry'
        },
        survival: true
    }
);

const foodGoalMachine = createMachine({
    lifeManager: {
        choosePriority: () => ({
            type: 'goals',
            goals: [{
                type: 'find_food',
                count: 16,
                reason: 'stock'
            }]
        })
    }
});
assert.deepStrictEqual(
    foodGoalMachine.choose(observation()),
    {
        state: 'FOOD_ECONOMY',
        type: 'goals',
        goals: [{
            type: 'find_food',
            count: 16,
            reason: 'stock'
        }]
    }
);

const inventoryMachine = createMachine();
assert.strictEqual(
    inventoryMachine.choose(observation({
        inventory: {
            emptySlots: 2,
            items: { stone_pickaxe: 1, bread: 16 }
        }
    })).state,
    'INVENTORY_MANAGEMENT'
);

const emptyInventoryMachine = createMachine();
assert.strictEqual(
    emptyInventoryMachine.choose(observation({
        inventory: {
            emptySlots: 20,
            items: {}
        }
    })).state,
    'EARLY_GAME'
);

const miningMachine = createMachine();
miningMachine.memory.data = {
    base: { x: 0, y: 64, z: 0 },
    shelter: { x: 0, y: 64, z: 0 },
    upgradedBase: { x: 0, y: 64, z: 0 },
    beautifulHouse: { x: 0, y: 64, z: 0 },
    farm: { x: 0, y: 64, z: 4 },
    expandedFarm: { x: 0, y: 64, z: 4 },
    storageSystem: { chests: [] },
    ironArmorEquipped: false
};
assert.strictEqual(
    miningMachine.choose(observation({
        inventory: {
            emptySlots: 20,
            items: { stone_pickaxe: 1, bread: 16 }
        }
    })).state,
    'MINING_PROGRESS'
);

console.log('State machine tests passed.');
