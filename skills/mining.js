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
const survival = require('./survival');
const blockPolicy = require('../safety/blockPolicy');

const IRON_ORES = ['iron_ore', 'deepslate_iron_ore'];
const LOG_ITEMS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log'];
const PLANK_ITEMS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'pale_oak_planks'];
const MINE_DIRECTIONS = [
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, -1)
];
let mineDirectionIndex = 0;

async function prepareMiningKit(bot, actionVersion = actionControl.snapshot(bot)) {
    actionControl.assertActive(bot, actionVersion);
    await recoverPreparationSurface(bot);
    actionControl.assertActive(bot, actionVersion);
    const rememberedBase = memory.getBase();
    if (rememberedBase && bot.entity.position.distanceTo(
        new Vec3(rememberedBase.x, rememberedBase.y, rememberedBase.z)
    ) > 5) {
        const returned = await shelter.returnToBase(bot);
        if (!returned) throw new Error('Mining kit preparation could not return to base');
    }
    actionControl.assertActive(bot, actionVersion);
    await ensureMiningPickaxes(bot);
    actionControl.assertActive(bot, actionVersion);
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureFurnace(bot);
    actionControl.assertActive(bot, actionVersion);
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureFuel(bot);
    actionControl.assertActive(bot, actionVersion);
    await ensureTorches(bot, 16);
    actionControl.assertActive(bot, actionVersion);
    await ensureFuel(bot, 1);
    actionControl.assertActive(bot, actionVersion);
    await ensureBlocks(bot, 16);
    actionControl.assertActive(bot, actionVersion);
    await recoverPreparationSurface(bot);
    actionControl.assertActive(bot, actionVersion);
    await shelter.returnToBase(bot);
    actionControl.assertActive(bot, actionVersion);
}

async function ensureMiningPickaxes(bot) {
    const pickaxes = inventoryItems(bot).filter(item => item.name.endsWith('_pickaxe'));
    const serviceable = pickaxes.filter(item => remainingDurability(bot, item) >= 32);
    if (serviceable.length >= 2 || (
        serviceable.some(item => item.name === 'stone_pickaxe') &&
        pickaxes.some(item => item !== serviceable[0] && remainingDurability(bot, item) >= 16)
    )) return;

    await ensurePickaxeMaterials(bot);
    const itemName = countItem(bot, 'cobblestone') >= 3 ? 'stone_pickaxe' : 'wooden_pickaxe';
    console.log(`[MINING_KIT] crafting backup ${itemName}`);
    await craft.craftItem(bot, itemName, 1);

    const usable = inventoryItems(bot)
        .filter(item => item.name.endsWith('_pickaxe'))
        .filter(item => remainingDurability(bot, item) >= 16);
    if (usable.length === 0) throw new Error('Mining kit has no usable pickaxe');
}

async function ensurePickaxeMaterials(bot) {
    if (totalPlanks(bot) < 3) {
        const log = inventoryItems(bot).find(item => LOG_ITEMS.includes(item.name));
        if (log) await craft.craftItem(bot, log.name.replace(/_log$/, '_planks'), 4);
    }
    if (countItem(bot, 'stick') < 2) await craft.craftItem(bot, 'stick', 2);
    if (totalPlanks(bot) < 3 || countItem(bot, 'stick') < 2) {
        throw new Error('Mining kit cannot craft a backup pickaxe');
    }
}

function remainingDurability(bot, item) {
    if (!item) return 0;
    const registryItem = bot?.registry?.itemsByName?.[item.name];
    const maximum = Number(item.maxDurability || registryItem?.maxDurability || 0);
    if (!maximum) return Number.POSITIVE_INFINITY;
    return Math.max(0, maximum - Number(item.durabilityUsed || 0));
}

