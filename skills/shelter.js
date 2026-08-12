const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');
const actionControl = require('./actionControl');
const siteSelector = require('../safety/siteSelector');
const blockPolicy = require('../safety/blockPolicy');

const BUILD_BLOCKS = [
    'cobblestone',
    'dirt',
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'jungle_planks',
    'acacia_planks',
    'dark_oak_planks',
    'cherry_planks',
    'mangrove_planks',
    'pale_oak_planks'
];
const HOUSE_RADIUS = 2;
const HOUSE_ROOF_Y = 3;
const SHELL_TARGET = 71;
const STONE_BLOCKS = ['cobblestone'];
const WOOD_BLOCKS = [
    'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
    'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks',
    'pale_oak_planks'
];
let activeShelterBase = null;
let activeShelterShellReady = false;
let pendingShelterSite = null;
let baseEntryFailures = 0;

async function buildSafeShelter(bot) {
    const actionVersion = actionControl.snapshot(bot);
    let origin = bot.entity.position.floored();
    let selectedBase = null;
    if (!activeShelterBase) {
        const remembered = memory.getConstructionBase();
        if (remembered) {
            activeShelterBase = new Vec3(remembered.x, remembered.y, remembered.z);
            activeShelterShellReady = scoreShelterShell(bot, activeShelterBase) >= SHELL_TARGET;
            console.log(
                `[SHELTER] resumed construction base=${activeShelterBase.toString()} ` +
                `shellReady=${activeShelterShellReady}`
            );
        }
    }
    if (!activeShelterBase) {
        const siteOptions = {
            width: 5,
            depth: 5,
            radius: 24,
            maxVerticalDelta: 2,
            maxTerrainVariation: 0,
            maxTerraformBlocks: 4
        };
        let site = pendingShelterSite || siteSelector.findBuildSite(bot, siteOptions);
        if (!site) {
            console.log('[SHELTER] no valid natural ground nearby; exploring for a build site');
            const exploration = await movement.explore(bot, {
                target: 'flat_ground',
                stopWhen: () => siteSelector.findBuildSite(bot, siteOptions),
                isActive: () => actionControl.snapshot(bot) === actionVersion
            });
            actionControl.assertActive(bot, actionVersion);
            site = exploration?.found || siteSelector.findBuildSite(bot, siteOptions);
        }
        if (site) {
            pendingShelterSite = site;
            console.log(
                `[SHELTER] selected site=${site.position.toString()} ` +
                `score=${site.score.toFixed(1)} terraform=${site.terraformBlocks}`
            );
            try {
                await clearFoliageTowardSite(bot, site.position);
                await movement.moveNear(bot, site.position, 1, 12000);
                selectedBase = site.position;
                origin = bot.entity.position.floored();
                pendingShelterSite = null;
            } catch (error) {
                console.log(`[SHELTER] site approach failed, trying local traversal: ${error.message}`);
                await clearFoliageTowardSite(bot, site.position);
                await movement.moveTowardSafely(bot, site.position, 20);
                const horizontal = Math.hypot(
                    bot.entity.position.x - (site.position.x + 0.5),
                    bot.entity.position.z - (site.position.z + 0.5)
                );
                if (horizontal > 2.5 || Math.abs(bot.entity.position.y - site.position.y) > 1.2) {
                    pendingShelterSite = null;
                    throw new Error('Could not reach the selected flat shelter site');
                }
                selectedBase = site.position;
                origin = bot.entity.position.floored();
                pendingShelterSite = null;
            }
        }
        if (!selectedBase) {
            throw new Error('No reachable 5x5 natural-ground shelter site found');
        }
    }
    const base = activeShelterBase || selectedBase;
    activeShelterBase = base.clone();
    memory.setConstructionBase(base);

    console.log(`[SHELTER] building first shelter base=${base.toString()}`);
    let placed = 0;

    for (let y = 0; y <= HOUSE_ROOF_Y; y++) {
        for (let dx = -HOUSE_RADIUS; dx <= HOUSE_RADIUS; dx++) {
            for (let dz = -HOUSE_RADIUS; dz <= HOUSE_RADIUS; dz++) {
                actionControl.assertActive(bot, actionVersion);
                const edge = Math.abs(dx) === HOUSE_RADIUS || Math.abs(dz) === HOUSE_RADIUS;
                const roof = y === HOUSE_ROOF_Y;
                if (!edge && !roof) continue;

                const position = base.offset(dx, y, dz);
                if (isDoorSpace(dx, y, dz)) continue;
                const preferred = y === 0 || (roof && edge) ? STONE_BLOCKS : WOOD_BLOCKS;
                if (await placeBuildBlock(bot, position, preferred)) placed++;
            }
        }
    }

    const shellScore = scoreShelterShell(bot, base);
    console.log(`[SHELTER] placed=${placed} shell=${shellScore}`);
    if (shellScore < SHELL_TARGET) {
        throw new Error(`5x5 shelter shell incomplete: ${shellScore}/71`);
    }
    activeShelterShellReady = true;

    actionControl.assertActive(bot, actionVersion);
    await ensureDoor(bot);
    const tablePosition = base.offset(1, 0, 1);
    const chestPosition = base.offset(-1, 0, 1);
    if (bot.blockAt(tablePosition)?.name !== 'crafting_table') {
        await moveForUtilityPlacement(bot, base, tablePosition);
    }
    const tablePlaced = await placeUtilityInside(bot, 'crafting_table', tablePosition);
    if (!tablePlaced || bot.blockAt(tablePosition)?.name !== 'crafting_table') {
        throw new Error('Shelter crafting table could not be placed inside the base');
    }
    const chestPlaced = await placeUtilityInside(bot, 'chest', chestPosition);
    if (!chestPlaced || bot.blockAt(chestPosition)?.name !== 'chest') {
        throw new Error('Shelter chest could not be placed inside the base');
    }
    await placeDoor(bot, base.offset(0, 0, -2));
    memory.setBase(base);
    memory.clearConstructionBase();
    baseEntryFailures = 0;
    blockPolicy.syncBaseProtection(base);
    activeShelterBase = null;
    activeShelterShellReady = false;
    try {
        await movement.moveNear(bot, base, 1, 10000);
    } catch (error) {
        movement.stop(bot);
        console.log(`[SHELTER] base complete; entry deferred: ${error.message}`);
    }
    return { base: { x: base.x, y: base.y, z: base.z }, shellScore };
}

