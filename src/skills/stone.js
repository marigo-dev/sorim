const { Vec3 } = require('vec3');
const movement = require('./movement');
const miningTools = require('./miningTools');
const mine = require('./mine');
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
    await descendFromCanopy(bot, actionVersion);
    await ensureSupportedStart(bot);
    await ensureOutsideBaseForMining(bot);
    const start = bot.entity.position.floored();
    const rememberedExit = memory.getSurfaceExit();
    const rememberedRoute = memory.getMineRoute();
    if (!rememberedExit || start.y > rememberedExit.y) memory.setSurfaceExit(start);
    const before = countItem(bot, 'cobblestone');
    const target = before + count;
    const shaft = [];
    const previousTail = rememberedRoute[rememberedRoute.length - 1];
    const joinsPreviousRoute = previousTail &&
        new Vec3(previousTail.x, previousTail.y, previousTail.z).distanceTo(start) <= 1.75;
    if (!joinsPreviousRoute) memory.setMineRoute([start]);
    const direction = selectStaircaseDirection(bot, start);
    let cursor = start;
    let stuckSteps = 0;
    let noProgressMines = 0;
    const previousMaxDropDown = movement.setMaxDropDown(bot, 2);

    console.log(`[STONE] target cobblestone=${target}, start=${start.toString()} direction=${direction.toString()}`);
    try {
        for (let step = 0; step < 32 && countItem(bot, 'cobblestone') < target; step++) {
            actionControl.assertActive(bot, actionVersion);
            const exposed = findReachableStone(bot, cursor);
            if (exposed && noProgressMines < 5) {
                const gained = await mineReachableStone(bot, exposed);
                if (gained) noProgressMines = 0;
                else noProgressMines++;
                continue;
            }

            if (!reachedStand(bot.entity.position, cursor)) {
                console.log(`[STONE] realigning with staircase tail ${cursor.toString()}`);
                const descended = await finishSafeDescent(bot, cursor);
                if (!descended) {
                    await movement.moveBlock(bot, cursor, 6000).catch(async () => {
                        await movement.moveNear(bot, cursor, 1, 3500);
                    });
                }
                if (!reachedStand(bot.entity.position, cursor)) {
                    throw new Error(`Could not realign with staircase tail ${cursor.toString()}`);
                }
            }

            const next = cursor.plus(direction).offset(0, -1, 0);
            await carveStep(bot, cursor, next);
            const moved = await stepTo(bot, next);
            if (moved < 0.5) {
                stuckSteps++;
                try {
                    await movement.moveBlock(bot, cursor, 4000);
                } catch {
                    throw new Error(`Lost planned staircase at ${cursor.toString()}`);
                }
            } else {
                shaft.push(cursor);
                cursor = next;
                memory.appendMineRoute(cursor);
                stuckSteps = 0;
            }
            noProgressMines = 0;
            if (stuckSteps >= 3) {
                throw new Error(`Merdiven yonu tikandi: ${direction.toString()} ${describeStep(bot, next)}`);
            }
        }

        if (bot.entity.position.distanceTo(cursor.offset(0.5, 0, 0.5)) > 1.25) {
            console.log(`[STONE] returning to staircase tail ${cursor.toString()}`);
            await movement.moveBlock(bot, cursor, 6000);
        }
    } finally {
        const wasCancelled = actionControl.snapshot(bot) !== actionVersion;
        movement.stop(bot);
        movement.restoreMaxDropDown(bot, previousMaxDropDown);
        if (wasCancelled) {
            throw new Error(`Action cancelled: ${bot.sorimCancelReason || 'safety override'}`);
        }
        console.log(`[STONE] collection complete; survival layer owns surface recovery from ${start.toString()}`);
    }

    if (countItem(bot, 'cobblestone') <= before) {
        throw new Error('Safe staircase was opened but no cobblestone was collected');
    }
    const newRoute = [...shaft, cursor];
    memory.setMineRoute(
        joinsPreviousRoute
            ? [...rememberedRoute, ...newRoute.slice(1)]
            : newRoute
    );
}

async function ensureOutsideBaseForMining(bot) {
    const remembered = memory.getBase();
    if (!remembered) return;

    const base = new Vec3(remembered.x, remembered.y, remembered.z);
    if (horizontalDistance(bot.entity.position, base.offset(0.5, 0, 0.5)) > 5) return;

    const candidates = findSupportedStands(bot, base, 11)
        .filter(position => {
            const distance = horizontalDistance(position.offset(0.5, 0, 0.5), base.offset(0.5, 0, 0.5));
            return distance >= 6 && distance <= 10 && hasStaircaseDirection(bot, position);
        });
    for (const candidate of candidates) {
        if (await moveToSupportedStand(bot, candidate)) {
            console.log(`[STONE] moved mining start outside base to ${candidate.toString()}`);
            return;
        }
    }
    throw new Error(`No supported mining start outside base ${base.toString()}`);
}