async function mineIron(bot, targetRawIron = 16) {
    const actionVersion = actionControl.snapshot(bot);
    await prepareMiningKit(bot, actionVersion);
    actionControl.assertActive(bot, actionVersion);
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    await moveToSafeMineEntrance(bot);
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
    const direction = directionTowardKnownIron(bot) || directionForRoute(route) ||
        directionAwayFromBase(bot) || MINE_DIRECTIONS[mineDirectionIndex++ % MINE_DIRECTIONS.length];
    console.log(`[IRON_MINE] target raw_iron=${target} start=${start.toString()}`);

    try {
        for (let step = 0; step < 80 && countItem(bot, 'raw_iron') < target; step++) {
            actionControl.assertActive(bot, actionVersion);
            await collectLooseDrops(bot, 3);
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
            const stepDirection = directionTowardKnownIron(bot) || direction;
            const position = await carveMiningStep(bot, step, stepDirection);
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

async function returnToSurface(bot) {
    const route = memory.getMineRoute();
    if (route.length === 0) {
        await shelter.returnToBase(bot);
        return;
    }
    const actionVersion = actionControl.snapshot(bot);
    const returned = await returnMiningRoute(bot, route, actionVersion);
    if (!returned) {
        await survival.escapePit(bot);
        if (memory.getMineRoute().length === 0) {
            await returnTowardBase(bot, new Vec3(route[0].x, route[0].y, route[0].z));
            return;
        }
        throw new Error(`Mine return incomplete at ${bot.entity.position.floored().toString()}`);
    }
    await returnTowardBase(bot, new Vec3(route[0].x, route[0].y, route[0].z));
    memory.clearMineRoute();
    memory.clearSurfaceExit();
}

async function ensureFurnace(bot) {
    if (countItem(bot, 'furnace') > 0 || findNearbyBlock(bot, 'furnace', 16)) return;
    if (countItem(bot, 'cobblestone') < 8) {
        await stone.collectStone(bot, 8 - countItem(bot, 'cobblestone'));
    }
    if (countItem(bot, 'cobblestone') < 8) throw new Error('Furnace icin 8 cobblestone toplanamadi');
    await recoverPreparationSurface(bot);
    if (memory.hasBase() && !await shelter.returnToBase(bot)) {
        throw new Error('Furnace craft edilmeden once base calisma alanina donulemedi');
    }
    await craft.craftItem(bot, 'furnace', 1);
}

async function recoverPreparationSurface(bot) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const target = memory.getSurfaceExit() || memory.getBase();
        if (hasSkyExposure(bot) || !needsPreparationSurfaceReturn(bot.entity.position, target)) {
            return true;
        }
        console.log(
            `[MINING_KIT] returning to surface before resource preparation ` +
            `attempt=${attempt + 1} y=${bot.entity.position.y.toFixed(1)} targetY=${target.y}`
        );
        await survival.escapePit(bot);
    }
    const target = memory.getSurfaceExit() || memory.getBase();
    if (!hasSkyExposure(bot) && needsPreparationSurfaceReturn(bot.entity.position, target)) {
        throw new Error(
            `Mining kit surface recovery incomplete y=${bot.entity.position.y.toFixed(1)} ` +
            `targetY=${target.y}`
        );
    }
    return true;
}

function hasSkyExposure(bot) {
    const feet = bot.entity.position.floored();
    const values = [feet, feet.offset(0, 1, 0)].map(position =>
        Number(bot.blockAt(position)?.skyLight ?? -1)
    );
    return Math.max(...values) >= 10;
}

function needsPreparationSurfaceReturn(position, target) {
    return Boolean(position && target && position.y < target.y - 0.1);
}

async function ensureFuel(bot, minimum = 1) {
    if (fuelCount(bot) >= minimum) return;
    const coalCandidates = findReachableBlocks(bot, 'coal_ore', 24);
    for (const coal of coalCandidates) {
        if (fuelCount(bot) >= minimum) return;
        try {
            await mine.mineSpecificBlock(bot, coal, 'coal');
        } catch (error) {
            console.log(`[MINING] coal candidate skipped ${coal.position.toString()}: ${error.message}`);
        }
    }
    if (fuelCount(bot) >= minimum) return;
    console.log('[MINING] reachable coal exhausted; preparing charcoal.');
    await ensureCharcoal(bot, minimum - fuelCount(bot));
}

async function ensureCharcoal(bot, amount = 1) {
    let collectionAttempts = 0;
    while (!hasCharcoalMaterials(bot, amount)) {
        if (collectionAttempts >= 3) {
            throw new Error(`Charcoal icin guvenli odun ${collectionAttempts} denemede bulunamadi`);
        }
        collectionAttempts++;
        await recoverPreparationSurface(bot);
        if (memory.hasBase()) await shelter.returnToBase(bot);
        await shelter.leaveBase(bot);
        try {
            await mine.mineBlock(bot, { target: 'any_log' });
        } catch (error) {
            console.log(
                `[MINING] charcoal wood attempt=${collectionAttempts} failed: ${error.message}`
            );
        }
    }
    await recoverPreparationSurface(bot);
    if (memory.hasBase() && !await shelter.returnToBase(bot)) {
        throw new Error('Charcoal eritmek icin base furnace alanina donulemedi');
    }
    let remaining = amount;
    for (const logName of LOG_ITEMS) {
        if (remaining <= 0) break;
        const available = countItem(bot, logName);
        if (available <= 0) continue;
        const batch = Math.min(remaining, available);
        for (let index = 0; index < batch; index++) {
            await smelting.smeltItem(bot, logName, 'charcoal', 1);
        }
        remaining -= batch;
    }
    if (remaining > 0) throw new Error(`Charcoal icin ${remaining} log eksik`);
}

function hasCharcoalMaterials(bot, amount) {
    const externalFuel = countItem(bot, 'coal') + countItem(bot, 'charcoal') +
        PLANK_ITEMS.reduce((sum, name) => sum + countItem(bot, name), 0) +
        (smelting.hasCharcoalStarterFuel(bot) ? 1 : 0);
    const fuelLogs = externalFuel > 0 ? 0 : Math.ceil(amount / 1.5);
    const requiredLogs = amount + fuelLogs;
    return totalLogs(bot) >= requiredLogs;
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
    for (let attempt = 0; attempt < 3; attempt++) {
        const plankCount = PLANK_ITEMS.reduce((sum, name) => sum + countItem(bot, name), 0);
        if (plankCount >= minimum) return;
        let log = LOG_ITEMS.find(name => countItem(bot, name) > 0);
        if (!log) {
            await mine.mineBlock(bot, { target: 'any_log' });
            log = LOG_ITEMS.find(name => countItem(bot, name) > 0);
        }
        if (log) await craft.craftItem(bot, log.replace(/_log$/, '_planks'), 4);
    }
    throw new Error(`Plank reserve could not reach ${minimum}`);
}

async function mineOre(bot, ore) {
    const policy = blockPolicy.canBreak(bot, ore, 'mining');
    if (!policy.allowed) throw new Error(`Protected iron ore skipped: ${policy.reason}`);
    const before = countItem(bot, 'raw_iron');
    await equipPickaxe(bot);
    try {
        await movement.moveNear(bot, ore.position, 3, 8000);
    } catch {
        await nudgeToward(bot, ore.position);
    }

    const current = bot.blockAt(ore.position);
    if (!current || !IRON_ORES.includes(current.name)) return;
    const reach = bot.entity.position.offset(0, 1.65, 0)
        .distanceTo(current.position.offset(0.5, 0.5, 0.5));
    if (reach > 4.5) {
        throw new Error(`Iron ore remains out of reach (${reach.toFixed(2)})`);
    }
    await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
    await digWithTimeout(bot, current);
    await collectNearby(bot, 'raw_iron', before, current.position);
    const after = countItem(bot, 'raw_iron');
    console.log(`[IRON_MINE] raw_iron ${before} -> ${after}`);
    if (after <= before) {
        throw new Error(`Iron ore broke but raw_iron was not collected at ${current.position.toString()}`);
    }
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
    const policy = blockPolicy.canBreak(bot, block, 'mining');
    if (!policy.allowed) {
        throw new Error(`Mining route refused ${block.name} ${position.toString()}: ${policy.reason}`);
    }
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

    const anchor = new Vec3(route[index].x, route[index].y, route[index].z);
    if (!bot.entity.position.floored().equals(anchor)) {
        try {
            await movement.moveBlock(bot, anchor, 6500);
        } catch {
            movement.stop(bot);
            await nudgeToward(bot, anchor);
        }
        if (bot.entity.position.distanceTo(anchor.offset(0.5, 0, 0.5)) > 2.5) {
            console.log(`[IRON_MINE] could not reconnect to route at ${anchor.toString()}`);
            return false;
        }
    }

    for (index -= 1; index >= 0; index--) {
        actionControl.assertActive(bot, actionVersion);
        const target = new Vec3(route[index].x, route[index].y, route[index].z);
        try {
            await movement.moveBlock(bot, target, 6500);
        } catch {
            movement.stop(bot);
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
        .filter(block => blockPolicy.canBreak(bot, block, 'mining').allowed)
        .filter(block => hasOpenFace(bot, block.position))
        .filter(block => block.position.distanceTo(bot.entity.position) <= 5)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
}

function findReachableBlocks(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return [];
    return bot.findBlocks({ matching: id, maxDistance, count: 16 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => blockPolicy.canBreak(bot, block, 'mining').allowed)
        .filter(block => hasOpenFace(bot, block.position))
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) -
            right.position.distanceTo(bot.entity.position)
        );
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
    await movement.sleep(500);
}

async function digWithTimeout(bot, block) {
    if (bot.version === '26.2' && await digWithProtocol(bot, block)) return;
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

async function digWithProtocol(bot, block) {
    const duration = Math.max(250, Math.min(5000, Number(bot.digTime?.(block) || 1000) + 250));
    console.log(`[IRON_MINE] protocol dig ${block.name} ${block.position.toString()} wait=${duration}`);
    bot._client.write('block_dig', { status: 0, location: block.position, face: 1 });
    bot.swingArm();
    await movement.sleep(duration);
    bot._client.write('block_dig', { status: 2, location: block.position, face: 1 });

    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
        if (bot.blockAt(block.position)?.name !== block.name) return true;
        await movement.sleep(100);
    }
    return false;
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
                await movement.moveNear(bot, drop.position, 1, 3500);
            } catch {
                movement.stop(bot);
                await nudgeToward(bot, drop.position);
            }
        } else if (i < 3) {
            await nudgeToward(bot, origin);
        }
        await movement.sleep(350);
    }
}