async function clearFoliageTowardSite(bot, target) {
    const origin = bot.entity.position.floored();
    const dx = target.x - origin.x;
    const dz = target.z - origin.z;
    const stepX = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
    const stepZ = stepX === 0 ? Math.sign(dz) : 0;
    if (stepX === 0 && stepZ === 0) return;

    for (let distance = 1; distance <= 2; distance++) {
        const cell = origin.offset(stepX * distance, 0, stepZ * distance);
        for (const position of [cell, cell.offset(0, 1, 0)]) {
            const block = bot.blockAt(position);
            const name = block?.name || '';
            const isFoliage = name.endsWith('_leaves') || [
                'pale_hanging_moss',
                'pale_moss_carpet',
                'vine'
            ].includes(name);
            if (isFoliage) await clearBlock(bot, block);
        }
    }
}

function isBuildingNear(bot, range = 5) {
    if (!activeShelterBase) return false;
    return bot.entity.position.distanceTo(activeShelterBase) <= range;
}

function needsOnlyUtilityRepair() {
    return Boolean(
        (activeShelterBase && activeShelterShellReady) ||
        memory.getConstructionBase()
    );
}

async function returnToBase(bot) {
    const base = memory.getBase();
    if (!base) return false;
    const target = calibrateRememberedBase(bot, new Vec3(base.x, base.y, base.z));
    if (isInsideShelter(bot.entity.position, target)) {
        await secureBaseEntrance(bot, target);
        return true;
    }
    await descendFromShelterWall(bot, target);
    if (bot.entity.position.y < target.y - 1) {
        await require('./survival').escapePit(bot);
    }
    const initialApproach = findBaseApproach(bot, target);
    if (horizontalDistance(bot.entity.position, initialApproach.offset(0.5, 0, 0.5)) <= 3.5) {
        await enterShelter(bot, target);
        if (isInsideShelter(bot.entity.position, target)) {
            baseEntryFailures = 0;
            await secureBaseEntrance(bot, target);
            console.log(`[SHELTER] entered base ${target.toString()}`);
            return true;
        }
    }
    const approach = findBaseApproach(bot, target);
    const approachCenter = approach.offset(0.5, 0, 0.5);
    if (horizontalDistance(bot.entity.position, approachCenter) > 1.5) {
        try {
            await movement.moveNear(bot, approach, 1, 25000);
        } catch (error) {
            console.log(`[SHELTER] base path fallback: ${error.message}`);
            for (let attempt = 0; attempt < 10 && bot.entity.position.distanceTo(target) > 5; attempt++) {
                const before = horizontalDistance(bot.entity.position, approachCenter);
                await movement.moveTowardSafely(bot, approach, 16);
                const after = horizontalDistance(bot.entity.position, approachCenter);
                if (after >= before - 0.5) {
                    await movement.clearNearbyFoliage(bot, approach, 2);
                    await movement.clearStepToward(
                        bot,
                        approach,
                        3,
                        block => isTraversalFoliage(block)
                    );
                }
            }
            if (bot.entity.position.distanceTo(target) > 5) {
                await walkTowardBase(bot, approach, target);
            }
        }
    }
    if (bot.entity.position.distanceTo(target) <= 7) await enterShelter(bot, target);
    const entered = isInsideShelter(bot.entity.position, target);
    if (entered) {
        baseEntryFailures = 0;
        await secureBaseEntrance(bot, target);
        console.log(`[SHELTER] entered base ${target.toString()}`);
    } else {
        baseEntryFailures++;
        if (baseEntryFailures >= 3) {
            const shellScore = scoreShelterShell(bot, target);
            if (shellScore < SHELL_TARGET) {
                memory.setConstructionBase(target);
                memory.clearBase();
                activeShelterBase = target.clone();
                activeShelterShellReady = false;
                console.log(
                    `[SHELTER] base entrance failed with damaged shell=${shellScore}; ` +
                    'queued structural repair'
                );
            } else {
                console.log('[SHELTER] base entrance failed repeatedly; shell remains valid');
            }
            baseEntryFailures = 0;
        }
    }
    return entered;
}

