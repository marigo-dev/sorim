const { Vec3 } = require('vec3');

const movement = require('./movement');
const colonyMemory = require('./colonyMemory');

async function registerSharedStorage(position) {
    const target = toVec3(position);
    colonyMemory.setSharedStorage({
        position: vectorToObject(target),
        categories: ['building_blocks', 'food', 'tools', 'ores'],
        mode: 'survival_chest'
    });
    return target;
}

async function ensureSharedStorage(bot, position = null) {
    const target = position ? toVec3(position) : getSharedStoragePosition();
    if (!target) throw new Error('Shared storage position is not registered');

    let chestBlock = findChestNear(bot, target, 3);
    if (chestBlock && hasOpeningSpace(bot, chestBlock.position)) return chestBlock;

    await movement.moveNear(bot, target, 4, 12000);
    chestBlock = findChestNear(bot, target, 4);
    if (chestBlock && hasOpeningSpace(bot, chestBlock.position)) return chestBlock;

    const chestItem = bot.inventory.items().find(item => item.name === 'chest');
    if (!chestItem) throw new Error('Shared storage chest is missing and bot has no chest item');

    const placement = findChestPlacement(bot, target);
    if (!placement) throw new Error(`No shared chest placement near ${target.toString()}`);

    await movement.moveNear(bot, placement.target, 4, 12000);
    await bot.equip(chestItem, 'hand');
    await bot.lookAt(placement.target.offset(0.5, 0.5, 0.5), true);
    await placeBlockTolerant(bot, placement.reference, placement.face, placement.target, 'chest');
    await movement.sleep(700);

    chestBlock = bot.blockAt(placement.target);
    if (chestBlock?.name === 'chest' && hasOpeningSpace(bot, chestBlock.position)) {
        updateSharedStorageInventory(bot, {});
        console.log(`[SHARED] chest placed ${chestBlock.position.toString()}`);
        return chestBlock;
    }

    chestBlock = findChestNear(bot, target, 4);
    if (chestBlock && hasOpeningSpace(bot, chestBlock.position)) return chestBlock;
    throw new Error('Shared chest placement did not become usable');
}

async function depositToSharedStorage(bot, itemName, count = null) {
    const chestBlock = await ensureSharedStorage(bot);
    const item = bot.inventory.items().find(entry => entry.name === itemName);
    if (!item) throw new Error(`${itemName} not found in inventory`);
    const amount = Math.min(item.count, count ? Number(count) : item.count);
    if (amount <= 0) return 0;
    const beforeInventory = countInventoryItem(bot, itemName);

    const chest = await openSharedChest(bot, chestBlock);
    let closed = false;
    try {
        await chest.deposit(item.type, null, amount);
        await movement.sleep(300);
        syncPlayerInventoryFromWindow(bot, chest);
        await waitForInventoryAtMost(bot, itemName, Math.max(0, beforeInventory - amount), 4000);
        const inventory = await countSharedStorageFromChest(chest);
        updateSharedStorageInventory(bot, inventory);
        colonyMemory.addMessage({
            from: bot.username,
            to: 'colony',
            type: 'deposit',
            item: itemName,
            count: amount,
            text: `${bot.username} deposited ${amount} ${itemName}`
        });
        console.log(`[SHARED] ${bot.username} deposited ${itemName} x${amount}`);
        chest.close();
        closed = true;
        await movement.sleep(250);
        repairInventoryCount(bot, item, Math.max(0, beforeInventory - amount));
        return amount;
    } finally {
        if (!closed) chest.close();
    }
}

async function depositExcessToSharedStorage(bot, options = {}) {
    const keep = options.keep || {};
    const deposited = {};
    for (const item of [...bot.inventory.items()]) {
        const keepCount = keep[item.name] ?? 0;
        const amount = item.count - keepCount;
        if (amount <= 0) continue;
        deposited[item.name] = (deposited[item.name] || 0) +
            await depositToSharedStorage(bot, item.name, amount);
    }
    return deposited;
}

async function withdrawFromSharedStorage(bot, itemName, count) {
    const chestBlock = await ensureSharedStorage(bot);
    const item = bot.registry.itemsByName[itemName];
    if (!item) throw new Error(`Unknown item: ${itemName}`);
    const requested = Number(count || 1);
    if (requested <= 0) return 0;
    const memoryAvailable = getRememberedSharedCount(itemName);
    if (memoryAvailable > 0) {
        return withdrawByRebuildingChest(bot, chestBlock, itemName, Math.min(memoryAvailable, requested));
    }
    const beforeInventory = countInventoryItem(bot, itemName);

    const chest = await openSharedChest(bot, chestBlock);
    try {
        const available = chest.containerItems()
            .filter(entry => entry.name === itemName)
            .reduce((sum, entry) => sum + entry.count, 0);
        const amount = Math.min(available, requested);
        if (amount <= 0) throw new Error(`Shared storage has no ${itemName}`);
        await chest.withdraw(item.id, null, amount);
        await movement.sleep(300);
        syncPlayerInventoryFromWindow(bot, chest);
        await waitForInventoryCount(bot, itemName, beforeInventory + amount, 5000);
        const inventory = await countSharedStorageFromChest(chest);
        updateSharedStorageInventory(bot, inventory);
        colonyMemory.addMessage({
            from: bot.username,
            to: 'colony',
            type: 'withdraw',
            item: itemName,
            count: amount,
            text: `${bot.username} withdrew ${amount} ${itemName}`
        });
        console.log(`[SHARED] ${bot.username} withdrew ${itemName} x${amount}`);
        return amount;
    } finally {
        chest.close();
    }
}

