const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('./movement');

async function craftItem(bot, itemName, count = 1) {
    const item = bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`Bilinmeyen item: ${itemName}`);

    let table = null;
    let recipe = bot.recipesFor(item.id, null, 1, null)[0];
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
        if (!currentRecipe) break;
        try {
            await bot.craft(currentRecipe, 1, table);
        } catch (error) {
            await movement.sleep(500);
            if (countItem(bot, itemName) > before) {
                console.log(`[CRAFT] ${itemName} timed out but inventory increased; continuing.`);
                continue;
            }
            if (isSlotTimeoutError(error)) {
                console.log(`[CRAFT] ${itemName} slot timeout; retrying shortly.`);
                await movement.sleep(700);
                if (countItem(bot, itemName) > before) continue;
                try {
                    await bot.craft(currentRecipe, 1, table);
                } catch (retryError) {
                    await movement.sleep(700);
                    if (countItem(bot, itemName) > before) {
                        console.log(`[CRAFT] ${itemName} retry timed out but inventory increased; continuing.`);
                        continue;
                    }
                    throw retryError;
                }
                continue;
            }
            if (!table || !isWindowOpenError(error)) throw error;
            console.log(`[CRAFT] crafting table was unusable, trying a fresh one: ${error.message}`);
            table = await placeFreshCraftingTable(bot);
            currentRecipe = bot.recipesFor(item.id, null, 1, table)[0];
            if (!currentRecipe) throw error;
            await bot.craft(currentRecipe, 1, table);
        }
        await movement.sleep(250);
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
            if (direct?.name === itemName) return direct;
            const nearby = findNearbyBlock(bot, itemName, 4);
            if (nearby) return nearby;
            lastError = new Error(`${itemName} yerlestirildi ama blok gorunmedi`);
        } catch (error) {
            const direct = bot.blockAt(placement.target);
            const nearby = findNearbyBlock(bot, itemName, 4);
            if (direct?.name === itemName || nearby) {
                console.log(`[PLACE] ${itemName} event timed out but block is visible; continuing.`);
                return;
            }
            lastError = error;
            console.log(`[PLACE] aday basarisiz: ${error.message}`);
        }
    }

    throw lastError || new Error(`Could not place ${itemName}`);
}

async function ensureCraftingTable(bot) {
    const nearby = findNearbyBlock(bot, 'crafting_table', 16);
    if (nearby) {
        try {
            await movement.moveNear(bot, nearby.position, 3, 6000);
            return nearby;
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

    if (totalPlanks(bot) >= 4) {
        await craftItem(bot, 'crafting_table', 1);
        await placeBlock(bot, 'crafting_table');
        const placed = findNearbyBlock(bot, 'crafting_table', 16);
        if (placed) return placed;
    }

    throw new Error('Crafting table yok');
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

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

function totalPlanks(bot) {
    return bot.inventory.items()
        .filter(item => item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
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
