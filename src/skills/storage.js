const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');
const shelter = require('./shelter');

const NEVER_DEPOSIT = new Set([
    'stone_pickaxe',
    'stone_axe',
    'stone_sword',
    'iron_pickaxe',
    'iron_axe',
    'iron_sword',
    'iron_helmet',
    'iron_chestplate',
    'iron_leggings',
    'iron_boots',
    'shield',
    'wooden_pickaxe'
]);

const FOOD_ITEMS = new Set([
    'bread',
    'cooked_beef',
    'cooked_porkchop',
    'cooked_mutton',
    'cooked_chicken',
    'cooked_cod',
    'cooked_salmon',
    'beef',
    'porkchop',
    'mutton',
    'chicken',
    'cod',
    'salmon',
    'apple',
    'carrot',
    'baked_potato',
    'potato'
]);

const LOG_TO_PLANKS = {
    oak_log: 'oak_planks',
    birch_log: 'birch_planks',
    spruce_log: 'spruce_planks',
    jungle_log: 'jungle_planks',
    acacia_log: 'acacia_planks',
    dark_oak_log: 'dark_oak_planks',
    cherry_log: 'cherry_planks',
    mangrove_log: 'mangrove_planks',
    pale_oak_log: 'pale_oak_planks'
};

let storageRetryAfter = 0;

async function organizeStorage(bot) {
    await shelter.ensureBaseEgress(bot);
    const atBase = await returnNearBase(bot);
    if (!atBase) {
        storageRetryAfter = Date.now() + 30000;
        throw new Error('Storage deferred until the bot can return to base');
    }
    const chestBlock = await ensureChest(bot);
    if (!chestBlock) throw new Error('Could not place chest');

    try {
        await movement.moveNear(bot, chestBlock.position, 3, 10000);
    } catch (error) {
        console.log(`[STORAGE] could not walk to chest: ${error.message}`);
    }
    const chest = await openUsableChest(bot, chestBlock);
    if (!chest) {
        console.log('[STORAGE] chest exists but could not be opened; leaving it for a later loop.');
        storageRetryAfter = Date.now() + 60000;
        return { deposited: {}, chestPosition: vector(chestBlock.position), opened: false };
    }
    const deposited = {};
    try {
        for (const item of bot.inventory.items()) {
            if (shouldKeep(item)) continue;
            const keepCount = keepCountFor(item.name);
            const excess = item.count - keepCount;
            if (excess <= 0) continue;
            console.log(`[STORAGE] depositing ${item.name} x${excess}`);
            await chest.deposit(item.type, null, excess);
            deposited[item.name] = (deposited[item.name] || 0) + excess;
            await movement.sleep(150);
        }
    } finally {
        chest.close();
    }
    return { deposited, chestPosition: vector(chestBlock.position), opened: true };
}

async function returnNearBase(bot) {
    const base = memory.getBase();
    if (!base) return false;
    const target = new Vec3(base.x, base.y, base.z);
    if (bot.entity.position.distanceTo(target) <= 5) return true;
    try {
        console.log(`[STORAGE] returning to base ${target.toString()}`);
        await shelter.returnToBase(bot);
    } catch (error) {
        console.log(`[STORAGE] could not return to base: ${error.message}`);
    }
    return bot.entity.position.distanceTo(target) <= 7;
}

async function ensureChest(bot) {
    const nearby = await findReachableChest(bot, 16);
    if (nearby) return nearby;

    if (countItem(bot, 'chest') <= 0) {
        await ensurePlanks(bot, 8);
        await craft.craftItem(bot, 'chest', 1);
    }

    const placed = await placeChest(bot);
    if (placed) return placed;

    return findNearbyBlock(bot, 'chest', 16);
}

async function ensurePlanks(bot, minimum) {
    while (totalPlanks(bot) < minimum) {
        const log = Object.keys(LOG_TO_PLANKS)
            .find(name => countItem(bot, name) > 0);
        if (!log) break;
        await craft.craftItem(bot, LOG_TO_PLANKS[log], 4);
    }
}

async function findReachableChest(bot, maxDistance) {
    const chests = findNearbyBlocks(bot, 'chest', maxDistance);
    for (const chest of chests) {
        if (isBaseEntrance(chest.position)) continue;
        if (!hasOpeningSpace(bot, chest.position)) continue;
        try {
            await movement.moveNear(bot, chest.position, 3, 5000);
            return chest;
        } catch (error) {
            console.log(`[STORAGE] nearby chest is unreachable: ${error.message}`);
        }
    }
    return null;
}

