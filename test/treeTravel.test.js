const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const mine = require('../skills/mine');

function block(name, position, boundingBox = 'block') {
    return { name, position, boundingBox };
}

function makeBot(surfaceAt) {
    return {
        entity: { position: new Vec3(0, 100, 0) },
        blockAt(position) {
            const surfaceY = surfaceAt(position.x, position.z);
            if (position.y <= surfaceY) return block('stone', position);
            return block('air', position, 'empty');
        }
    };
}

const safeSlope = makeBot((x, z) => 99 - Math.floor(Math.hypot(x, z) / 8));
const safeTree = block('oak_log', new Vec3(32, 96, 0));
assert.equal(Number.isFinite(mine.treeTravelRisk(safeSlope, safeTree)), true);

const deepTree = block('spruce_log', new Vec3(48, 90, 0));
assert.equal(mine.isSafeTreeTravelCandidate(safeSlope, deepTree), false);

const cliff = makeBot(x => x < 16 ? 99 : 87);
const cliffTree = block('spruce_log', new Vec3(24, 96, 0));
assert.equal(mine.isSafeTreeTravelCandidate(cliff, cliffTree), false);

console.log('Tree travel safety tests passed.');