function isTraversalFoliage(block) {
    const name = block?.name || '';
    return name.endsWith('_leaves') || [
        'leaf_litter', 'short_grass', 'tall_grass', 'fern', 'large_fern',
        'vine', 'snow', 'moss_carpet', 'wildflowers'
    ].includes(name) || name.endsWith('_flower');
}

async function descendFromShelterWall(bot, base) {
    if (bot.entity.position.distanceTo(base) > 6) return;
    if (bot.entity.position.y <= base.y + 0.5) return;
    const relativeX = bot.entity.position.x - (base.x + 0.5);
    const relativeZ = bot.entity.position.z - (base.z + 0.5);
    let outwardX = 0;
    let outwardZ = 0;
    if (Math.abs(relativeX) >= Math.abs(relativeZ)) outwardX = Math.sign(relativeX) * 4;
    else outwardZ = Math.sign(relativeZ) * 4;
    const frontYard = base.offset(outwardX + 0.5, 0, outwardZ - 4.5);
    try {
        await bot.lookAt(frontYard.offset(0, 1, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', false);
        await movement.sleep(1800);
        await movement.sleep(500);
        console.log(`[SHELTER] descended from wall toward ${frontYard.floored().toString()}`);
    } finally {
        movement.stop(bot);
    }
}

function calibrateRememberedBase(bot, rememberedBase) {
    const rememberedScore = scoreShelterShell(bot, rememberedBase);
    if (rememberedScore >= SHELL_TARGET - 8) return rememberedBase;
    const candidates = [rememberedBase];
    const utilityOffsets = [
        ['chest', new Vec3(1, 0, -1)],
        ['crafting_table', new Vec3(-1, 0, -1)]
    ];
    for (const [name, offset] of utilityOffsets) {
        const id = bot.registry.blocksByName?.[name]?.id;
        if (!Number.isInteger(id)) continue;
        const positions = bot.findBlocks({ matching: id, maxDistance: 32, count: 12 });
        positions.forEach(position => candidates.push(position.plus(offset)));
    }

    const best = candidates
        .map(position => ({ position, score: scoreShelterShell(bot, position) }))
        .sort((left, right) => right.score - left.score)[0];
    if (!best || best.score < SHELL_TARGET - 8) return rememberedBase;
    if (!best.position.equals(rememberedBase)) {
        memory.setBase(best.position);
        blockPolicy.syncBaseProtection(best.position);
        console.log(
            `[SHELTER] calibrated base ${rememberedBase.toString()} -> ` +
            `${best.position.toString()} shell=${best.score}`
        );
    }
    return best.position;
}

async function secureBaseEntrance(bot, base) {
    const door = bot.blockAt(base.offset(0, 0, -2));
    if (!door?.name?.endsWith('_door') || door.getProperties?.().open !== true) return;
    try {
        await bot.activateBlock(door);
        await movement.sleep(200);
        console.log('[SHELTER] base door closed');
    } catch (error) {
        console.log(`[SHELTER] door close delayed: ${error.message}`);
    }
}

async function enterShelter(bot, base) {
    await ensureEntranceFloor(bot, base);
    await ensureBaseEgress(bot);
    const outside = base.offset(0, 0, -3);
    const staging = base.offset(0.5, 0, -3.5);
    await movement.walkToward(bot, staging, { durationMs: 1800 });
    await climbDoorApproach(bot, outside, base.y);
    const releasedCorner = await releaseDoorCorner(bot, base);
    const side = Math.sign(bot.entity.position.x - (base.x + 0.5));
    const insideTargets = releasedCorner.length > 0 && side !== 0
        ? [base.offset(side * 2, 0, -1), base.offset(side, 0, -1), base]
        : [base.offset(0, 0, -1), base];
    for (const inside of insideTargets) {
        await movement.walkToward(bot, inside, { durationMs: 2200 });
        if (isInsideShelter(bot.entity.position, base)) {
            const repairPositions = side !== 0
                ? doorCornerPositions(base, side)
                : releasedCorner;
            await restoreDoorCorner(bot, repairPositions);
            return true;
        }
    }
    return false;
}

async function releaseDoorCorner(bot, base) {
    const doorCenter = base.offset(0.5, 0, -1.5);
    const relativeX = bot.entity.position.x - doorCenter.x;
    const closeToEntrance = Math.abs(bot.entity.position.z - doorCenter.z) <= 2.25;
    if (!closeToEntrance || Math.abs(relativeX) < 0.65 || Math.abs(relativeX) > 2.25) return [];

    const side = Math.sign(relativeX);
    const positions = doorCornerPositions(base, side);
    const released = [];
    for (const position of positions) {
        const block = bot.blockAt(position);
        if (!block || isAir(block) || block.name.endsWith('_door')) continue;
        await clearBlock(bot, block);
        released.push(position);
    }
    if (released.length > 0) {
        console.log(`[SHELTER] released blocked door corner side=${side}`);
    }
    return released;
}

function doorCornerPositions(base, side) {
    return [
        base.offset(side, 0, -2),
        base.offset(side, 1, -2),
        base.offset(side * 2, 0, -2),
        base.offset(side * 2, 1, -2),
        base.offset(side * 2, 0, -1),
        base.offset(side * 2, 1, -1)
    ];
}

async function restoreDoorCorner(bot, positions) {
    for (const position of positions) {
        const current = bot.blockAt(position);
        if (current && !isAir(current)) continue;
        const restored = await placeBuildBlock(bot, position, WOOD_BLOCKS);
        if (!restored) {
            console.log(`[SHELTER] door corner restore delayed at ${position.toString()}`);
        }
    }
}

async function climbDoorApproach(bot, outside, floorY) {
    const center = outside.offset(0.5, 0, 0.5);
    const deadline = Date.now() + 4200;
    try {
        await bot.lookAt(center.offset(0, 1.1, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        while (Date.now() < deadline) {
            const close = horizontalDistance(bot.entity.position, center) <= 1.25;
            const onThreshold = bot.entity.position.y >= floorY - 0.1;
            if (close && onThreshold) return true;
            syncGroundedPhysics(bot);
            bot.setControlState('jump', bot.entity.position.y < floorY - 0.1);
            await movement.sleep(75);
        }
    } finally {
        movement.stop(bot);
    }
    return horizontalDistance(bot.entity.position, center) <= 1.5 &&
        bot.entity.position.y >= floorY - 0.1;
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function findBaseApproach(bot, base) {
    const candidates = [
        base.offset(0, 0, -4),
        base.offset(0, 0, -3),
    ];
    return candidates.find(position => isSupportedStand(bot, position)) || candidates[0];
}

function isSupportedStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
}

async function walkTowardBase(bot, target, base = target) {
    const deadline = Date.now() + 18000;
    try {
        while (Date.now() < deadline && bot.entity.position.distanceTo(target) > 1.5) {
            await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', false);
            await movement.sleep(300);
        }
    } finally {
        movement.stop(bot);
    }
    if (bot.entity.position.distanceTo(base) > 5) {
        throw new Error(`Could not return to base from ${bot.entity.position.floored().toString()}`);
    }
}

async function ensureBaseEgress(bot) {
    const remembered = memory.getBase();
    if (!remembered || !bot.entity) return;
    const base = new Vec3(remembered.x, remembered.y, remembered.z);
    if (bot.entity.position.distanceTo(base) > 5) return;

    const doorway = base.offset(0, 0, -2);
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
    const doorwayExit = base.offset(0, 0, -3);
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
    const threshold = base.offset(0, 0, -2);
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
    const verticalSpeed = Math.abs(bot.entity.velocity?.y || 0);
    if (floor?.boundingBox === 'block' && nearBlockTop && verticalSpeed < 0.08) {
        bot.entity.onGround = true;
    }
}

async function ensureEntranceFloor(bot, base) {
    const standingPosition = base.offset(0, 0, -3);
    for (const position of [standingPosition, standingPosition.offset(0, 1, 0)]) {
        const obstruction = bot.blockAt(position);
        if (!obstruction || isAir(obstruction)) continue;
        if (bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5)) < 0.9) continue;
        await clearBlock(bot, obstruction);
    }

    const supportPosition = standingPosition.offset(0, -1, 0);
    const support = bot.blockAt(supportPosition);
    if (support?.boundingBox === 'block') return;
    if (bot.entity.position.distanceTo(standingPosition.offset(0.5, 0, 0.5)) < 1.1) return;

    const item = bot.inventory.items().find(entry =>
        ['cobblestone', 'dirt'].includes(entry.name) || entry.name.endsWith('_planks')
    );
    if (!item) return;
    try {
        if (await placeSpecificItem(bot, item, supportPosition)) {
            console.log(`[SHELTER] repaired entrance support ${supportPosition.toString()}`);
        }
    } catch (error) {
        console.log(`[SHELTER] entrance floor repair delayed: ${error.message}`);
    }
}

function exteriorStands(bot, base) {
    const candidates = [];
    for (let radius = 3; radius <= 5; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== radius) continue;
                const position = base.offset(dx, 0, dz);
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
        const leftDoorBias = Math.abs(left.x - base.x) + Math.abs(left.z - (base.z - 3));
        const rightDoorBias = Math.abs(right.x - base.x) + Math.abs(right.z - (base.z - 3));
        return leftDoorBias - rightDoorBias ||
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position);
    });
}

