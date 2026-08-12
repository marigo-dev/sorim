const { Vec3 } = require('vec3');
const movement = require('./movement');
const tools = require('./tools');
const craft = require('./craft');
const smelting = require('./smelting');
const shelter = require('./shelter');
const entityActions = require('./entityActions');
const memory = require('./memory');
const actionControl = require('./actionControl');

const FOOD_VALUES = {
    bread: 5,
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_mutton: 6,
    cooked_chicken: 6,
    cooked_cod: 5,
    cooked_salmon: 6,
    beef: 3,
    porkchop: 3,
    mutton: 2,
    chicken: 2,
    cod: 2,
    salmon: 2,
    apple: 4,
    carrot: 3,
    potato: 1,
    baked_potato: 5,
    wheat: 0
};

const FOOD_MOBS = new Set([
    'cow',
    'pig',
    'sheep',
    'chicken'
]);

const RAW_TO_COOKED = {
    beef: 'cooked_beef',
    porkchop: 'cooked_porkchop',
    mutton: 'cooked_mutton',
    chicken: 'cooked_chicken',
    cod: 'cooked_cod',
    salmon: 'cooked_salmon',
    potato: 'baked_potato'
};

const CROP_RULES = {
    wheat: { age: 7, seed: 'wheat_seeds' },
    carrots: { age: 7, seed: 'carrot' },
    potatoes: { age: 7, seed: 'potato' },
    beetroots: { age: 3, seed: 'beetroot_seeds' }
};

let failedSearches = 0;
let foodUnavailableUntil = 0;

async function eatBestFood(bot) {
    const food = bestFoodItem(bot);
    if (!food) throw new Error('No edible food available');

    console.log(`[FOOD] yeniyor ${food.name}`);
    await bot.equip(food, 'hand');
    await bot.consume();
}

async function findFood(bot, options = {}) {
    const actionVersion = actionControl.snapshot(bot);
    const surfaceExit = memory.getSurfaceExit();
    if (surfaceExit && bot.entity.position.y < surfaceExit.y - 0.1) {
        console.log('[FOOD] returning to the surface before searching for food');
        await require('./survival').escapePit(bot);
        actionControl.assertActive(bot, actionVersion);
    }
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    await prepareCollectedFood(bot);
    actionControl.assertActive(bot, actionVersion);
    const preparedInventory = countInventory(bot);
    if (hasFoodStock(preparedInventory, 16)) {
        return { status: 'stock', foodCount: foodCount(preparedInventory) };
    }
    if (!options.skipFarm) {
        const homestead = require('./homestead');
        if (homestead.hasFarm(bot)) {
            const result = await maintainFoodSupply(bot, { alreadyOutside: true });
            return { status: 'farm', result };
        }
    }
    if (isTemporarilyUnavailable() && !hasActionableConvertibleFood(preparedInventory)) {
        console.log('[FOOD] no nearby food source; temporarily moving to the next goal.');
        return { status: 'unavailable' };
    }

    const crop = nearestMatureCrop(bot);
    if (crop) {
        let harvested = false;
        try {
            harvested = await harvestCrop(bot, crop);
        } catch (error) {
            console.log(`[FOOD] crop path failed: ${error.message}`);
            const unavailable = await markFailedSearch(bot);
            return { status: unavailable ? 'unavailable' : 'failed' };
        }
        await collectNearbyDrops(bot);
        if (harvested) await replantCrop(bot, crop.position, CROP_RULES[crop.name].seed);
        await prepareCollectedFood(bot);
        if (harvested) {
            failedSearches = 0;
            return { status: 'harvested' };
        }
    }

    const animal = nearestFoodMob(bot);
    if (!animal) {
        return searchForFood(bot, actionVersion);
    }

    const startDistance = animal.position.distanceTo(bot.entity.position);
    console.log(`[FOOD] hunting target ${animal.name} distance=${startDistance.toFixed(1)}`);
    await tools.equipBestWeapon(bot);
    try {
        await movement.moveNear(bot, animal.position, 1, 12000);
    } catch (error) {
        actionControl.assertActive(bot, actionVersion);
        console.log(`[FOOD] could not reach target: ${error.message}`);
        for (let attempt = 0; attempt < 3 && animal.isValid !== false; attempt++) {
            const beforeMove = animal.position.distanceTo(bot.entity.position);
            await movement.moveTowardSafely(bot, animal.position, 18);
            actionControl.assertActive(bot, actionVersion);
            if (animal.position.distanceTo(bot.entity.position) <= 3) break;
            if (animal.position.distanceTo(bot.entity.position) >= beforeMove - 0.5) break;
        }
        if (animal.isValid !== false && animal.position.distanceTo(bot.entity.position) > 4) {
            const unavailable = await markFailedSearch(bot);
            return { status: unavailable ? 'unavailable' : 'failed' };
        }
    }

    const before = foodScore(countInventory(bot));
    for (let i = 0; i < 14 && animal.isValid !== false; i++) {
        actionControl.assertActive(bot, actionVersion);
        const distance = animal.position.distanceTo(bot.entity.position);
        if (distance > 3) {
            try {
                await movement.moveNear(bot, animal.position, 1, 4000);
            } catch {
                await nudgeToward(bot, animal.position);
            }
        }
        await bot.lookAt(animal.position.offset(0, 0.8, 0), true);
        entityActions.attack(bot, animal);
        await movement.sleep(450);
    }

    actionControl.assertActive(bot, actionVersion);
    await collectNearbyDrops(bot);
    await prepareCollectedFood(bot);
    if (foodScore(countInventory(bot)) > before) {
        failedSearches = 0;
        return { status: 'hunted', gainedScore: foodScore(countInventory(bot)) - before };
    } else {
        const unavailable = await markFailedSearch(bot);
        return { status: unavailable ? 'unavailable' : 'failed' };
    }
}

