const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('./movement');
const memory = require('./memory');

async function craftItem(bot, itemName, count = 1) {
    const item = bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`Bilinmeyen item: ${itemName}`);

    let table = null;
    let recipe = bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe && itemName === 'crafting_table') {
        if (totalPlanks(bot) < 4) {
            const log = bot.inventory.items().find(entry => entry.name.endsWith('_log'));
            if (log) await craftItem(bot, log.name.replace(/_log$/, '_planks'), 4);
        }
        recipe = bot.recipesFor(item.id, null, 1, null)[0];
    }
    if (!recipe) {
        table = await ensureCraftingTable(bot);
        recipe = bot.recipesFor(item.id, null, 1, table)[0];
    }
    if (!recipe) throw new Error(`${itemName} icin tarif yok veya malzeme eksik`);

    const operations = Math.max(1, Math.ceil(count / recipe.result.count));
    console.log(`[CRAFT] ${itemName} x${count}`);
    for (let i = 0; i < operations; i++) {
        const before = countItem(bot, itemName);
        let currentRecipe = bot.recipesFor(item.id, null, 1, table)[0] ||
            bot.recipesFor(item.id, null, 1, null)[0];
        if (!currentRecipe) {
            throw new Error(`${itemName} icin tarif kayboldu veya malzeme yetmedi`);
        }
        try {
            await bot.craft(currentRecipe, 1, table);
            await waitForItemCount(bot, itemName, before + currentRecipe.result.count, 5000);
        } catch (error) {
            await movement.sleep(500);
            if (countItem(bot, itemName) > before) {
                console.log(`[CRAFT] ${itemName} timed out but inventory increased; continuing.`);
                continue;
            }
            if (isSlotTimeoutError(error) || isCraftVisibilityError(error)) {
                await retryCraftAfterVisibilityDelay(bot, item, itemName, before, table);
                continue;
            }
            if (!table || !isWindowOpenError(error)) throw error;
            console.log(`[CRAFT] crafting table was unusable, trying a fresh one: ${error.message}`);
            table = await placeFreshCraftingTable(bot);
            currentRecipe = bot.recipesFor(item.id, null, 1, table)[0];
            if (!currentRecipe) throw error;
            await bot.craft(currentRecipe, 1, table);
            await waitForItemCount(bot, itemName, before + currentRecipe.result.count, 5000);
        }
        await movement.sleep(250);
    }
}

async function retryCraftAfterVisibilityDelay(bot, item, itemName, before, table) {
    await movement.sleep(1000);
    if (countItem(bot, itemName) > before) return;

    const liveTable = table?.position ? bot.blockAt(table.position) : table;
    const recipe = bot.recipesFor(item.id, null, 1, liveTable)[0] ||
        bot.recipesFor(item.id, null, 1, null)[0];
    if (!recipe) throw new Error(`${itemName} retry recipe is unavailable`);

    try {
        await bot.craft(recipe, 1, liveTable);
        await waitForItemCount(bot, itemName, before + recipe.result.count, 7000);
    } catch (error) {
        await movement.sleep(750);
        if (countItem(bot, itemName) > before) return;
        throw new Error(`${itemName} was not confirmed after retry: ${error.message}`);
    }
}

async function placeBlock(bot, itemName) {
    const item = bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) throw new Error(`${itemName} envanterde yok`);

    const placements = findPlacements(bot);
    if (placements.length === 0) throw new Error(`No suitable place to put ${itemName}`);

    await bot.equip(item, 'hand');

    let lastError = null;
    for (const placement of placements.slice(0, 8)) {
        console.log(`[PLACE] ${itemName} target=${placement.target.toString()}`);
        try {
            await bot.lookAt(placement.target.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(placement.reference, placement.face);
            await movement.sleep(500);
            const direct = bot.blockAt(placement.target);
            if (direct?.name === itemName) {
                memory.rememberPlacedBlock(itemName);
                return direct;
            }
            const nearby = findNearbyBlock(bot, itemName, 4);
            if (nearby) {
                memory.rememberPlacedBlock(itemName);
                return nearby;
            }
            lastError = new Error(`${itemName} yerlestirildi ama blok gorunmedi`);
        } catch (error) {
            const direct = bot.blockAt(placement.target);
            const nearby = findNearbyBlock(bot, itemName, 4);
            if (direct?.name === itemName || nearby) {
                console.log(`[PLACE] ${itemName} event timed out but block is visible; continuing.`);
                memory.rememberPlacedBlock(itemName);
                return direct?.name === itemName ? direct : nearby;
            }
            lastError = error;
            console.log(`[PLACE] aday basarisiz: ${error.message}`);
        }
    }

    throw lastError || new Error(`Could not place ${itemName}`);
}