function selectStaircaseDirection(bot, start) {
    const ordered = DIRECTIONS.map((_, offset) =>
        DIRECTIONS[(directionIndex + offset) % DIRECTIONS.length]
    );
    directionIndex = (directionIndex + 1) % DIRECTIONS.length;
    return ordered.find(direction => isViableFirstStep(bot, start, direction)) || ordered[0];
}

function hasStaircaseDirection(bot, start) {
    return DIRECTIONS.some(direction => isViableFirstStep(bot, start, direction));
}

function isViableFirstStep(bot, start, direction) {
    const standAt = start.plus(direction).offset(0, -1, 0);
    const floor = bot.blockAt(standAt.offset(0, -1, 0));
    return Boolean(floor && !isAir(floor) && floor.boundingBox === 'block');
}

async function descendFromCanopy(bot, actionVersion) {
    const current = bot.entity.position.floored();
    const currentFloor = bot.blockAt(current.offset(0, -1, 0));
    if (!isTreeSupport(currentFloor)) return;

    const descended = await movement.descendFromCanopy(
        bot,
        28,
        () => actionControl.snapshot(bot) === actionVersion
    );
    actionControl.assertActive(bot, actionVersion);
    if (descended) return;

    const stand = await findReachableSupportedStand(bot, current, 8);
    if (stand) {
        console.log(`[STONE] left unsupported canopy toward ${stand.toString()}`);
        return;
    }
    throw new Error(`No safe canopy exit near ${current.toString()}`);
}

function findSafeCanopyColumn(bot, origin, radius) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dz = -radius; dz <= radius; dz++) {
            const stand = origin.offset(dx, 0, dz);
            if (!isAir(bot.blockAt(stand)) || !isAir(bot.blockAt(stand.offset(0, 1, 0)))) continue;
            let foundGround = false;
            let continuous = true;
            for (let depth = 1; depth <= 10; depth++) {
                const block = bot.blockAt(stand.offset(0, -depth, 0));
                if (!block || block.boundingBox !== 'block') {
                    continuous = false;
                    break;
                }
                if (!isTreeSupport(block)) {
                    foundGround = true;
                    break;
                }
            }
            if (continuous && foundGround) candidates.push(stand);
        }
    }
    return candidates.sort((left, right) =>
        horizontalDistance(bot.entity.position, left) -
        horizontalDistance(bot.entity.position, right)
    )[0] || null;
}

function isTreeSupport(block) {
    return Boolean(
        block?.name?.endsWith('_leaves') ||
        block?.name?.endsWith('_log') ||
        block?.name === 'pale_hanging_moss'
    );
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - (right.x + 0.5), left.z - (right.z + 0.5));
}

async function ensureSupportedStart(bot) {
    const current = bot.entity.position.floored();
    if (isSupportedStand(bot, current)) return;

    const stand = await findReachableSupportedStand(bot, current, 8);
    if (!stand) throw new Error(`No supported start for stone mining near ${current.toString()}`);

    console.log(`[STONE] moving to supported start ${stand.toString()}`);
}

async function findReachableSupportedStand(bot, origin, radius) {
    const candidates = findSupportedStands(bot, origin, radius).slice(0, 8);
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
        } catch (error) {
            console.log(`[STONE] supported stand path failed ${stand.toString()}: ${error.message}`);
            return false;
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

    for (const position of [feet, head]) {
        const block = bot.blockAt(position);
        if (isLiquid(block)) {
            throw new Error(`Staircase blocked by ${block.name} at ${position.toString()}`);
        }
    }

    const floorBlock = bot.blockAt(floor);
    if (!floorBlock || isAir(floorBlock) || floorBlock.boundingBox !== 'block') {
        throw new Error(`Stair step has no support: ${standAt.toString()} floor=${floorBlock?.name || 'unknown'}`);
    }
}

async function stepTo(bot, position) {
    try {
        await movement.moveBlock(bot, position, 7000);
    } catch (error) {
        try {
            await movement.moveNear(bot, position, 1, 4000);
        } catch (fallbackError) {
            throw new Error(`Pathfinder could not reach staircase step: ${fallbackError.message}`);
        }
    }
    if (!reachedStand(bot.entity.position, position)) {
        throw new Error(`Pathfinder stopped before staircase step ${position.toString()}`);
    }
    return true;
}

function reachedStand(actual, expected) {
    return Math.abs(actual.x - (expected.x + 0.5)) <= 0.8 &&
        Math.abs(actual.z - (expected.z + 0.5)) <= 0.8 &&
        Math.abs(actual.y - expected.y) <= 0.25;
}

