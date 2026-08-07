const { Vec3 } = require('vec3');
const movement = require('./movement');
const memory = require('./memory');
const actionControl = require('./actionControl');

const DIRECTIONS = [
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, -1)
];
let directionIndex = 0;

async function collectStone(bot, count = 16) {
    const actionVersion = actionControl.snapshot(bot);
    await ensureSupportedStart(bot);
    const start = bot.entity.position.floored();
    memory.setSurfaceExit(start);
    const before = countItem(bot, 'cobblestone');
    const target = before + count;
    const shaft = [];
    const direction = DIRECTIONS[directionIndex++ % DIRECTIONS.length];
    let stuckSteps = 0;
    let noProgressMines = 0;

    console.log(`[STONE] target cobblestone=${target}, start=${start.toString()} direction=${direction.toString()}`);
    try {
        for (let step = 0; step < 32 && countItem(bot, 'cobblestone') < target; step++) {
            actionControl.assertActive(bot, actionVersion);
            const exposed = findReachableStone(bot);
            if (exposed && noProgressMines < 5) {
                const gained = await mineReachableStone(bot, exposed);
                if (gained) noProgressMines = 0;
                else noProgressMines++;
                continue;
            }

            const current = bot.entity.position.floored();
            const next = current.plus(direction).offset(0, -1, 0);
            shaft.push(current);
            await carveStep(bot, current, next);
            const moved = await stepTo(bot, next);
            if (moved < 0.5) stuckSteps++;
            else stuckSteps = 0;
            noProgressMines = 0;
            if (stuckSteps >= 3) {
                throw new Error(`Merdiven yonu tikandi: ${direction.toString()} ${describeStep(bot, next)}`);
            }
        }
    } finally {
        const wasCancelled = actionControl.snapshot(bot) !== actionVersion;
        if (wasCancelled) {
            movement.stop(bot);
            throw new Error(`Action cancelled: ${bot.sorimCancelReason || 'safety override'}`);
        }
        try {
            await movement.withTimeout(
                returnToSurface(bot, start, shaft),
                30000,
                'Stone return timed out'
            );
        } catch (error) {
            console.log(`[STONE] return skipped: ${error.message}`);
            movement.stop(bot);
        }
    }

    if (countItem(bot, 'cobblestone') <= before) {
        throw new Error('Safe staircase was opened but no cobblestone was collected');
    }
}

async function ensureSupportedStart(bot) {
    const current = bot.entity.position.floored();
    if (isSupportedStand(bot, current)) return;

    const stand = await findReachableSupportedStand(bot, current, 8);
    if (!stand) throw new Error(`No supported start for stone mining near ${current.toString()}`);

    console.log(`[STONE] moving to supported start ${stand.toString()}`);
}

async function findReachableSupportedStand(bot, origin, radius) {
    const candidates = findSupportedStands(bot, origin, radius);
    for (const stand of candidates) {
        if (await moveToSupportedStand(bot, stand)) return stand;
    }
    return null;
}

async function moveToSupportedStand(bot, stand) {
    try {
        await movement.moveBlock(bot, stand, 5000);
        return true;
    } catch {
        try {
            await movement.moveNear(bot, stand, 1, 3000);
            return true;
        } catch {
            await jumpToward(bot, stand);
            return bot.entity.position.distanceTo(stand.offset(0.5, 0, 0.5)) < 1.8;
        }
    }
}

function findSupportedStands(bot, origin, radius) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            for (let dy = 2; dy >= -4; dy--) {
                const position = origin.offset(dx, dy, dz);
                if (isSupportedStand(bot, position)) candidates.push(position);
            }
        }
    }
    return candidates
        .sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position));
}

function isSupportedStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) &&
        isAir(head) &&
        floor &&
        !isAir(floor) &&
        floor.boundingBox === 'block';
}

async function carveStep(bot, current, standAt) {
    const feet = standAt;
    const head = standAt.offset(0, 1, 0);
    const extraHead = standAt.offset(0, 2, 0);
    const currentHead = current.offset(0, 1, 0);
    const floor = standAt.offset(0, -1, 0);

    await digIfNeeded(bot, currentHead);
    await digIfNeeded(bot, extraHead);
    await digIfNeeded(bot, head);
    await digIfNeeded(bot, feet);

    const floorBlock = bot.blockAt(floor);
    if (!floorBlock || isAir(floorBlock) || floorBlock.boundingBox !== 'block') {
        throw new Error(`Stair step has no support: ${standAt.toString()} floor=${floorBlock?.name || 'unknown'}`);
    }
}

