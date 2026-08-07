const { Vec3 } = require('vec3');
const craft = require('./craft');
const mine = require('./mine');
const stone = require('./stone');
const movement = require('./movement');
const smelting = require('./smelting');
const food = require('./food');
const shelter = require('./shelter');
const memory = require('./memory');
const actionControl = require('./actionControl');

const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
const LOG_ITEMS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log'];
const PLANK_ITEMS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks'];
const MINE_DIRECTIONS = [
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, -1)
];
let mineDirectionIndex = 0;

async function prepareMiningKit(bot, actionVersion = actionControl.snapshot(bot)) {
    actionControl.assertActive(bot, actionVersion);
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureFurnace(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureFuel(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureTorches(bot, 16);
    actionControl.assertActive(bot, actionVersion);
    await ensureFuel(bot, 3);
    actionControl.assertActive(bot, actionVersion);
    await ensureBlocks(bot, 16);
    actionControl.assertActive(bot, actionVersion);
}

async function mineIron(bot, targetRawIron = 16) {
    const actionVersion = actionControl.snapshot(bot);
    await prepareMiningKit(bot, actionVersion);
    actionControl.assertActive(bot, actionVersion);
    const before = countItem(bot, 'raw_iron');
    const target = Math.max(before + 1, targetRawIron);
    const start = bot.entity.position.floored();
    const savedRoute = memory.getMineRoute();
    const route = canResumeRoute(bot, savedRoute) ? savedRoute : [toPosition(start)];
    if (route.length === 1) {
        memory.setSurfaceExit(start);
        memory.setMineRoute(route);
    }
    const direction = directionForRoute(route) ||
        MINE_DIRECTIONS[mineDirectionIndex++ % MINE_DIRECTIONS.length];
    console.log(`[IRON_MINE] target raw_iron=${target} start=${start.toString()}`);

    try {
        for (let step = 0; step < 80 && countItem(bot, 'raw_iron') < target; step++) {
            actionControl.assertActive(bot, actionVersion);
            if (bot.food <= 12 && food.foodScore(countInventory(bot)) > 0) {
                await food.eatBestFood(bot);
                actionControl.assertActive(bot, actionVersion);
            }

            const ore = findReachableIronOre(bot);
            if (ore) {
                await mineOre(bot, ore);
                actionControl.assertActive(bot, actionVersion);
                continue;
            }

            await placeTorchIfNeeded(bot);
            actionControl.assertActive(bot, actionVersion);
            const position = await carveMiningStep(bot, step, direction);
            actionControl.assertActive(bot, actionVersion);
            appendRoute(route, position);
            memory.appendMineRoute(position);
        }
    } finally {
        if (actionControl.snapshot(bot) !== actionVersion) {
            movement.stop(bot);
            actionControl.assertActive(bot, actionVersion);
        }
        const returned = await returnMiningRoute(bot, route, actionVersion);
        if (returned) {
            await returnTowardBase(bot, new Vec3(route[0].x, route[0].y, route[0].z));
            memory.clearMineRoute();
            memory.clearSurfaceExit();
        }
    }

    if (countItem(bot, 'raw_iron') <= before) {
        throw new Error('Iron mine opened but no raw_iron was collected');
    }
}

async function ensureFurnace(bot) {
    if (countItem(bot, 'furnace') > 0 || findNearbyBlock(bot, 'furnace', 16)) return;
    if (countItem(bot, 'cobblestone') < 8) {
        await stone.collectStone(bot, 8 - countItem(bot, 'cobblestone'));
    }
    if (countItem(bot, 'cobblestone') < 8) throw new Error('Furnace icin 8 cobblestone toplanamadi');
    await craft.craftItem(bot, 'furnace', 1);
}

async function ensureFuel(bot, minimum = 1) {
    if (fuelCount(bot) >= minimum) return;
    const coal = findReachableBlock(bot, 'coal_ore', 24);
    if (coal) {
        try {
            await mine.mineBlock(bot, { target: 'coal_ore', expectedDrop: 'coal' });
        } catch (error) {
            console.log(`[MINING] coal fallback to charcoal: ${error.message}`);
        }
        if (fuelCount(bot) >= minimum) return;
    }
    while (fuelCount(bot) < minimum) {
        await ensureCharcoal(bot);
    }
}

async function ensureCharcoal(bot) {
    while (totalLogs(bot) < 2) {
        await mine.mineBlock(bot, { target: 'any_log' });
    }
    const currentLog = LOG_ITEMS.find(name => countItem(bot, name) > 0);
    if (!currentLog) throw new Error('Charcoal icin log bulunamadi');
    await smelting.smeltItem(bot, currentLog, 'charcoal', 1);
}

async function ensureTorches(bot, minimum) {
    if (countItem(bot, 'torch') >= minimum) return;
    const missing = minimum - countItem(bot, 'torch');
    await ensureFuel(bot, Math.ceil(missing / 4));
    if (countItem(bot, 'stick') < 4) {
        await ensurePlanks(bot, 2);
        while (countItem(bot, 'stick') < 4) {
            await craft.craftItem(bot, 'stick', 2);
        }
    }
    await craft.craftItem(bot, 'torch', minimum - countItem(bot, 'torch'));
}

async function ensureBlocks(bot, minimum) {
    const blocks = countItem(bot, 'cobblestone') + countItem(bot, 'dirt');
    if (blocks >= minimum) return;
    await stone.collectStone(bot, minimum - blocks);
}

async function ensurePlanks(bot, minimum) {
    if (PLANK_ITEMS.reduce((sum, name) => sum + countItem(bot, name), 0) >= minimum) return;
    const log = LOG_ITEMS.find(name => countItem(bot, name) > 0);
    if (!log) await mine.mineBlock(bot, { target: 'any_log' });
    const currentLog = LOG_ITEMS.find(name => countItem(bot, name) > 0);
    if (currentLog) await craft.craftItem(bot, currentLog.replace(/_log$/, '_planks'), 4);
}

async function mineOre(bot, ore) {
    const before = countItem(bot, 'raw_iron');
    await equipPickaxe(bot);
    try {
        await movement.moveNear(bot, ore.position, 3, 8000);
    } catch {
        await nudgeToward(bot, ore.position);
    }

    const current = bot.blockAt(ore.position);
    if (!current || !IRON_ORES.includes(current.name)) return;
    await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
    await digWithTimeout(bot, current);
    await collectNearby(bot, 'raw_iron', before, current.position);
    console.log(`[IRON_MINE] raw_iron ${before} -> ${countItem(bot, 'raw_iron')}`);
}

async function carveMiningStep(bot, step, direction) {
    const current = bot.entity.position.floored();
    const downEvery = step % 3 === 2 ? -1 : 0;
    const next = current.plus(direction).offset(0, downEvery, 0);

    await digIfNeeded(bot, next.offset(0, 1, 0));
    await digIfNeeded(bot, next);
    const floor = bot.blockAt(next.offset(0, -1, 0));
    if (!floor || isAir(floor) || floor.boundingBox !== 'block') {
        await placeSupport(bot, next.offset(0, -1, 0));
    }

    try {
        await movement.moveBlock(bot, next, 7000);
    } catch {
        await movement.moveNear(bot, next, 1, 5000);
    }
    return bot.entity.position.floored();
}

async function placeTorchIfNeeded(bot) {
    if (countItem(bot, 'torch') <= 0) return;
    const feet = bot.entity.position.floored();
    const nearbyTorch = findNearbyBlock(bot, 'torch', 7);
    if (nearbyTorch) return;

    const item = bot.inventory.items().find(entry => entry.name === 'torch');
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const target = feet;
    if (!item || !floor || !isAir(bot.blockAt(target))) return;

    try {
        await bot.equip(item, 'hand');
        await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
        await bot.placeBlock(floor, new Vec3(0, 1, 0));
        await movement.sleep(250);
        console.log(`[IRON_MINE] torch placed ${target.toString()}`);
    } catch (error) {
        console.log(`[IRON_MINE] torch skipped: ${error.message}`);
    }
}

async function placeSupport(bot, position) {
    const item = ['cobblestone', 'dirt']
        .map(name => bot.inventory.items().find(entry => entry.name === name))
        .find(Boolean);
    if (!item) throw new Error('Mining step has no floor and no support block');
    const below = bot.blockAt(position.offset(0, -1, 0));
    if (!below || below.boundingBox !== 'block') throw new Error(`No placement reference for support ${position.toString()}`);
    await bot.equip(item, 'hand');
    await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
    await bot.placeBlock(below, new Vec3(0, 1, 0));
    await movement.sleep(250);
}

async function digIfNeeded(bot, position) {
    const block = bot.blockAt(position);
    if (!block || isAir(block) || !bot.canDigBlock(block)) return;
    await equipPickaxe(bot);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await digWithTimeout(bot, block);
    await movement.sleep(150);
}

async function returnTowardBase(bot, start) {
    try {
        if (await shelter.returnToBase(bot)) return;
    } catch {
        // Fall back to the mining start.
    }
    try {
        await movement.moveNear(bot, start, 2, 15000);
    } catch {
        await nudgeToward(bot, start);
    }
}

async function returnMiningRoute(bot, route, actionVersion) {
    if (route.length === 0) return false;
    let index = nearestRouteIndex(bot, route);
    console.log(`[IRON_MINE] returning route points=${index + 1}`);

    for (index -= 1; index >= 0; index--) {
        actionControl.assertActive(bot, actionVersion);
        const target = new Vec3(route[index].x, route[index].y, route[index].z);
        try {
            await movement.moveBlock(bot, target, 6500);
        } catch {
            await nudgeToward(bot, target);
        }
        if (bot.entity.position.distanceTo(target.offset(0.5, 0, 0.5)) > 2.5) {
            console.log(`[IRON_MINE] route return paused at ${bot.entity.position.floored().toString()}`);
            return false;
        }
    }

    const entry = new Vec3(route[0].x, route[0].y, route[0].z);
    const reached = bot.entity.position.distanceTo(entry.offset(0.5, 0, 0.5)) <= 3;
    if (reached) console.log(`[IRON_MINE] route entry reached ${entry.toString()}`);
    return reached;
}

function findReachableIronOre(bot) {
    const ids = IRON_ORES.map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
    return bot.findBlocks({ matching: ids, maxDistance: 12, count: 32 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => hasOpenFace(bot, block.position))
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
}

function findReachableBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlocks({ matching: id, maxDistance, count: 16 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => hasOpenFace(bot, block.position))[0] || null;
}

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

async function equipPickaxe(bot) {
    const tool = ['iron_pickaxe', 'stone_pickaxe']
        .map(name => bot.inventory.items().find(item => item.name === name))
        .find(Boolean);
    if (!tool) throw new Error('Iron mining needs at least a stone pickaxe');
    await bot.equip(tool, 'hand');
}

async function digWithTimeout(bot, block) {
    let timer = null;
    const timeoutMs = digTimeoutMs(bot, block);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try {
                bot.stopDigging();
            } catch {
                // Already stopped.
            }
            reject(new Error(`Timed out digging ${block.name} ${block.position.toString()}`));
        }, timeoutMs);
    });
    try {
        await Promise.race([bot.dig(block), timeout]);
    } finally {
        clearTimeout(timer);
    }
}

