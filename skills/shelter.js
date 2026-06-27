const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');

const BUILD_BLOCKS = [
    'cobblestone',
    'dirt',
    'oak_planks',
    'birch_planks',
    'spruce_planks'
];

async function buildSafeShelter(bot) {
    const origin = bot.entity.position.floored();
    const base = new Vec3(origin.x, origin.y, origin.z);

    console.log(`[SHELTER] building first shelter base=${base.toString()}`);
    await ensureDoor(bot);
    let placed = 0;

    for (let y = 0; y <= 2; y++) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
                const roof = y === 2;
                const floor = y === -1;
                if (!edge && !roof && !floor) continue;

                const position = base.offset(dx, y, dz);
                if (isDoorSpace(dx, y, dz)) continue;
                if (position.equals(origin)) continue;
                if (await placeBuildBlock(bot, position)) placed++;
            }
        }
    }

    await placeDoor(bot, base.offset(0, 0, -1));
    await placeUtilityInside(bot, 'crafting_table', base.offset(0, 0, 0));
    await movement.moveNear(bot, base, 1, 10000);

    const shellScore = scoreShelterShell(bot, base);
    console.log(`[SHELTER] placed=${placed} shell=${shellScore}`);
    if (shellScore < 18) {
        throw new Error(`Shelter shell incomplete: ${shellScore}/22`);
    }
    memory.setBase(base);
}

async function returnToBase(bot) {
    const base = memory.getBase();
    if (!base) return false;
    await movement.moveNear(bot, new Vec3(base.x, base.y, base.z), 1, 15000);
    return true;
}

async function ensureDoor(bot) {
    if (countItem(bot, 'oak_door') > 0) return;
    if (countItem(bot, 'oak_planks') >= 20) {
        await craft.craftItem(bot, 'oak_door', 1);
    }
}

async function placeDoor(bot, position) {
    const item = bot.inventory.items().find(entry => entry.name.endsWith('_door'));
    if (!item) return;

    const block = bot.blockAt(position);
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (!isAir(block) || below?.boundingBox !== 'block') return;

    try {
        await movement.moveNear(bot, position, 3, 8000);
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(below, new Vec3(0, 1, 0));
        await movement.sleep(400);
    } catch (error) {
        console.log(`[SHELTER] skipped door: ${error.message}`);
    }
}

async function placeUtilityInside(bot, itemName, position) {
    if (findNearbyBlock(bot, itemName, 8)) return;
    if (countItem(bot, itemName) <= 0) {
        if (itemName === 'crafting_table') await craft.craftItem(bot, itemName, 1);
        else return;
    }
    await placeSpecific(bot, itemName, position);
}

async function placeBuildBlock(bot, position) {
    const current = bot.blockAt(position);
    if (!current || !isAir(current)) return false;

    const item = BUILD_BLOCKS
        .map(name => bot.inventory.items().find(entry => entry.name === name))
        .find(Boolean);
    if (!item) throw new Error('Ev yapmak icin blok yok');

    return placeSpecificItem(bot, item, position);
}

async function placeSpecific(bot, itemName, position) {
    const item = bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) return;
    await placeSpecificItem(bot, item, position);
}

async function placeSpecificItem(bot, item, position) {
    const reference = findReference(bot, position);
    if (!reference) return false;

    try {
        await movement.moveNear(bot, position, 4, 8000);
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(reference.block, reference.face);
        await movement.sleep(200);
        const placed = bot.blockAt(position);
        return Boolean(placed && !isAir(placed));
    } catch (error) {
        console.log(`[SHELTER] skipped placing ${item.name} ${position.toString()}: ${error.message}`);
        return false;
    }
}

function scoreShelterShell(bot, base) {
    let score = 0;
    for (let y = 0; y <= 2; y++) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                const edge = Math.abs(dx) === 1 || Math.abs(dz) === 1;
                const roof = y === 2;
                if (!edge && !roof) continue;
                if (isDoorSpace(dx, y, dz)) continue;
                const block = bot.blockAt(base.offset(dx, y, dz));
                if (block && !isAir(block)) score++;
            }
        }
    }
    return score;
}

function findReference(bot, position) {
    const faces = [
        { offset: new Vec3(0, -1, 0), face: new Vec3(0, 1, 0) },
        { offset: new Vec3(1, 0, 0), face: new Vec3(-1, 0, 0) },
        { offset: new Vec3(-1, 0, 0), face: new Vec3(1, 0, 0) },
        { offset: new Vec3(0, 0, 1), face: new Vec3(0, 0, -1) },
        { offset: new Vec3(0, 0, -1), face: new Vec3(0, 0, 1) }
    ];
    for (const entry of faces) {
        const block = bot.blockAt(position.plus(entry.offset));
        if (block?.boundingBox === 'block') return { block, face: entry.face };
    }
    return null;
}

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

function isDoorSpace(dx, y, dz) {
    return dx === 0 && dz === -1 && (y === 0 || y === 1);
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    buildSafeShelter,
    returnToBase
};