async function ensureCraftingTable(bot) {
    for (const nearby of findNearbyBlocks(bot, 'crafting_table', 16).slice(0, 8)) {
        if (blockReachDistance(bot, nearby) <= 4.5) return nearby;
        try {
            await movement.moveNear(bot, nearby.position, 4, 5000);
            if (blockReachDistance(bot, nearby) <= 4.5) return nearby;
        } catch (error) {
            console.log(`[CRAFT] nearby table is unreachable, trying a new one: ${error.message}`);
        }
    }

    const tableItem = bot.inventory.items().find(item => item.name === 'crafting_table');
    if (tableItem) {
        await placeBlock(bot, 'crafting_table');
        const placed = findNearbyBlock(bot, 'crafting_table', 16);
        if (placed) return placed;
    }

    if (totalPlanks(bot) < 4) {
        const log = bot.inventory.items().find(item => item.name.endsWith('_log'));
        if (log) {
            await craftItem(bot, log.name.replace(/_log$/, '_planks'), 4);
        }
    }

    if (totalPlanks(bot) >= 4) {
        await craftItem(bot, 'crafting_table', 1);
        await placeBlock(bot, 'crafting_table');
        const placed = findNearbyBlock(bot, 'crafting_table', 16);
        if (placed) return placed;
    }

    throw new Error('Crafting table yok');
}

function blockReachDistance(bot, block) {
    return bot.entity.position.offset(0, 1.65, 0)
        .distanceTo(block.position.offset(0.5, 0.5, 0.5));
}

async function placeFreshCraftingTable(bot) {
    if (!bot.inventory.items().some(item => item.name === 'crafting_table')) {
        const tableItem = bot.registry.itemsByName.crafting_table;
        const recipe = bot.recipesFor(tableItem.id, null, 1, null)[0];
        if (!recipe) throw new Error('Yeni crafting table icin tarif yok');
        await bot.craft(recipe, 1, null);
        await movement.sleep(250);
    }

    const placed = await placeBlock(bot, 'crafting_table');
    if (placed) {
        await movement.moveNear(bot, placed.position, 2, 6000);
        return placed;
    }

    const nearby = findNearbyBlock(bot, 'crafting_table', 8);
    if (nearby) return nearby;
    throw new Error('Could not place a fresh crafting table');
}

function isWindowOpenError(error) {
    const message = error?.message || '';
    return message.includes('windowOpen') || message.includes('Event windowOpen');
}

function isSlotTimeoutError(error) {
    const message = error?.message || '';
    return message.includes('updateSlot') || message.includes('Event updateSlot');
}

function isCraftVisibilityError(error) {
    const message = error?.message || '';
    return message.includes('craft sonucu envantere yansimadi');
}

function findNearbyBlock(bot, name, maxDistance) {
    return findNearbyBlocks(bot, name, maxDistance)[0] || null;
}

function findNearbyBlocks(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return [];
    return bot.findBlocks({ matching: id, maxDistance, count: 32 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        );
}

function totalPlanks(bot) {
    return inventorySlots(bot)
        .filter(item => item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
}

function countItem(bot, itemName) {
    const slotCount = inventorySlots(bot)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

async function waitForItemCount(bot, itemName, expected, timeoutMs) {
    const start = Date.now();
    let stableSince = null;
    while (Date.now() - start < timeoutMs) {
        if (countItem(bot, itemName) >= expected) {
            stableSince = stableSince || Date.now();
            if (Date.now() - stableSince >= 1200) return;
        } else {
            stableSince = null;
        }
        await movement.sleep(100);
    }
    throw new Error(`${itemName} craft sonucu envantere yansimadi`);
}

function inventorySlots(bot) {
    return bot.inventory.slots.filter(Boolean);
}

function findPlacements(bot) {
    const origin = bot.entity.position.floored();
    const candidates = [];
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                const target = origin.offset(dx, dy, dz);
                const horizontalDistance = Math.hypot(dx, dz);
                if (horizontalDistance < 0.8 || horizontalDistance > 4) continue;
                const targetBlock = bot.blockAt(target);
                if (!isAir(targetBlock)) continue;
                const reference = findPlacementReference(bot, target);
                if (reference) {
                candidates.push({
                    target,
                    reference: reference.block,
                    face: reference.face,
                    distance: target.distanceTo(origin)
                });
            }
        }
    }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    return candidates;
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

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    craftItem,
    placeBlock
};