async function returnToSurface(bot, start, shaft, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    console.log(`[STONE] returning upward ${start.toString()}`);
    for (const point of [...shaft].reverse()) {
        if (Date.now() >= deadline) break;
        try {
            await movement.moveBlock(bot, point, Math.min(5000, deadline - Date.now()));
        } catch (error) {
            console.log(`[STONE] route point path failed: ${error.message}`);
            break;
        }
    }
    if (Date.now() < deadline) {
        try {
            await movement.moveNear(bot, start, 2, Math.min(7000, deadline - Date.now()));
        } catch (error) {
            console.log(`[STONE] surface path failed: ${error.message}`);
        }
    }
    movement.stop(bot);

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

function findReachableStone(bot, cursor) {
    const ids = [bot.registry.blocksByName.stone?.id].filter(Boolean);
    const feet = bot.entity.position.floored();
    return bot.findBlocks({ matching: ids, maxDistance: 8, count: 32 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => hasOpenFace(bot, block.position))
        .filter(block => block.position.y >= feet.y)
        .filter(block => !isUnsafeFloorTarget(block.position, feet))
        .filter(block => block.position.distanceTo(bot.entity.position) <= 2.5)
        .filter(block => !cursor || block.position.distanceTo(cursor) <= 2.25)
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
    if (!block || isAir(block) || isLiquid(block) || !bot.canDigBlock(block)) return;
    const before = countItem(bot, 'cobblestone');
    await digBlock(bot, block);
    if (block.name === 'stone' || block.name === 'cobblestone') {
        await collectNearby(bot, 'cobblestone', before, block.position);
    }
}

async function digBlock(bot, block) {
    const position = block.position.clone();
    const maxAttempts = isFallingBlock(block.name) ? 16 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const current = bot.blockAt(position);
        if (!current || isAir(current)) return;
        if (attempt > 0 && !isFallingBlock(current.name)) return;

        await equipToolForBlock(bot, current);
        await bot.lookAt(position.offset(0.5, 0.5, 0.5), true);
        await digWithTimeout(bot, current);
        await movement.sleep(isFallingBlock(current.name) ? 350 : 500);

        const replacement = bot.blockAt(position);
        if (!replacement || isAir(replacement) || replacement.name !== current.name) return;
        if (!isFallingBlock(current.name)) {
            throw new Error(`Block remained after digging ${current.name} ${position.toString()}`);
        }
        console.log(
            `[STONE] clearing fallen ${replacement.name} ${position.toString()} ` +
            `layer=${attempt + 2}`
        );
    }
    throw new Error(`Falling block column did not clear at ${position.toString()}`);
}

function isFallingBlock(name) {
    return name === 'sand' || name === 'red_sand' || name === 'gravel' ||
        name?.endsWith('_concrete_powder');
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
    const duration = protocolDigDuration(bot, block);
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

function protocolDigDuration(bot, block) {
    const held = bot.heldItem?.name || '';
    if (['stone', 'cobblestone'].includes(block.name)) {
        if (held === 'iron_pickaxe' || inventorySlots(bot).some(item => item.name === 'iron_pickaxe')) return 550;
        if (held === 'stone_pickaxe' || inventorySlots(bot).some(item => item.name === 'stone_pickaxe')) return 800;
        if (held === 'wooden_pickaxe' || inventorySlots(bot).some(item => item.name === 'wooden_pickaxe')) return 1400;
        return 8000;
    }
    if (['dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt'].includes(block.name)) {
        return 1100;
    }
    const reported = Number(bot.digTime?.(block) || 1200);
    return Math.max(500, Math.min(5000, reported + 300));
}

function digTimeoutMs(bot, block) {
    const digTime = Number(bot.digTime?.(block) || 0);
    if (!Number.isFinite(digTime) || digTime <= 0) return 12000;
    return Math.max(12000, Math.min(25000, digTime + 8000));
}

async function collectNearby(bot, itemName, before, origin) {
    return miningTools.collectDrop(bot, itemName, before, origin, { radius: 8, timeoutMs: 5000 });
}

function isSupportedPickupStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) && isAir(head) && floor?.boundingBox === 'block' &&
        !['water', 'lava', 'magma_block'].includes(floor.name);
}

async function equipToolForBlock(bot, block) {
    return miningTools.equipForBlock(bot, block);
}

function requiresPickaxe(name) {
    return name === 'stone' || name === 'cobblestone' ||
        name.endsWith('_ore') || name.startsWith('deepslate_');
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

function isLiquid(block) {
    return ['water', 'lava'].includes(block?.name);
}

module.exports = {
    collectStone,
    isFallingBlock
};
