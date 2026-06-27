const { Vec3 } = require('vec3');

const movement = require('./movement');
const colonyMemory = require('./colonyMemory');

async function buildColonyMarker(bot, material = 'cobblestone') {
    const memory = colonyMemory.load();
    const center = memory.sharedStorage?.position || memory.settlementCenter;
    if (!center) throw new Error('No colony center known for marker build');

    const origin = new Vec3(center.x, center.y, center.z);
    const item = bot.inventory.items().find(entry => entry.name === material);
    if (!item) throw new Error(`${material} not available for colony marker`);

    const targets = markerTargets(origin);
    let placed = 0;
    for (const target of targets) {
        if (placed >= item.count) break;
        const existing = bot.blockAt(target);
        if (existing && existing.name === material) {
            placed++;
            continue;
        }
        if (!isAir(existing)) continue;

        const reference = findPlacementReference(bot, target);
        if (!reference) continue;

        try {
            await movement.moveNear(bot, target, 4, 8000);
            const currentItem = bot.inventory.items().find(entry => entry.name === material);
            if (!currentItem) break;
            await bot.equip(currentItem, 'hand');
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
            await placeBlockTolerant(bot, reference.block, reference.face, target, material);
            placed++;
            await movement.sleep(250);
        } catch (error) {
            console.log(`[COLONY_BUILD] marker target failed ${target.toString()}: ${error.message}`);
        }
    }

    if (placed <= 0) throw new Error('Could not place any colony marker blocks');
    colonyMemory.addProject({
        id: 'survival_marker',
        owner: bot.username,
        blueprint: 'survival_marker',
        position: vectorToObject(origin),
        status: placed >= targets.length ? 'complete' : 'partial',
        placed
    });
    console.log(`[COLONY_BUILD] marker placed=${placed}`);
    return placed;
}

function markerTargets(origin) {
    return [
        origin.offset(2, 0, 0),
        origin.offset(-2, 0, 0),
        origin.offset(0, 0, 2),
        origin.offset(0, 0, -2),
        origin.offset(2, 1, 0),
        origin.offset(-2, 1, 0),
        origin.offset(0, 1, 2),
        origin.offset(0, 1, -2),
        origin.offset(2, 2, 0),
        origin.offset(-2, 2, 0),
        origin.offset(0, 2, 2),
        origin.offset(0, 2, -2)
    ];
}

function findPlacementReference(bot, target) {
    const options = [
        { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
    ];
    for (const option of options) {
        const block = bot.blockAt(target.plus(option.offset));
        if (block?.boundingBox === 'block') return { block, face: option.face };
    }
    return null;
}

async function placeBlockTolerant(bot, reference, face, expectedPosition, expectedName) {
    try {
        await bot.placeBlock(reference, face);
    } catch (error) {
        if (!String(error.message || '').includes('blockUpdate')) throw error;
        await movement.sleep(700);
        const placed = bot.blockAt(expectedPosition);
        if (placed?.name === expectedName) return;
        throw error;
    }
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function vectorToObject(vector) {
    return { x: vector.x, y: vector.y, z: vector.z };
}

module.exports = {
    buildColonyMarker
};
