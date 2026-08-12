const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const homestead = require('../skills/homestead');

const center = new Vec3(-20, 70, 14);
const positions = homestead.farmPlotPositions(center);
const keys = new Set(positions.map(position => position.toString()));

assert.equal(positions.length, 80);
assert.equal(keys.size, 80);
assert.equal(positions.some(position => position.equals(center)), false);
assert.equal(
    positions.slice(0, 8).every(position =>
        Math.max(Math.abs(position.x - center.x), Math.abs(position.z - center.z)) === 1
    ),
    true
);
assert.equal(
    positions.every(position =>
        Math.abs(position.x - center.x) <= 4 &&
        Math.abs(position.z - center.z) <= 4
    ),
    true
);

const naturalCenter = new Vec3(10, 65, 10);
const naturalWater = naturalCenter.offset(4, -1, 0);
const naturalBot = {
    blockAt(position) {
        if (position.equals(naturalWater)) return { name: 'water', boundingBox: 'empty' };
        if (position.y === naturalCenter.y - 1) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
    }
};
assert.equal(
    homestead.hasHydrationWater(naturalBot, naturalCenter),
    true,
    'Natural water within four blocks must hydrate a starter farm without a bucket'
);
assert.equal(
    homestead.nearestNaturalFarmSite({
        ...naturalBot,
        registry: { blocksByName: { water: { id: 1 } } },
        entity: { position: naturalCenter },
        findBlocks() { return [naturalWater]; }
    })?.equals(naturalCenter),
    true,
    'Natural farm selection must retain a solid, clear maintenance center'
);

console.log('Homestead hydrated farm geometry passed.');