async function withdrawByRebuildingChest(bot, chestBlock, itemName, amount) {
    const beforeItem = countInventoryItem(bot, itemName);
    const beforeChest = countInventoryItem(bot, 'chest');
    await breakSharedChest(bot, chestBlock);
    await collectDropsNear(bot, chestBlock.position, 8000);

    const afterItem = countInventoryItem(bot, itemName);
    const collected = Math.max(0, afterItem - beforeItem);
    const withdrawn = Math.min(amount, collected);
    if (withdrawn <= 0) throw new Error(`Could not collect ${itemName} from shared storage`);

    const chestCollected = countInventoryItem(bot, 'chest') > beforeChest;
    if (!chestCollected) throw new Error('Shared chest broke but chest item was not collected');

    const target = getSharedStoragePosition() || chestBlock.position;
    await ensureSharedStorage(bot, target);

    const extra = countInventoryItem(bot, itemName) - beforeItem - withdrawn;
    if (extra > 0) {
        await depositToSharedStorage(bot, itemName, extra);
    } else {
        updateSharedStorageInventory(bot, {
            ...colonyMemory.load().sharedStorage?.inventory,
            [itemName]: Math.max(0, getRememberedSharedCount(itemName) - withdrawn)
        });
    }

    colonyMemory.addMessage({
        from: bot.username,
        to: 'colony',
        type: 'withdraw',
        item: itemName,
        count: withdrawn,
        text: `${bot.username} withdrew ${withdrawn} ${itemName}`
    });
    console.log(`[SHARED] ${bot.username} rebuilt chest and withdrew ${itemName} x${withdrawn}`);
    return withdrawn;
}

async function breakSharedChest(bot, chestBlock) {
    await movement.moveNear(bot, chestBlock.position, 2, 12000);
    await bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
    const current = bot.blockAt(chestBlock.position);
    if (!current || current.name !== 'chest') throw new Error('Shared chest disappeared before withdraw');
    await bot.dig(current);
    await movement.sleep(500);
}

async function collectDropsNear(bot, origin, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= 8)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) {
            await movement.sleep(300);
            if (!Object.values(bot.entities || {}).some(entity =>
                entity.name === 'item' && entity.position.distanceTo(origin) <= 8
            )) break;
            continue;
        }
        try {
            await movement.moveNear(bot, drop.position, 1, 2500);
        } catch (error) {
            console.log(`[STORAGE] drop pickup path failed: ${error.message}`);
            break;
        }
        await movement.sleep(250);
    }
}

async function countSharedStorage(bot) {
    const chestBlock = await ensureSharedStorage(bot);
    const chest = await openSharedChest(bot, chestBlock);
    try {
        const inventory = await countSharedStorageFromChest(chest);
        updateSharedStorageInventory(bot, inventory);
        return inventory;
    } finally {
        chest.close();
    }
}

function getSharedStoragePosition() {
    const memory = colonyMemory.load();
    return memory.sharedStorage?.position ? toVec3(memory.sharedStorage.position) : null;
}

function getRememberedSharedCount(itemName) {
    const memory = colonyMemory.load();
    return Number(memory.sharedStorage?.inventory?.[itemName] || 0);
}

async function openSharedChest(bot, chestBlock) {
    const access = findChestAccessPosition(bot, chestBlock.position);
    if (access) {
        try {
            await movement.moveBlock(bot, access, 12000);
        } catch (error) {
            console.log(`[SHARED] exact chest access failed: ${error.message}`);
            await movement.moveNear(bot, chestBlock.position, 2, 12000);
        }
    } else {
        await movement.moveNear(bot, chestBlock.position, 2, 12000);
    }
    await bot.lookAt(chestBlock.position.offset(0.5, 0.5, 0.5), true);
    return bot.openChest(chestBlock);
}

