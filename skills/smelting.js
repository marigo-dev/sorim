const { Vec3 } = require('vec3');
const craft = require('./craft');
const movement = require('./movement');
const memory = require('./memory');
const actionControl = require('./actionControl');

const FUEL_ITEMS = [
    'coal',
    'charcoal',
    'oak_planks',
    'birch_planks',
    'spruce_planks',
    'oak_log',
    'birch_log',
    'spruce_log'
];

async function ensureFurnace(bot) {
    const nearby = findNearbyBlock(bot, 'furnace', 16);
    if (nearby) {
        memory.rememberPlacedBlock('furnace');
        return nearby;
    }

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
            if (placed?.name === 'furnace') {
                memory.rememberPlacedBlock('furnace');
                return placed;
            }
            const visible = findNearbyBlock(bot, 'furnace', 4);
            if (visible) {
                memory.rememberPlacedBlock('furnace');
                return visible;
            }
        } catch (error) {
            const direct = bot.blockAt(placement.target);
            const visible = findNearbyBlock(bot, 'furnace', 4);
            if (direct?.name === 'furnace' || visible) {
                const furnace = direct?.name === 'furnace' ? direct : visible;
                memory.rememberPlacedBlock('furnace');
                console.log(`[SMELT] furnace placement confirmed after timeout ${furnace.position.toString()}`);
                return furnace;
            }
            console.log(`[SMELT] furnace placement failed: ${error.message}`);
        }
    }

    throw new Error('Furnace yerlestirilemedi');
}

async function smeltItem(bot, inputName, outputName, count = 1) {
    const actionVersion = actionControl.snapshot(bot);
    const furnaceBlock = await ensureFurnace(bot);
    actionControl.assertActive(bot, actionVersion);

    const furnace = await openFurnaceSafely(bot, furnaceBlock);
    try {
        const pendingOutput = await takeOutputIfPresent(furnace);
        await movement.sleep(250);
        const input = bot.inventory.items().find(item => item.name === inputName);
        if (!input) {
            if (pendingOutput > 0) return;
            throw new Error(`${inputName} yok ve furnace output bos`);
        }
        await clearDifferentInput(furnace, inputName);
        await ensureInput(furnace, input, count);
        actionControl.assertActive(bot, actionVersion);
        await ensureFuel(bot, furnace);
        await waitForOutput(bot, furnace, outputName, count, actionVersion);
    } finally {
        furnace.close();
        await movement.sleep(750);
    }
}

async function openFurnaceSafely(bot, furnaceBlock) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await moveWithinFurnaceReach(bot, furnaceBlock, attempt);
            const distance = blockReachDistance(bot, furnaceBlock);
            console.log(
                `[SMELT] opening furnace attempt=${attempt + 1} distance=${distance.toFixed(2)} ` +
                `bot=${bot.entity.position.toString()} block=${furnaceBlock.position.toString()}`
            );
            await bot.lookAt(furnaceBlock.position.offset(0.5, 0.5, 0.5), true);
            return await bot.openFurnace(furnaceBlock);
        } catch (error) {
            lastError = error;
            movement.stop(bot);
            console.log(`[SMELT] furnace open attempt ${attempt + 1} failed: ${error.message}`);
        }
    }
    throw lastError || new Error('Furnace acilamadi');
}

async function moveWithinFurnaceReach(bot, furnaceBlock, attempt) {
    if (blockReachDistance(bot, furnaceBlock) <= 4.3) return;
    console.log(
        `[SMELT] approaching furnace bot=${bot.entity.position.floored().toString()} ` +
        `block=${furnaceBlock.position.toString()}`
    );
    const stands = furnaceStandPositions(bot, furnaceBlock.position);
    const target = stands[Math.min(attempt, stands.length - 1)];
    if (target) {
        try {
            await movement.moveBlock(bot, target, 7000);
        } catch {
            movement.stop(bot);
            await approachFurnaceDirectly(bot, furnaceBlock);
        }
    } else {
        try {
            await movement.moveNear(bot, furnaceBlock.position, 2, 8000);
        } catch {
            movement.stop(bot);
            await approachFurnaceDirectly(bot, furnaceBlock);
        }
    }
    if (blockReachDistance(bot, furnaceBlock) > 4.5) {
        throw new Error(`Furnace interaction out of reach (${blockReachDistance(bot, furnaceBlock).toFixed(2)})`);
    }
}

async function approachFurnaceDirectly(bot, furnaceBlock) {
    for (let step = 0; step < 6 && blockReachDistance(bot, furnaceBlock) > 4.3; step++) {
        await bot.lookAt(furnaceBlock.position.offset(0.5, 0.8, 0.5), true);
        await movement.manualNudge(bot, 900);
    }
}

function furnaceStandPositions(bot, position) {
    return [
        position.offset(1, 0, 0),
        position.offset(-1, 0, 0),
        position.offset(0, 0, 1),
        position.offset(0, 0, -1)
    ].filter(stand => {
        const feet = bot.blockAt(stand);
        const head = bot.blockAt(stand.offset(0, 1, 0));
        const floor = bot.blockAt(stand.offset(0, -1, 0));
        return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
    }).sort((left, right) =>
        left.distanceTo(bot.entity.position) - right.distanceTo(bot.entity.position)
    );
}

function blockReachDistance(bot, block) {
    return bot.entity.position.offset(0, 1.65, 0)
        .distanceTo(block.position.offset(0.5, 0.5, 0.5));
}

async function takeOutputIfPresent(furnace) {
    const output = furnace.outputItem();
    if (output) {
        await furnace.takeOutput();
        return output.count;
    }
    return 0;
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
    await furnace.putFuel(fuel.type, null, fuel.count);
}

async function waitForOutput(bot, furnace, outputName, count, actionVersion) {
    let collected = 0;
    const deadline = Date.now() + Math.max(35000, 15000 + count * 14000);
    while (Date.now() < deadline) {
        actionControl.assertActive(bot, actionVersion);
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