async function maintainFoodSupply(bot, options = {}) {
    const homestead = require('./homestead');
    if (!options.alreadyOutside) await shelter.leaveBase(bot);
    await prepareCollectedFood(bot);
    if (hasFoodStock(countInventory(bot), 16)) {
        return { status: 'stock_ready', foodCount: foodCount(countInventory(bot)) };
    }

    const center = homestead.findFarmCenter(bot);
    if (!center) {
        return findFood(bot, { skipFarm: true });
    }

    let harvested = 0;
    for (; harvested < 16; harvested++) {
        const crop = nearestMatureCrop(bot);
        if (!crop) break;
        try {
            if (!await harvestCrop(bot, crop)) break;
            await collectNearbyDrops(bot);
            await replantCrop(bot, crop.position, CROP_RULES[crop.name].seed);
        } catch (error) {
            console.log(`[FOOD] farm maintenance delayed: ${error.message}`);
            break;
        }
    }

    if (harvested > 0) {
        failedSearches = 0;
        await prepareCollectedFood(bot);
        console.log(`[FOOD] farm harvest batch=${harvested}`);
    }
    if (hasFoodStock(countInventory(bot), 16)) {
        return { status: 'stock_ready', foodCount: foodCount(countInventory(bot)), harvested };
    }

    const capacity = homestead.farmCapacity(bot, center);
    if (capacity < 48 && countItem(bot, 'wheat_seeds') > 0) {
        const expansion = await homestead.expandWheatFarm(bot, 48);
        if (expansion.planted > 0) return { status: 'farm_expanded', ...expansion };
    }

    if (homestead.growingCropCount(bot) > 0) {
        await shelter.returnToBase(bot);
        console.log('[FOOD] crops are growing; waiting safely at base instead of roaming.');
        await movement.sleep(5000);
        return { status: 'crops_growing', growing: homestead.growingCropCount(bot) };
    }

    return findFood(bot, { skipFarm: true });
}

function foodScore(inventory) {
    return Object.entries(inventory)
        .reduce((sum, [name, count]) => sum + (FOOD_VALUES[name] || 0) * count, 0);
}

function hasFoodStock(inventory, minimum = 16) {
    return foodCount(inventory) >= minimum;
}

function foodCount(inventory) {
    return Object.entries(inventory)
        .reduce((sum, [name, count]) =>
            sum + ((FOOD_VALUES[name] || 0) > 0 ? count : 0), 0);
}

function isTemporarilyUnavailable() {
    return Date.now() < Math.max(
        foodUnavailableUntil,
        memory.getProgress('foodUnavailableUntil')
    );
}

function hasConvertibleFood(inventory) {
    if ((inventory.wheat || 0) >= 3) return true;
    return Object.keys(RAW_TO_COOKED).some(name => (inventory[name] || 0) > 0);
}

function hasActionableConvertibleFood(inventory) {
    if ((inventory.wheat || 0) >= 3) return true;
    const hasRaw = Object.keys(RAW_TO_COOKED).some(name => (inventory[name] || 0) > 0);
    if (!hasRaw) return false;
    const furnaceReady = (inventory.furnace || 0) > 0 || (inventory.cobblestone || 0) >= 8;
    const fuelReady = (inventory.coal || 0) > 0 ||
        (inventory.charcoal || 0) > 0 ||
        Object.entries(inventory).some(([name, count]) =>
            count > 0 && (name.endsWith('_log') || name.endsWith('_planks'))
        );
    return furnaceReady && fuelReady;
}