function isInsideShelter(position, base) {
    return Math.abs(position.x - (base.x + 0.5)) <= 1.65 &&
        Math.abs(position.z - (base.z + 0.5)) <= 1.65 &&
        position.y >= base.y - 0.2 &&
        position.y <= base.y + 0.45;
}

async function jumpToward(bot, target) {
    syncGroundedPhysics(bot);
    await movement.walkToward(bot, target, { durationMs: 1200 });
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
    if (bot.blockAt(position)?.name === itemName) {
        memory.rememberPlacedBlock(itemName);
        return true;
    }
    const occupied = bot.blockAt(position);
    if (isReplaceableInteriorFoliage(occupied)) {
        await clearBlock(bot, occupied);
    }
    if (!isAir(bot.blockAt(position))) {
        console.log(
            `[SHELTER] ${itemName} target occupied by ` +
            `${bot.blockAt(position)?.name || 'unknown'}`
        );
        return false;
    }
    if (countItem(bot, itemName) <= 0) {
        if (itemName === 'crafting_table' || itemName === 'chest') await craft.craftItem(bot, itemName, 1);
        else return false;
    }
    await placeSpecific(bot, itemName, position);
    const placed = bot.blockAt(position)?.name === itemName;
    if (placed) memory.rememberPlacedBlock(itemName);
    return placed;
}