async function stepTo(bot, position) {
    const before = bot.entity.position.clone();
    try {
        await movement.moveBlock(bot, position, 7000);
    } catch {
        try {
            await movement.moveNear(bot, position, 1, 4000);
        } catch {
            await jumpToward(bot, position);
        }
    }

    const after = bot.entity.position;
    const moved =
        Math.abs(after.x - before.x) +
        Math.abs(after.y - before.y) +
        Math.abs(after.z - before.z);
    console.log(
        `[STONE] step target=${position.toString()} ` +
        `position=${after.floored().toString()} movement=${moved.toFixed(2)}`
    );
    return moved;
}

async function returnToSurface(bot, start, shaft) {
    console.log(`[STONE] returning upward ${start.toString()}`);
    for (const point of [...shaft].reverse()) {
        try {
            await movement.moveBlock(bot, point, 7000);
        } catch {
            try {
                await movement.moveNear(bot, point, 1, 5000);
            } catch {
                await jumpToward(bot, point);
            }
        }
    }
    try {
        await movement.moveNear(bot, start, 2, 10000);
    } catch {
        await jumpToward(bot, start);
    }

    const current = bot.entity.position.floored();
    const stillBelow = current.y < start.y - 1;
    const stillFar = current.distanceTo(start) > 4;
    if (!stillBelow && !stillFar) return;

    const surfaceStand = await findReachableSurfaceStand(bot, start, 10);
    if (surfaceStand) {
        console.log(`[STONE] recovered to surface stand ${surfaceStand.toString()}`);
        return;
    }

    console.log(`[STONE] surface recovery incomplete current=${current.toString()} start=${start.toString()}`);
}

async function findReachableSurfaceStand(bot, start, radius) {
    const candidates = findSupportedStands(bot, start, radius)
        .filter(position => position.y >= start.y)
        .sort((a, b) => a.distanceTo(start) - b.distanceTo(start));

    for (const stand of candidates) {
        if (await moveToSupportedStand(bot, stand)) return stand;
    }
    return null;
}

async function mineReachableStone(bot, block) {
    const before = countItem(bot, 'cobblestone');
    console.log(`[STONE] digging visible ${block.name} ${block.position.toString()}`);
    try {
        await movement.moveNear(bot, block.position, 3, 7000);
    } catch {
        await jumpToward(bot, block.position);
    }
    const current = bot.blockAt(block.position);
    if (!current || current.name !== 'stone') return false;
    if (!bot.canDigBlock(current)) return false;
    if (bot.entity.position.distanceTo(current.position.offset(0.5, 0.5, 0.5)) > 4.5) {
        return false;
    }
    try {
        await digBlock(bot, current);
    } catch (error) {
        console.log(`[STONE] skipped visible stone ${current.position.toString()}: ${error.message}`);
        return false;
    }
    await collectNearby(bot, 'cobblestone', before, current.position);
    console.log(`[STONE] cobblestone ${before} -> ${countItem(bot, 'cobblestone')}`);
    return countItem(bot, 'cobblestone') > before;
}

