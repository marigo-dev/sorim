const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const shelter = require('../skills/shelter');
const siteSelector = require('../safety/siteSelector');

const base = new Vec3(0, 64, 0);
const shell = new Set();
for (let y = 0; y <= 3; y++) {
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            const edge = Math.abs(dx) === 2 || Math.abs(dz) === 2;
            const roof = y === 3;
            const door = dx === 0 && dz === -2 && (y === 0 || y === 1);
            if ((edge || roof) && !door) shell.add(`${dx},${y},${dz}`);
        }
    }
}

const bot = {
    blockAt(position) {
        const key = `${position.x - base.x},${position.y - base.y},${position.z - base.z}`;
        return shell.has(key)
            ? { name: position.y === base.y ? 'cobblestone' : 'oak_planks' }
            : { name: 'air' };
    }
};

assert.equal(shell.size, 71);
assert.equal(shelter.scoreShelterShell(bot, base), 71);
assert.equal(shelter.isInsideShelter(new Vec3(0.5, 64, 0.5), base), true);
assert.equal(
    shelter.isInsideShelter(new Vec3(0.5, 65, 0.5), base),
    false,
    'floating above the interior floor must not count as being safely inside'
);
assert.equal(
    shelter.isInsideShelter(new Vec3(-1.5, 65, 0.5), base),
    false,
    'standing on a shelter wall must not count as being safely inside'
);
assert.equal(
    shelter.isInsideShelter(new Vec3(0.5, 64, -2.5), base),
    false,
    'the outside door apron must not count as the shelter interior'
);

const unevenBot = {
    entity: { position: new Vec3(0, 64, 0) },
    blockAt(position) {
        const surfaceY = position.x === 1 ? 65 : 64;
        if (position.y < surfaceY) return { name: 'dirt', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };
    }
};
assert.equal(
    siteSelector.assessFootprint(unevenBot, base, 3, 3, { maxTerrainVariation: 0 }).valid,
    false,
    'Shelter sites must reject uneven interior floors when no terraforming step exists'
);
const lowerOpenSurfaceBot = {
    entity: { position: new Vec3(8.5, 60, 0.5) },
    blockAt(position) {
        return position.y <= 59
            ? { name: 'grass_block', boundingBox: 'block' }
            : { name: 'air', boundingBox: 'empty' };
    }
};
assert.equal(
    shelter.needsPitRecoveryBeforeReturn(lowerOpenSurfaceBot, base),
    false,
    'Returning from open terrain below base elevation must use normal navigation, not pit recovery'
);
const lowerClosedPitBot = {
    ...lowerOpenSurfaceBot,
    blockAt: () => ({ name: 'stone', boundingBox: 'block' })
};
assert.equal(
    shelter.needsPitRecoveryBeforeReturn(lowerClosedPitBot, base),
    true,
    'A genuinely enclosed position below base elevation must still recover before returning'
);
console.log('5x5 shelter geometry passed.');