async function collectLooseDrops(bot, maximum) {
    for (let attempt = 0; attempt < maximum; attempt++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item' && entity.position)
            .filter(entity => entity.position.distanceTo(bot.entity.position) <= 16)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) -
                right.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) return;
        try {
            await movement.moveBlock(bot, drop.position.floored(), 3500);
        } catch {
            movement.stop(bot);
            await nudgeToward(bot, drop.position);
        }
        await movement.sleep(350);
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

function directionTowardKnownIron(bot) {
    const ids = IRON_ORES.map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
    if (ids.length === 0) return null;
    const nearest = bot.findBlocks({ matching: ids, maxDistance: 48, count: 128 })
        .filter(position => {
            const block = bot.blockAt(position);
            return block && blockPolicy.canBreak(bot, block, 'mining').allowed;
        })
        .sort((left, right) =>
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position)
        )[0];
    if (!nearest) return null;
    const dx = nearest.x - bot.entity.position.x;
    const dz = nearest.z - bot.entity.position.z;
    if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) >= 0.5) {
        return new Vec3(Math.sign(dx), 0, 0);
    }
    if (Math.abs(dz) >= 0.5) return new Vec3(0, 0, Math.sign(dz));
    return null;
}

async function moveToSafeMineEntrance(bot) {
    const base = memory.getBase();
    if (!base) return;
    const center = new Vec3(base.x, base.y, base.z);
    const ore = nearestPolicySafeIron(bot, 64);
    const candidates = [
        new Vec3(12, 0, 0), new Vec3(-12, 0, 0),
        new Vec3(0, 0, 12), new Vec3(0, 0, -12),
        new Vec3(9, 0, 9), new Vec3(9, 0, -9),
        new Vec3(-9, 0, 9), new Vec3(-9, 0, -9)
    ]
        .map(offset => center.plus(offset))
        .filter(position => isSupportedStand(bot, position))
        .filter(position => !blockPolicy.protectedZoneAt(position))
        .sort((left, right) => {
            if (ore) return left.distanceTo(ore.position) - right.distanceTo(ore.position);
            return left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position);
        });
    const entrance = candidates[0];
    if (!entrance) throw new Error('No policy-safe supported mine entrance found outside base');
    try {
        await movement.moveNear(bot, entrance, 1, 20000);
    } catch {
        for (let attempt = 0; attempt < 3 && bot.entity.position.distanceTo(entrance) > 2; attempt++) {
            await movement.moveTowardSafely(bot, entrance, 18);
        }
    }
    if (bot.entity.position.distanceTo(center) <= 10.5) {
        throw new Error(`Mine entrance remained inside base protection at ${bot.entity.position.floored().toString()}`);
    }
    console.log(`[IRON_MINE] safe entrance ${bot.entity.position.floored().toString()}`);
}

function nearestPolicySafeIron(bot, maxDistance) {
    const ids = IRON_ORES.map(name => bot.registry.blocksByName[name]?.id).filter(Boolean);
    if (ids.length === 0) return null;
    return bot.findBlocks({ matching: ids, maxDistance, count: 128 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => blockPolicy.canBreak(bot, block, 'mining').allowed)
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function directionAwayFromBase(bot) {
    const base = memory.getBase();
    if (!base) return null;
    const dx = bot.entity.position.x - base.x;
    const dz = bot.entity.position.z - base.z;
    if (Math.abs(dx) >= Math.abs(dz) && Math.abs(dx) >= 1) {
        return new Vec3(Math.sign(dx), 0, 0);
    }
    if (Math.abs(dz) >= 1) return new Vec3(0, 0, Math.sign(dz));
    return null;
}

function isSupportedStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
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

function totalPlanks(bot) {
    return PLANK_ITEMS.reduce((sum, name) => sum + countItem(bot, name), 0);
}

function inventoryItems(bot) {
    return (bot.inventory?.slots || []).filter(Boolean);
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
    mineIron,
    returnToSurface,
    needsPreparationSurfaceReturn,
    remainingDurability
};