async function placeChest(bot) {
    const item = bot.inventory.items().find(entry => entry.name === 'chest');
    if (!item) return null;

    const placements = findChestPlacements(bot);
    if (placements.length === 0) return null;

    await bot.equip(item, 'hand');

    for (const placement of placements.slice(0, 20)) {
        console.log(`[STORAGE] trying chest target=${placement.target.toString()}`);
        try {
            await movement.moveNear(bot, placement.target, 4, 8000);
            await clearOpeningSpace(bot, placement.target);
            await bot.lookAt(placement.target.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(placement.reference, placement.face);
            await movement.sleep(700);

            const direct = bot.blockAt(placement.target);
            if (direct?.name === 'chest' && hasOpeningSpace(bot, direct.position)) return direct;

            const nearby = findNearbyBlock(bot, 'chest', 4);
            if (nearby && hasOpeningSpace(bot, nearby.position)) return nearby;
        } catch (error) {
            console.log(`[STORAGE] chest candidate failed: ${error.message}`);
        }
    }

    return null;
}

function shouldKeep(item) {
    const name = typeof item === 'string' ? item : item.name;
    return NEVER_DEPOSIT.has(name);
}

function hasDepositableItems(inventory) {
    return Object.entries(inventory).some(([name, count]) =>
        !shouldKeep(name) && count > keepCountFor(name)
    );
}

function keepCountFor(itemName) {
    if (FOOD_ITEMS.has(itemName)) return 16;
    if (itemName === 'wheat') return 48;
    if (itemName === 'wheat_seeds') return 32;
    if (itemName === 'cobblestone' || itemName === 'dirt') return 32;
    if (itemName.endsWith('_planks')) return 16;
    if (itemName.endsWith('_log')) return 4;
    if (itemName.endsWith('_sapling')) return 4;
    if (itemName.endsWith('_wool')) return 3;
    if (itemName === 'torch' || itemName === 'coal' || itemName === 'charcoal') return 16;
    if (itemName === 'iron_ingot') return 8;
    if (itemName === 'raw_iron') return 0;
    if (['crafting_table', 'furnace', 'chest'].includes(itemName)) return 1;
    return 1;
}

function hasChestNearby(bot) {
    return findNearbyBlocks(bot, 'chest', 16)
        .some(chest => !isBaseEntrance(chest.position) && hasOpeningSpace(bot, chest.position));
}

function isTemporarilyUnavailable() {
    return Date.now() < storageRetryAfter;
}

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

function findNearbyBlocks(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return [];
    return bot.findBlocks({ matching: id, maxDistance, count: 8 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

function findChestPlacements(bot) {
    const origins = [];
    const base = memory.getBase();
    if (base) origins.push(new Vec3(base.x, base.y, base.z));
    origins.push(bot.entity.position.floored());

    const seen = new Set();
    const candidates = [];
    for (const origin of origins) {
        for (let dy = -2; dy <= 3; dy++) {
            for (let dx = -7; dx <= 7; dx++) {
                for (let dz = -7; dz <= 7; dz++) {
                    const target = origin.offset(dx, dy, dz);
                    const key = target.toString();
                    if (seen.has(key)) continue;
                    seen.add(key);

                    const horizontalDistance = Math.hypot(
                        target.x - bot.entity.position.x,
                        target.z - bot.entity.position.z
                    );
                    if (horizontalDistance < 0.9 || horizontalDistance > 8) continue;
                    if (isBaseEntrance(target)) continue;
                    if (isInsideBaseFootprint(target)) continue;
                    if (wouldCollideWithBot(bot, target)) continue;
                    if (!isAir(bot.blockAt(target))) continue;
                    if (!hasOpeningSpace(bot, target) && !canClearOpeningSpace(bot, target)) continue;

                    const reference = findPlacementReference(bot, target);
                    if (!reference) continue;

                    candidates.push({
                        target,
                        reference: reference.block,
                        face: reference.face,
                        distance: target.distanceTo(bot.entity.position)
                    });
                }
            }
        }
    }

    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
}

function isInsideBaseFootprint(position) {
    const base = memory.getBase();
    if (!base) return false;
    return Math.abs(position.x - base.x) <= 1 &&
        Math.abs(position.z - base.z) <= 1 &&
        position.y >= base.y - 1 && position.y <= base.y + 2;
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
        if (block?.boundingBox === 'block') {
            return { block, face: option.face };
        }
    }
    return null;
}

function wouldCollideWithBot(bot, target) {
    const botFeet = bot.entity.position.floored();
    return target.equals(botFeet) || target.equals(botFeet.offset(0, 1, 0));
}

function isBaseEntrance(position) {
    const base = memory.getBase();
    if (!base) return false;
    return position.x === base.x &&
        position.z === base.z - 1 &&
        (position.y === base.y || position.y === base.y + 1);
}

async function openUsableChest(bot, chestBlock) {
    if (!hasOpeningSpace(bot, chestBlock.position)) return null;

    try {
        await bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
        return await bot.openChest(chestBlock);
    } catch (error) {
        console.log(`[STORAGE] could not open chest: ${error.message}`);
        return null;
    }
}

function hasOpeningSpace(bot, position) {
    return isAir(bot.blockAt(position.offset(0, 1, 0)));
}

function canClearOpeningSpace(bot, position) {
    const top = bot.blockAt(position.offset(0, 1, 0));
    return Boolean(top && !isAir(top) && bot.canDigBlock(top));
}

async function clearOpeningSpace(bot, position) {
    const top = bot.blockAt(position.offset(0, 1, 0));
    if (!top || isAir(top)) return;
    if (!bot.canDigBlock(top)) throw new Error(`Cannot clear chest top: ${top.name}`);
    await bot.lookAt(top.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(top);
    await movement.sleep(250);
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

function totalPlanks(bot) {
    return bot.inventory.items()
        .filter(item => item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function deposableInventory(inventory) {
    return Object.fromEntries(Object.entries(inventory || {}).filter(([name, count]) =>
        !shouldKeep(name) && Number(count) > keepCountFor(name)
    ).map(([name, count]) => [name, Number(count) - keepCountFor(name)]));
}

function vector(position) {
    return position ? { x: position.x, y: position.y, z: position.z } : null;
}

module.exports = {
    organizeStorage,
    hasChestNearby,
    isTemporarilyUnavailable,
    hasDepositableItems,
    deposableInventory
};