function isReplaceableInteriorFoliage(block) {
    const name = block?.name || '';
    return name.endsWith('_leaves') ||
        name.endsWith('_flower') ||
        name.endsWith('_sapling') || [
        'pale_moss_carpet',
        'wildflowers',
        'snow',
        'short_grass',
        'tall_grass',
        'fern',
        'large_fern',
        'vine',
        'pale_hanging_moss'
    ].includes(name);
}

async function moveForUtilityPlacement(bot, base, utilityPosition) {
    const stands = [
        utilityPosition.offset(1, 0, 0),
        base.offset(0, 0, -3),
        base
    ];
    for (const stand of stands) {
        if (!isSupportedStand(bot, stand)) continue;
        try {
            await movement.moveBlock(bot, stand, 7000);
            if (bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) <= 2) return;
        } catch {
            movement.stop(bot);
        }
    }
    try {
        await movement.moveNear(bot, utilityPosition, 2, 8000);
    } catch {
        await jumpToward(bot, utilityPosition);
    }
}

function isSupportedStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
}

async function placeBuildBlock(bot, position, preferredNames = []) {
    const current = bot.blockAt(position);
    if (!current || !isAir(current)) return false;

    const item = [...new Set([...preferredNames, ...BUILD_BLOCKS])]
        .map(name => bot.inventory.items().find(entry => entry.name === name))
        .find(Boolean);
    if (!item) throw new Error('Ev yapmak icin blok yok');

    return placeSpecificItem(bot, item, position);
}

