const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');

const FUEL_ITEMS = ['coal', 'charcoal', 'oak_log', 'birch_log', 'spruce_log', 'oak_planks', 'birch_planks'];

async function ensureFurnace(bot) {
    const nearby = findNearbyBlock(bot, 'furnace', 16);
    if (nearby) return nearby;

    if (countItem(bot, 'furnace') <= 0) {
        await craft.craftItem(bot, 'furnace', 1);
    }

    const item = bot.inventory.items().find(entry => entry.name === 'furnace');
    if (!item) throw new Error('Furnace yok');

    const placements = findFurnacePlacements(bot);
    for (const placement of placements.slice(0, 12)) {
        try {
            await movement.moveNear(bot, placement.target, 4, 8000);
            await bot.equip(item, 'hand');
            await bot.lookAt(placement.target.offset(0.5, 0.5, 0.5), true);
            await bot.placeBlock(placement.reference, placement.face);
            await movement.sleep(500);
            const placed = bot.blockAt(placement.target);
            if (placed?.name === 'furnace') return placed;
            const visible = findNearbyBlock(bot, 'furnace', 4);
            if (visible) return visible;
        } catch (error) {
            console.log(`[SMELT] furnace placement failed: ${error.message}`);
        }
    }

    throw new Error('Furnace yerlestirilemedi');
}

async function smeltItem(bot, inputName, outputName, count = 1) {
    const furnaceBlock = await ensureFurnace(bot);
    const input = bot.inventory.items().find(item => item.name === inputName);
    if (!input) throw new Error(`${inputName} yok`);

    await movement.moveNear(bot, furnaceBlock.position, 3, 10000);
    const furnace = await bot.openFurnace(furnaceBlock);
    try {
        await takeOutputIfPresent(furnace);
        await clearDifferentInput(furnace, inputName);
        await ensureInput(furnace, input, count);
        await ensureFuel(bot, furnace);
        await waitForOutput(bot, furnace, outputName, count);
    } finally {
        furnace.close();
    }
}

async function takeOutputIfPresent(furnace) {
    if (furnace.outputItem()) {
        await furnace.takeOutput();
    }
}

async function clearDifferentInput(furnace, inputName) {
    const current = furnace.inputItem();
    if (current && current.name !== inputName) {
        await furnace.takeInput();
    }
}

async function ensureInput(furnace, input, count) {
    const current = furnace.inputItem();
    if (current?.name === input.name && current.count >= count) return;
    const needed = Math.max(1, count - (current?.name === input.name ? current.count : 0));
    await furnace.putInput(input.type, null, Math.min(input.count, needed));
}

async function ensureFuel(bot, furnace) {
    if (furnace.fuelItem()) return;
    const fuel = FUEL_ITEMS
        .map(name => bot.inventory.items().find(item => item.name === name))
        .find(Boolean);
    if (!fuel) throw new Error('Eritme icin yakit yok');
    await furnace.putFuel(fuel.type, null, Math.min(fuel.count, fuel.name.endsWith('_log') ? 1 : fuel.count));
}

async function waitForOutput(bot, furnace, outputName, count) {
    let collected = 0;
    const deadline = Date.now() + Math.max(35000, 15000 + count * 14000);
    while (Date.now() < deadline) {
        const output = furnace.outputItem();
        if (output?.name === outputName) {
            const amount = Math.min(output.count, count - collected);
            await furnace.takeOutput();
            collected += amount;
            await movement.sleep(500);
            if (collected >= count) return;
        }
        await movement.sleep(700);
    }
    throw new Error(`${outputName} eritme tamamlanmadi (${collected}/${count})`);
}

function findFurnacePlacements(bot) {
    const origins = [];
    const base = memory.getBase();
    if (base) origins.push(new Vec3(base.x, base.y, base.z));
    origins.push(bot.entity.position.floored());

    const candidates = [];
    const seen = new Set();
    for (const origin of origins) {
        for (let dx = -5; dx <= 5; dx++) {
            for (let dz = -5; dz <= 5; dz++) {
                for (let dy = -1; dy <= 2; dy++) {
                    const target = origin.offset(dx, dy, dz);
                    const key = target.toString();
                    if (seen.has(key)) continue;
                    seen.add(key);
                    if (target.distanceTo(bot.entity.position) > 8) continue;
                    if (!isAir(bot.blockAt(target))) continue;
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

    return candidates.sort((a, b) => a.distance - b.distance);
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

function findNearbyBlock(bot, name, maxDistance) {
    const id = bot.registry.blocksByName[name]?.id;
    if (!id) return null;
    return bot.findBlock({ matching: id, maxDistance });
}

function countItem(bot, itemName) {
    const slotCount = bot.inventory.slots
        .filter(Boolean)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    ensureFurnace,
    smeltItem
};