function bestFoodItem(bot) {
    return bot.inventory.items()
        .filter(item => (FOOD_VALUES[item.name] || 0) > 0)
        .sort((a, b) => FOOD_VALUES[b.name] - FOOD_VALUES[a.name])[0] || null;
}

function nearestFoodMob(bot) {
    return Object.values(bot.entities || {})
        .filter(entity => FOOD_MOBS.has(entity.name))
        .filter(entity => entity.position && entity.position.distanceTo(bot.entity.position) <= 24)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function nearestMatureCrop(bot) {
    const ids = Object.keys(CROP_RULES)
        .map(name => bot.registry.blocksByName[name]?.id)
        .filter(Number.isInteger);
    if (ids.length === 0) return null;

    return bot.findBlocks({ matching: ids, maxDistance: 24, count: 48 })
        .map(position => bot.blockAt(position))
        .filter(block => {
            const rule = CROP_RULES[block?.name];
            const age = Number(block?.getProperties?.().age);
            return rule && age >= rule.age;
        })
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) -
            right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

async function harvestCrop(bot, crop) {
    console.log(`[FOOD] harvesting ${crop.name} ${crop.position.toString()}`);
    await moveToCropStand(bot, crop.position);
    const current = bot.blockAt(crop.position);
    if (!current || current.name !== crop.name) return false;
    const distance = bot.entity.position.offset(0, 1.65, 0)
        .distanceTo(current.position.offset(0.5, 0.5, 0.5));
    console.log(`[FOOD] crop reach distance=${distance.toFixed(2)}`);
    if (distance > 3.5) return false;
    await digCropPacket(bot, current);
    await movement.sleep(250);
    return bot.blockAt(crop.position)?.name !== crop.name;
}

async function moveToCropStand(bot, cropPosition) {
    console.log(`[FOOD] approach from=${bot.entity.position.floored().toString()} crop=${cropPosition.toString()}`);
    try {
        await movement.moveNear(bot, cropPosition.offset(0.5, 0, 0.5), 2.4, 7000);
        if (cropReachDistance(bot, cropPosition) <= 3.5) return;
    } catch (error) {
        console.log(`[FOOD] near-crop path fallback: ${error.message}`);
    }

    const candidates = [
        cropPosition.offset(1, 0, 0),
        cropPosition.offset(-1, 0, 0),
        cropPosition.offset(0, 0, 1),
        cropPosition.offset(0, 0, -1)
    ]
        .filter(position => {
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            const floor = bot.blockAt(position.offset(0, -1, 0));
            return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
        })
        .sort((left, right) =>
            cropStandPenalty(bot, left) - cropStandPenalty(bot, right) ||
            left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position)
        );

    let lastError = null;
    for (const stand of candidates) {
        try {
            await movement.moveBlock(bot, stand, 4500);
            return;
        } catch (error) {
            lastError = error;
            if (await walkToCropStand(bot, stand)) return;
        }
    }
    throw lastError || new Error(`No crop stand near ${cropPosition.toString()}`);
}

function cropReachDistance(bot, position) {
    return bot.entity.position.offset(0, 1.65, 0)
        .distanceTo(position.offset(0.5, 0.5, 0.5));
}

function cropStandPenalty(bot, position) {
    return bot.blockAt(position.offset(0, -1, 0))?.name === 'farmland' ? 1 : 0;
}

