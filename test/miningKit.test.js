const assert = require('assert');
const mining = require('../skills/mining');
const { assessMiningKit } = require('../agent/progressionContracts');

assert.strictEqual(
    mining.needsPreparationSurfaceReturn({ y: 67.9 }, { x: 0, y: 70, z: 0 }),
    true,
    'underground preparation must return to the remembered surface'
);
assert.strictEqual(
    mining.needsPreparationSurfaceReturn({ y: 70 }, { x: 0, y: 70, z: 0 }),
    false,
    'a bot already at surface height must not trigger pit recovery'
);
assert.strictEqual(
    mining.needsPreparationSurfaceReturn({ y: 20 }, null),
    false,
    'missing memory must not invent a surface target'
);

const durabilityBot = {
    registry: {
        itemsByName: {
            stone_pickaxe: { maxDurability: 131 }
        }
    }
};
assert.strictEqual(
    mining.remainingDurability(durabilityBot, { name: 'stone_pickaxe', durabilityUsed: 120 }),
    11,
    'remaining durability must use the registry maximum and item damage'
);
assert.strictEqual(
    mining.remainingDurability(durabilityBot, { name: 'unknown_tool' }),
    Number.POSITIVE_INFINITY,
    'non-damageable or unknown items must not look broken'
);

const completeKit = {
    inventory: {
        stone_pickaxe: 1,
        stone_sword: 1,
        furnace: 1,
        coal: 1,
        torch: 16,
        cobblestone: 16,
        bread: 16
    },
    nearbyBlocks: []
};
assert.strictEqual(assessMiningKit(completeKit).ready, true);
assert.strictEqual(
    assessMiningKit({
        ...completeKit,
        inventory: { ...completeKit.inventory, bread: 15 }
    }).ready,
    false,
    'A mining kit must contain sixteen real food items'
);
assert.strictEqual(
    assessMiningKit({
        ...completeKit,
        inventory: { ...completeKit.inventory, stone_sword: 0 }
    }).ready,
    false,
    'A survival mining kit must include a combat weapon'
);
assert.deepStrictEqual(
    mining.missingKitParts(assessMiningKit({
        ...completeKit,
        inventory: {
            ...completeKit.inventory,
            stone_sword: 0,
            bread: 10,
            torch: 8
        }
    })),
    ['sword', 'torches 8/16', 'food 10/16']
);

console.log('mining kit tests passed');