function findReachableStone(bot) {
    const ids = [bot.registry.blocksByName.stone?.id].filter(Boolean);
    const feet = bot.entity.position.floored();
    return bot.findBlocks({ matching: ids, maxDistance: 8, count: 32 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => hasOpenFace(bot, block.position))
        .filter(block => block.position.y >= feet.y)
        .filter(block => !isUnsafeFloorTarget(block.position, feet))
        .filter(block => block.position.distanceTo(bot.entity.position) <= 5)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function isUnsafeFloorTarget(position, feet) {
    const dx = Math.abs(position.x - feet.x);
    const dz = Math.abs(position.z - feet.z);
    if (position.y === feet.y - 1 && dx <= 1 && dz <= 1) return true;
    if (position.y > feet.y + 1) return true;
    return false;
}

async function digIfNeeded(bot, position) {
    const block = bot.blockAt(position);
    if (!block || isAir(block) || !bot.canDigBlock(block)) return;
    const before = countItem(bot, 'cobblestone');
    await digBlock(bot, block);
    if (block.name === 'stone' || block.name === 'cobblestone') {
        await collectNearby(bot, 'cobblestone', before, block.position);
    }
}

async function digBlock(bot, block) {
    await equipPickaxe(bot);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await digWithTimeout(bot, block);
    await movement.sleep(150);
}

async function digWithTimeout(bot, block) {
    let timer = null;
    const timeoutMs = digTimeoutMs(bot, block);
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try {
                bot.stopDigging();
            } catch {
                // Mineflayer may already have cleared the digging state.
            }
            reject(new Error(`Timed out digging ${block.name} ${block.position.toString()}`));
        }, timeoutMs);
    });

    try {
        await Promise.race([bot.dig(block), timeout]);
    } catch (error) {
        const current = bot.blockAt(block.position);
        if (!current || current.name !== block.name) return;
        if (await digWithProtocolFallback(bot, current)) return;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function digWithProtocolFallback(bot, block) {
    const duration = Math.max(250, Math.min(15000, Number(bot.digTime?.(block) || 1000) + 250));
    console.log(`[STONE] protocol dig fallback ${block.position.toString()} wait=${duration}`);
    bot._client.write('block_dig', { status: 0, location: block.position, face: 1 });
    bot.swingArm();
    await movement.sleep(duration);
    bot._client.write('block_dig', { status: 2, location: block.position, face: 1 });

    const deadline = Date.now() + 2500;
    while (Date.now() < deadline) {
        if (bot.blockAt(block.position)?.name !== block.name) return true;
        await movement.sleep(100);
    }
    return false;
}

function digTimeoutMs(bot, block) {
    const digTime = Number(bot.digTime?.(block) || 0);
    if (!Number.isFinite(digTime) || digTime <= 0) return 12000;
    return Math.max(12000, Math.min(25000, digTime + 8000));
}

async function collectNearby(bot, itemName, before, origin) {
    for (let i = 0; i < 10; i++) {
        if (countItem(bot, itemName) > before) return;
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= 6)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (drop) {
            try {
                await movement.moveBlock(bot, drop.position.floored(), 3000);
            } catch {
                await jumpToward(bot, drop.position);
            }
        } else {
            try {
                await movement.moveBlock(bot, origin, 2500);
            } catch {
                await jumpToward(bot, origin);
            }
        }
        await movement.sleep(350);
    }

    if (countItem(bot, itemName) <= before) {
        const dropStillNear = hasNearbyDrop(bot, origin, 6);
        if (dropStillNear) {
            await jumpToward(bot, origin);
            await movement.sleep(800);
        }
    }
}

function hasNearbyDrop(bot, origin, radius) {
    return Object.values(bot.entities || {})
        .some(entity => entity.name === 'item' && entity.position.distanceTo(origin) <= radius);
}

async function jumpToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0.5, 0.2, 0.5), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(1800);
    } finally {
        bot.clearControlStates();
    }
}

async function equipPickaxe(bot) {
    const tool = ['stone_pickaxe', 'wooden_pickaxe']
        .map(name => inventorySlots(bot).find(item => item.name === name))
        .find(Boolean);
    if (tool) await bot.equip(tool, 'hand');
}

function hasOpenFace(bot, position) {
    return [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0],
        [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ].some(([x, y, z]) => isAir(bot.blockAt(position.offset(x, y, z))));
}

function countItem(bot, itemName) {
    const slotCount = inventorySlots(bot)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

function inventorySlots(bot) {
    return bot.inventory.slots.filter(Boolean);
}

function describeStep(bot, position) {
    const feet = bot.blockAt(position)?.name || 'unknown';
    const head = bot.blockAt(position.offset(0, 1, 0))?.name || 'unknown';
    const floor = bot.blockAt(position.offset(0, -1, 0))?.name || 'unknown';
    const botPos = bot.entity.position.floored().toString();
    return `bot=${botPos} feet=${feet} head=${head} floor=${floor}`;
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    collectStone
};