async function countSharedStorageFromChest(chest) {
    const counts = {};
    for (const item of chest.containerItems()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

async function placeBlockTolerant(bot, reference, face, expectedPosition, expectedName) {
    try {
        await bot.placeBlock(reference, face);
    } catch (error) {
        if (!String(error.message || '').includes('blockUpdate')) throw error;
        await movement.sleep(700);
        const placed = bot.blockAt(expectedPosition);
        if (placed?.name === expectedName) return;
        throw error;
    }
}

function countInventoryItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

async function waitForInventoryCount(bot, itemName, expected, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const current = countInventoryItem(bot, itemName);
        if (current >= expected) return current;
        await movement.sleep(150);
    }
    const current = countInventoryItem(bot, itemName);
    console.log(`[SHARED] inventory sync delayed for ${itemName}: expected ${expected}, saw ${current}`);
    return current;
}

async function waitForInventoryAtMost(bot, itemName, expected, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const current = countInventoryItem(bot, itemName);
        if (current <= expected) return current;
        await movement.sleep(150);
    }
    const current = countInventoryItem(bot, itemName);
    console.log(`[SHARED] inventory sync delayed for ${itemName}: expected at most ${expected}, saw ${current}`);
    return current;
}

function syncPlayerInventoryFromWindow(bot, window) {
    const inventory = bot.inventory;
    if (!inventory || !window) return;

    for (let slot = window.inventoryStart; slot < window.inventoryEnd; slot += 1) {
        const item = window.slots[slot] || null;
        const inventorySlot = slot >= window.hotbarStart
            ? inventory.hotbarStart + (slot - window.hotbarStart)
            : inventory.inventoryStart + (slot - window.inventoryStart);
        if (inventorySlot >= 0 && inventorySlot < inventory.slots.length) {
            inventory.updateSlot(inventorySlot, item);
        }
    }
}

function repairInventoryCount(bot, originalItem, expectedCount) {
    if (expectedCount <= 0) return;
    const current = countInventoryItem(bot, originalItem.name);
    if (current >= expectedCount) return;
    const ItemClass = originalItem.constructor;
    const repaired = new ItemClass(
        originalItem.type,
        expectedCount - current,
        originalItem.metadata,
        originalItem.nbt
    );
    const slot = originalItem.slot >= 0 ? originalItem.slot : bot.inventory.firstEmptyInventorySlot();
    if (slot != null && slot >= 0) bot.inventory.updateSlot(slot, repaired);
}

function updateSharedStorageInventory(bot, inventory) {
    colonyMemory.setSharedStorage({
        inventory,
        lastAccessedBy: bot.username
    });
}

function findChestNear(bot, target, radius) {
    const id = bot.registry.blocksByName.chest?.id;
    if (!id) return null;
    return bot.findBlocks({ matching: id, maxDistance: radius, count: 16 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(chest => chest.position.distanceTo(target) <= radius)
        .sort((a, b) => a.position.distanceTo(target) - b.position.distanceTo(target))[0] || null;
}

function findChestPlacement(bot, target) {
    const candidates = [];
    for (let dy = 0; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
            for (let dz = -2; dz <= 2; dz++) {
                const position = target.offset(dx, dy, dz);
                if (isOccupiedByBot(bot, position)) continue;
                if (!isAir(bot.blockAt(position))) continue;
                if (!hasOpeningSpace(bot, position)) continue;
                const reference = findPlacementReference(bot, position);
                if (!reference) continue;
                candidates.push({
                    target: position,
                    reference: reference.block,
                    face: reference.face,
                    distance: position.distanceTo(target)
                });
            }
        }
    }
    return candidates.sort((a, b) => a.distance - b.distance)[0] || null;
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

function findChestAccessPosition(bot, chestPosition) {
    const options = [
        new Vec3(1, 0, 0),
        new Vec3(-1, 0, 0),
        new Vec3(0, 0, 1),
        new Vec3(0, 0, -1)
    ];
    const current = bot.entity.position.floored();
    return options
        .map(offset => chestPosition.plus(offset))
        .filter(position => isAir(bot.blockAt(position)) && isAir(bot.blockAt(position.offset(0, 1, 0))))
        .sort((a, b) => a.distanceTo(current) - b.distanceTo(current))[0] || null;
}

function isOccupiedByBot(bot, position) {
    const feet = bot.entity.position.floored();
    return position.equals(feet) || position.equals(feet.offset(0, 1, 0));
}

function hasOpeningSpace(bot, position) {
    return isAir(bot.blockAt(position.offset(0, 1, 0)));
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

function toVec3(value) {
    if (value instanceof Vec3) return value.floored();
    return new Vec3(Number(value.x), Number(value.y), Number(value.z)).floored();
}

function vectorToObject(vector) {
    return { x: vector.x, y: vector.y, z: vector.z };
}

module.exports = {
    registerSharedStorage,
    ensureSharedStorage,
    depositToSharedStorage,
    depositExcessToSharedStorage,
    withdrawFromSharedStorage,
    countSharedStorage,
    getSharedStoragePosition
};