function digTimeoutMs(bot, block) {
    const digTime = Number(bot.digTime?.(block) || 0);
    if (!Number.isFinite(digTime) || digTime <= 0) return 22000;
    return Math.max(22000, Math.min(90000, digTime + 15000));
}

async function collectNearby(bot, itemName, before, origin) {
    for (let i = 0; i < 12; i++) {
        if (countItem(bot, itemName) > before) return;
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= 8)
            .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
        if (drop) {
            try {
                await movement.moveNear(bot, drop.position, 1, 4000);
            } catch {
                await nudgeToward(bot, drop.position);
            }
        }
        await movement.sleep(250);
    }
}

async function nudgeToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        if (position.y > bot.entity.position.y + 0.4) primeGroundedJump(bot);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(1600);
    } finally {
        bot.clearControlStates();
    }
}

function primeGroundedJump(bot) {
    const feet = bot.entity.position.floored();
    const floor = bot.blockAt(feet.offset(0, -1, 0));
    const verticalSpeed = Math.abs(bot.entity.velocity?.y || 0);
    if (floor?.boundingBox === 'block' && verticalSpeed < 0.08) {
        bot.entity.onGround = true;
        if (bot.entity.velocity) bot.entity.velocity.y = 0.42;
    }
}

function canResumeRoute(bot, route) {
    if (route.length < 2) return false;
    const entry = new Vec3(route[0].x, route[0].y, route[0].z);
    if (bot.entity.position.distanceTo(entry) <= 4) return false;
    return route.some(position =>
        bot.entity.position.distanceTo(new Vec3(position.x, position.y, position.z)) <= 5
    );
}

