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

console.log('Homestead hydrated farm geometry passed.');