async function placeSpecific(bot, itemName, position) {
    const item = bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) return;
    return placeSpecificItem(bot, item, position);
}

async function placeSpecificItem(bot, item, position) {
    const reference = findReference(bot, position);
    if (!reference) return false;

    try {
        const placementCenter = position.offset(0.5, 0.5, 0.5);
        if (bot.entity.position.distanceTo(placementCenter) > 4.25) {
            await movement.moveNear(bot, position, 4, 8000);
        }
        await bot.equip(item, 'hand');
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(reference.block, reference.face);
        await movement.sleep(600);
        const placed = bot.blockAt(position);
        return Boolean(placed && !isAir(placed));
    } catch (error) {
        const placed = bot.blockAt(position);
        if (placed && !isAir(placed)) return true;
        console.log(`[SHELTER] skipped placing ${item.name} ${position.toString()}: ${error.message}`);
        return false;
    }
}

function scoreShelterShell(bot, base) {
    if (!base?.offset) base = new Vec3(Number(base.x), Number(base.y), Number(base.z));
    let score = 0;
    for (let y = 0; y <= HOUSE_ROOF_Y; y++) {
        for (let dx = -HOUSE_RADIUS; dx <= HOUSE_RADIUS; dx++) {
            for (let dz = -HOUSE_RADIUS; dz <= HOUSE_RADIUS; dz++) {
                const edge = Math.abs(dx) === HOUSE_RADIUS || Math.abs(dz) === HOUSE_RADIUS;
                const roof = y === HOUSE_ROOF_Y;
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

function isDoorSpace(dx, y, dz) {
    return dx === 0 && dz === -HOUSE_RADIUS && (y === 0 || y === 1);
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function clearBlock(bot, block) {
    // Lazy loading avoids the shelter -> mine -> shelter module cycle.
    return require('./mine').clearBlock(bot, block);
}

module.exports = {
    SHELL_TARGET,
    buildSafeShelter,
    scoreShelterShell,
    returnToBase,
    isBuildingNear,
    needsOnlyUtilityRepair,
    ensureBaseEgress,
    leaveBase,
    isInsideShelter,
    placeSpecific
};
