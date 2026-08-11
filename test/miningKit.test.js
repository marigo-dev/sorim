const assert = require('assert');
const mining = require('../skills/mining');

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

console.log('mining kit tests passed');