async function walkToCropStand(bot, stand) {
    const deadline = Date.now() + 6500;
    try {
        while (Date.now() < deadline && bot.entity.position.distanceTo(stand) > 1.6) {
            await bot.lookAt(stand.offset(0.5, 0.3, 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', true);
            await movement.sleep(250);
        }
    } finally {
        movement.stop(bot);
    }
    console.log(`[FOOD] manual approach ended at=${bot.entity.position.floored().toString()} target=${stand.toString()}`);
    return bot.entity.position.distanceTo(stand) <= 1.9;
}

async function digCropPacket(bot, block) {
    bot._client.write('block_dig', {
        status: 0,
        location: block.position,
        face: 1
    });
    bot.swingArm();
    await movement.sleep(100);
    bot._client.write('block_dig', {
        status: 2,
        location: block.position,
        face: 1
    });
    const deadline = Date.now() + 2200;
    while (Date.now() < deadline) {
        if (bot.blockAt(block.position)?.name !== block.name) return;
        await movement.sleep(100);
    }
    console.log(`[FOOD] server did not confirm crop break ${block.position.toString()}`);
}

async function replantCrop(bot, position, seedName) {
    const seed = bot.inventory.items().find(item => item.name === seedName);
    const farmland = bot.blockAt(position.offset(0, -1, 0));
    if (!seed || farmland?.name !== 'farmland') return;
    try {
        await bot.equip(seed, 'hand');
        await movement.sleep(300);
        await bot.activateBlock(
            farmland,
            new Vec3(0, 1, 0),
            new Vec3(0.5, 1, 0.5)
        );
        await movement.sleep(300);
        if (bot.blockAt(position)?.name !== 'wheat') {
            console.log(`[FOOD] replant was not confirmed ${position.toString()}`);
        }
    } catch (error) {
        console.log(`[FOOD] replant skipped: ${error.message}`);
    }
}

async function prepareCollectedFood(bot) {
    const inventory = countInventory(bot);
    const breadCount = Math.floor((inventory.wheat || 0) / 3);
    if (breadCount > 0) {
        try {
            const table = findNearbyBlock(bot, 'crafting_table', 16);
            const shouldKeepHarvesting = nearestMatureCrop(bot) && (inventory.wheat || 0) < 24;
            if (!table && shouldKeepHarvesting) return;
            if (!table) await shelter.returnToBase(bot);
            await craft.craftItem(bot, 'bread', breadCount);
        } catch (error) {
            console.log(`[FOOD] bread preparation delayed: ${error.message}`);
        }
    }

    const refreshed = countInventory(bot);
    const rawName = Object.keys(RAW_TO_COOKED)
        .find(name => (refreshed[name] || 0) > 0);
    if (!rawName || !canCook(bot, refreshed)) return;

    const count = Math.min(8, refreshed[rawName]);
    try {
        console.log(`[FOOD] cooking ${rawName} x${count}`);
        await smelting.smeltItem(bot, rawName, RAW_TO_COOKED[rawName], count);
    } catch (error) {
        console.log(`[FOOD] cooking delayed: ${error.message}`);
    }
}

function canCook(bot, inventory) {
    const hasFurnace = (inventory.furnace || 0) > 0 ||
        Boolean(findNearbyBlock(bot, 'furnace', 16)) ||
        (inventory.cobblestone || 0) >= 8;
    const hasFuel = (inventory.coal || 0) > 0 ||
        (inventory.charcoal || 0) > 0 ||
        Object.entries(inventory).some(([name, count]) =>
            count > 0 && (name.endsWith('_log') || name.endsWith('_planks'))
        );
    return hasFurnace && hasFuel;
}

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!Number.isInteger(id)) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

async function collectNearbyDrops(bot) {
    for (let i = 0; i < 8; i++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(bot.entity.position) <= 8)
            .filter(entity => entity.position.y >= bot.entity.position.y - 1.5)
            .filter(entity => entity.position.y <= bot.entity.position.y + 3)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) {
            await movement.sleep(250);
            continue;
        }
        try {
            await movement.moveNear(bot, drop.position, 1, 4000);
        } catch {
            await movement.manualNudge?.(bot, 800);
        }
    }
}

async function searchForFood(bot, actionVersion = actionControl.snapshot(bot)) {
    const before = bot.entity.position.clone();
    let exploration = null;
    try {
        exploration = await movement.explore(bot, {
            target: 'food',
            isActive: () => actionControl.snapshot(bot) === actionVersion
        });
    } catch (error) {
        actionControl.assertActive(bot, actionVersion);
        console.log(`[FOOD] search movement delayed: ${error.message}`);
    }
    actionControl.assertActive(bot, actionVersion);
    if (exploration?.found) {
        failedSearches = 0;
        return {
            status: 'found',
            moved: bot.entity.position.distanceTo(before),
            found: true
        };
    }
    const unavailable = await markFailedSearch(bot);
    return {
        status: unavailable ? 'unavailable' : 'searched',
        moved: bot.entity.position.distanceTo(before),
        found: Boolean(exploration?.found)
    };
}

async function markFailedSearch(bot) {
    failedSearches++;
    console.log(`[FOOD] failed searches=${failedSearches}`);
    if (failedSearches >= 3) {
        foodUnavailableUntil = Date.now() + 5 * 60 * 1000;
        memory.setProgress('foodUnavailableUntil', foodUnavailableUntil);
        failedSearches = 0;
        console.log('[FOOD] no mob/crop found; delaying for 5 minutes.');
    }
    await movement.sleep(500);
    return isTemporarilyUnavailable();
}

function countInventory(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((total, item) => total + item.count, 0);
}

async function nudgeToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0, 0.5, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', true);
        await movement.sleep(900);
    } finally {
        bot.clearControlStates();
    }
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    eatBestFood,
    findFood,
    maintainFoodSupply,
    foodScore,
    foodCount,
    hasFoodStock,
    hasConvertibleFood,
    hasActionableConvertibleFood,
    isTemporarilyUnavailable,
    prepareCollectedFood
};
