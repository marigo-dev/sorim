const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');
const actionControl = require('./actionControl');

const BUILD_BLOCKS = [
    'cobblestone',
    'dirt',
    'oak_planks',
    'birch_planks',
    'spruce_planks'
];
let activeShelterBase = null;

async function buildSafeShelter(bot) {
    const actionVersion = actionControl.snapshot(bot);
    const origin = bot.entity.position.floored();
    const base = activeShelterBase || new Vec3(origin.x, origin.y, origin.z);
    activeShelterBase = base.clone();

    console.log(`[SHELTER] building first shelter base=${base.toString()}`);
    let placed = 0;

    for (let y = 0; y <= 2; y++) {
        for (let dx = -1; dx <= 1; dx++) {
            for (let dz = -1; dz <= 1; dz++) {
                actionControl.assertActive(bot, actionVersion);
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

    const shellScore = scoreShelterShell(bot, base);
    console.log(`[SHELTER] placed=${placed} shell=${shellScore}`);
    if (shellScore < 18) {
        throw new Error(`Shelter shell incomplete: ${shellScore}/22`);
    }

    actionControl.assertActive(bot, actionVersion);
    await ensureDoor(bot);
    await placeDoor(bot, base.offset(0, 0, -1));
    await placeUtilityInside(bot, 'crafting_table', base.offset(0, 0, 0));
    await movement.moveNear(bot, base, 1, 10000);
    memory.setBase(base);
    activeShelterBase = null;
}

function isBuildingNear(bot, range = 5) {
    if (!activeShelterBase) return false;
    return bot.entity.position.distanceTo(activeShelterBase) <= range;
}

async function returnToBase(bot) {
    const base = memory.getBase();
    if (!base) return false;
    const target = new Vec3(base.x, base.y, base.z);
    try {
        await movement.moveNear(bot, target, 2, 15000);
    } catch (error) {
        console.log(`[SHELTER] base path fallback: ${error.message}`);
        await walkTowardBase(bot, target);
    }
    return bot.entity.position.distanceTo(target) <= 5;
}

async function walkTowardBase(bot, target) {
    const deadline = Date.now() + 18000;
    try {
        while (Date.now() < deadline && bot.entity.position.distanceTo(target) > 4) {
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', true);
            await movement.sleep(300);
        }
    } finally {
        movement.stop(bot);
    }
    if (bot.entity.position.distanceTo(target) > 5) {
        throw new Error(`Could not return to base from ${bot.entity.position.floored().toString()}`);
    }
}

async function ensureBaseEgress(bot) {
    const remembered = memory.getBase();
    if (!remembered || !bot.entity) return;
    const base = new Vec3(remembered.x, remembered.y, remembered.z);
    if (bot.entity.position.distanceTo(base) > 5) return;

    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const position = base.offset(dx, 0, dz);
            const block = bot.blockAt(position);
            if (block?.name !== 'chest' || !bot.canDigBlock(block)) continue;
            console.log(`[SHELTER] removing chest from shelter footprint ${position.toString()}`);
            await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
            await bot.dig(block);
            await movement.sleep(250);
        }
    }

    const doorway = base.offset(0, 0, -1);
    const bottom = bot.blockAt(doorway);
    if (bottom?.name?.endsWith('_door')) {
        if (bottom.getProperties?.().open === false) {
            try {
                await bot.activateBlock(bottom);
                await movement.sleep(200);
            } catch (error) {
                console.log(`[SHELTER] door open delayed: ${error.message}`);
            }
        }
        return;
    }

    for (const position of [doorway, doorway.offset(0, 1, 0)]) {
        const block = bot.blockAt(position);
        if (!block || isAir(block)) continue;
        if (!bot.canDigBlock(block)) {
            console.log(`[SHELTER] base entrance blocked by ${block.name}`);
            return;
        }
        console.log(`[SHELTER] clearing blocked entrance ${block.name} ${position.toString()}`);
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.dig(block);
        await movement.sleep(250);
    }
}

async function leaveBase(bot) {
    const remembered = memory.getBase();
    if (!remembered || !bot.entity) return;
    const base = new Vec3(remembered.x, remembered.y, remembered.z);
    if (!isInsideShelter(bot.entity.position, base)) return;

    movement.stop(bot);
    await ensureBaseEgress(bot);
    await ensureEntranceFloor(bot, base);
    await walkToDoorway(bot, base);
    const doorwayExit = base.offset(0, 1, -3);
    await jumpToward(bot, doorwayExit);
    await movement.sleep(300);
    if (!isInsideShelter(bot.entity.position, base)) {
        await ensureEntranceFloor(bot, base);
        console.log(`[SHELTER] exited base through doorway ${doorwayExit.toString()}`);
        return;
    }
    if (bot.entity.position.distanceTo(base.offset(0.5, 0, -0.5)) <= 1.8 &&
        await carveExitTrench(bot, base)) {
        console.log(`[SHELTER] exited base through threshold recovery ${bot.entity.position.floored().toString()}`);
        return;
    }
    const candidates = exteriorStands(bot, base).slice(0, 8);
    for (const target of candidates) {
        try {
            await movement.moveBlock(bot, target, 5000);
        } catch {
            await jumpToward(bot, target);
        }
        await movement.sleep(300);
        if (!isInsideShelter(bot.entity.position, base)) {
            await ensureEntranceFloor(bot, base);
            console.log(`[SHELTER] exited base toward ${target.toString()}`);
            return;
        }
    }
    if (await carveExitTrench(bot, base)) {
        console.log(`[SHELTER] exited base through recovery trench ${bot.entity.position.floored().toString()}`);
        return;
    }
    const feet = bot.entity.position.floored();
    const front = feet.offset(0, 0, -1);
    throw new Error(
        `Could not leave the base safely at ${feet.toString()} ` +
        `feet=${bot.blockAt(feet)?.name} head=${bot.blockAt(feet.offset(0, 1, 0))?.name} ` +
        `front=${bot.blockAt(front)?.name}`
    );
}

async function carveExitTrench(bot, base) {
    for (let step = 0; step < 4 && isInsideShelter(bot.entity.position, base); step++) {
        const feet = bot.entity.position.floored();
        const front = feet.offset(0, 0, -1);
        for (const position of [front, front.offset(0, 1, 0)]) {
            const block = bot.blockAt(position);
            if (!block || isAir(block)) continue;
            if (!bot.canDigBlock(block)) return false;
            await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
            await bot.dig(block);
            await movement.sleep(200);
        }
        syncGroundedPhysics(bot);
        try {
            await bot.lookAt(front.offset(0.5, 0.4, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            await movement.sleep(850);
        } finally {
            movement.stop(bot);
        }
    }
    return !isInsideShelter(bot.entity.position, base);
}

async function walkToDoorway(bot, base) {
    const threshold = base.offset(0, 0, -1);
    try {
        syncGroundedPhysics(bot);
        await bot.lookAt(threshold.offset(0.5, 0.4, 0.5), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        await movement.sleep(1100);
    } finally {
        movement.stop(bot);
    }
}

function syncGroundedPhysics(bot) {
    const feet = bot.entity.position.floored();
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const nearBlockTop = Math.abs(bot.entity.position.y - feet.y) < 0.12;
    if (floor?.boundingBox === 'block' && nearBlockTop) {
        bot.entity.onGround = true;
        if (bot.entity.velocity) bot.entity.velocity.y = 0;
    }
}

async function ensureEntranceFloor(bot, base) {
    const floorPosition = base.offset(0, 0, -2);
    const floor = bot.blockAt(floorPosition);
    const support = bot.blockAt(floorPosition.offset(0, -1, 0));
    if (!isAir(floor) || support?.boundingBox !== 'block') return;
    if (bot.entity.position.distanceTo(floorPosition.offset(0.5, 0, 0.5)) < 1.1) return;

    const item = bot.inventory.items().find(entry =>
        ['cobblestone', 'dirt'].includes(entry.name) || entry.name.endsWith('_planks')
    );
    if (!item) return;
    try {
        await bot.equip(item, 'hand');
        await bot.lookAt(support.position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(support, new Vec3(0, 1, 0));
        await movement.sleep(250);
        console.log(`[SHELTER] repaired entrance floor ${floorPosition.toString()}`);
    } catch (error) {
        console.log(`[SHELTER] entrance floor repair delayed: ${error.message}`);
    }
}

function exteriorStands(bot, base) {
    const candidates = [];
    for (let radius = 2; radius <= 4; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                const position = base.offset(dx, 1, dz);
                const feet = bot.blockAt(position);
                const head = bot.blockAt(position.offset(0, 1, 0));
                const floor = bot.blockAt(position.offset(0, -1, 0));
                if (isAir(feet) && isAir(head) && floor?.boundingBox === 'block') {
                    candidates.push(position);
                }
            }
        }
    }
    return candidates.sort((left, right) => {
        const leftDoorBias = Math.abs(left.x - base.x) + Math.abs(left.z - (base.z - 2));
        const rightDoorBias = Math.abs(right.x - base.x) + Math.abs(right.z - (base.z - 2));
        return leftDoorBias - rightDoorBias ||
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position);
    });
}

function isInsideShelter(position, base) {
    const insideRoom = Math.abs(position.x - (base.x + 0.5)) <= 1.6 &&
        Math.abs(position.z - (base.z + 0.5)) <= 1.6 &&
        position.y <= base.y + 2.2;
    const inLowEntranceApron = Math.abs(position.x - (base.x + 0.5)) <= 2.5 &&
        Math.abs(position.z - (base.z + 0.5)) <= 3.5 &&
        position.y <= base.y + 0.2;
    return insideRoom || inLowEntranceApron;
}

async function jumpToward(bot, target) {
    try {
        syncGroundedPhysics(bot);
        await bot.lookAt(target.offset(0.5, 1, 0.5), true);
        const feet = bot.entity.position.floored();
        const floor = bot.blockAt(feet.offset(0, -1, 0));
        if (floor?.boundingBox === 'block' && Math.abs(bot.entity.velocity?.y || 0) < 0.08) {
            bot.entity.onGround = true;
            if (bot.entity.velocity) bot.entity.velocity.y = 0.42;
        }
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(1800);
    } finally {
        bot.clearControlStates();
    }
}

async function ensureDoor(bot) {
    if (bot.inventory.items().some(item => item.name.endsWith('_door'))) return;
    const planks = bot.inventory.items().find(item =>
        item.name.endsWith('_planks') && item.count >= 6
    );
    if (!planks) return;
    await craft.craftItem(bot, planks.name.replace(/_planks$/, '_door'), 1);
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
    returnToBase,
    isBuildingNear,
    ensureBaseEgress,
    leaveBase
};