function directionForRoute(route) {
    if (route.length < 2) return null;
    for (let index = route.length - 1; index > 0; index--) {
        const dx = Math.sign(route[index].x - route[index - 1].x);
        const dz = Math.sign(route[index].z - route[index - 1].z);
        if (dx || dz) return new Vec3(dx, 0, dz);
    }
    return null;
}

function nearestRouteIndex(bot, route) {
    let bestIndex = route.length - 1;
    let bestDistance = Infinity;
    route.forEach((position, index) => {
        const distance = bot.entity.position.distanceTo(
            new Vec3(position.x, position.y, position.z)
        );
        if (distance < bestDistance) {
            bestDistance = distance;
            bestIndex = index;
        }
    });
    return bestIndex;
}

function appendRoute(route, position) {
    const next = toPosition(position);
    const last = route[route.length - 1];
    if (!last || last.x !== next.x || last.y !== next.y || last.z !== next.z) {
        route.push(next);
    }
}

function toPosition(position) {
    return {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
}

function countInventory(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

function fuelCount(bot) {
    return countItem(bot, 'coal') + countItem(bot, 'charcoal');
}

function totalLogs(bot) {
    return LOG_ITEMS.reduce((sum, name) => sum + countItem(bot, name), 0);
}

function countItem(bot, itemName) {
    const slotCount = bot.inventory.slots
        .filter(Boolean)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

function hasOpenFace(bot, position) {
    return [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0],
        [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ].some(([x, y, z]) => isAir(bot.blockAt(position.offset(x, y, z))));
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    prepareMiningKit,
    mineIron
};
