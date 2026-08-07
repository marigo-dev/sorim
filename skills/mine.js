const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('./movement');
const actionControl = require('./actionControl');

const LOGS = new Set([
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log'
]);
const failedTrees = new Map();

async function mineBlock(bot, action) {
    const actionVersion = actionControl.snapshot(bot);
    actionControl.assertActive(bot, actionVersion);
    const targetName = action.target;
    const block = targetName === 'any_log' ? findBestLog(bot) : findBestBlock(bot, targetName);
    const expectedDrop = action.expectedDrop || (targetName === 'any_log' ? block?.name : expectedDropFor(targetName));
    if (!block) {
        if (targetName === 'any_log' || LOGS.has(targetName)) {
            const visibleLog = findNearestVisibleLog(bot, targetName);
            if (visibleLog) {
                console.log(`[TREE] visible but not reachable ${visibleLog.name} ${visibleLog.position.toString()}; forcing tree retry`);
                await chopTree(bot, visibleLog, visibleLog.name);
                return;
            }
            await movement.explore(bot, { target: 'wood' });
            return;
        }
        if (targetName === 'stone' || targetName === 'cobblestone') {
            await digStaircaseForStone(bot);
            return;
        }
        throw new Error(`No reachable block found for ${targetName}`);
    }

    if (LOGS.has(block.name)) {
        await chopTree(bot, block, expectedDrop, actionVersion);
        return;
    }

    const before = countItem(bot, expectedDrop);
    await equipBestTool(bot, block);
    await approachBlock(bot, block);

    const current = bot.blockAt(block.position);
    if (!current || current.name !== block.name) {
        throw new Error(`${targetName} target disappeared`);
    }
    if (!bot.canDigBlock(current)) {
        throw new Error(`${targetName} cannot be dug`);
    }

    console.log(`[MINE] ${current.name} ${current.position.toString()}`);
    await digWithTimeout(bot, current);
    await collectDrop(bot, expectedDrop, before, current.position);
}

async function chopTree(bot, baseBlock, expectedDrop, actionVersion = actionControl.snapshot(bot)) {
    const base = lowestLogInTrunk(bot, baseBlock);
    const initialTrunk = findTrunkBlocks(bot, base);
    if (initialTrunk.length === 0) throw new Error(`No trunk found for ${baseBlock.name}`);

    console.log(`[TREE] ${baseBlock.name} trunk=${initialTrunk.length} base=${base.position.toString()}`);
    let before = countItem(bot, expectedDrop);
    let mined = 0;
    const skipped = new Set();
    const startedAt = Date.now();

    for (let pass = 0; pass < 10; pass++) {
        actionControl.assertActive(bot, actionVersion);
        if (Date.now() - startedAt > 30000) {
            if (mined > 0) {
                console.log(`[TREE] stopping after partial chop mined=${mined}; continuing plan`);
                break;
            }
            markFailedTree(base.position);
            throw new Error(`${baseBlock.name} tree chopping timed out`);
        }

        const current = findNextTrunkBlock(bot, base.position, baseBlock.name, skipped);
        if (!current) break;

        await equipBestTool(bot, current);
        try {
            await approachBlock(bot, current);
        } catch {
            actionControl.assertActive(bot, actionVersion);
            await nudgeToward(bot, current.position);
        }

        console.log(`[MINE] ${current.name} ${current.position.toString()}`);
        try {
            await digTreeBlock(bot, current);
        } catch (error) {
            actionControl.assertActive(bot, actionVersion);
            console.log(`[TREE] retry failed ${current.position.toString()}: ${error.message}`);
            skipped.add(positionKey(current.position));
            continue;
        }
        mined++;
        try {
            // Upper logs fall down the cleared trunk. Returning to the trunk
            // base is more reliable than chasing the entity's spawn height.
            await collectDrop(bot, expectedDrop, before, base.position);
            before = countItem(bot, expectedDrop);
        } catch (error) {
            actionControl.assertActive(bot, actionVersion);
            console.log(`[TREE] drop gecikti: ${error.message}`);
            before = countItem(bot, expectedDrop);
        }
    }

    if (mined === 0) {
        markFailedTree(base.position);
        throw new Error(`Could not dig any block from ${baseBlock.name} trunk`);
    }
    console.log(`[TREE] complete mined=${mined} ${base.position.toString()}`);
}

function findNextTrunkBlock(bot, basePosition, name, skipped = new Set()) {
    for (let y = basePosition.y; y <= basePosition.y + 12; y++) {
        const block = bot.blockAt(new Vec3(basePosition.x, y, basePosition.z));
        if (!block || block.name !== name) continue;
        if (skipped.has(positionKey(block.position))) continue;
        if (isReachable(bot, block)) return block;
    }
    return null;
}

function positionKey(position) {
    return `${position.x},${position.y},${position.z}`;
}

function findBestBlock(bot, targetName) {
    const id = bot.registry.blocksByName[targetName]?.id;
    if (!id) return null;

    const blocks = bot.findBlocks({ matching: id, maxDistance: 48, count: 128 })
        .map(position => bot.blockAt(position))
        .filter(Boolean);

    const candidates = blocks
        .map(block => LOGS.has(block.name) ? lowestLogInTrunk(bot, block) : block)
        .filter(Boolean)
        .filter(block => !LOGS.has(block.name) || isRootedTree(bot, block))
        .filter(block => !isFailedTree(block.position))
        .filter(block => bot.canDigBlock(block))
        .filter(block => isReachable(bot, block))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b));

    return candidates[0] || null;
}

function findBestLog(bot) {
    return [...LOGS]
        .flatMap(name => {
            const id = bot.registry.blocksByName[name]?.id;
            if (!id) return [];
            return bot.findBlocks({ matching: id, maxDistance: 56, count: 64 })
                .map(position => bot.blockAt(position))
                .filter(Boolean)
                .map(block => lowestLogInTrunk(bot, block));
        })
        .filter(Boolean)
        .filter(block => isRootedTree(bot, block))
        .filter(block => !isFailedTree(block.position))
        .filter(block => bot.canDigBlock(block))
        .filter(block => isReachable(bot, block))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b))[0] || null;
}

function findNearestVisibleLog(bot, targetName = 'any_log') {
    const names = targetName === 'any_log' ? [...LOGS] : [targetName];
    return names
        .flatMap(name => {
            const id = bot.registry.blocksByName[name]?.id;
            if (!id) return [];
            return bot.findBlocks({ matching: id, maxDistance: 64, count: 96 })
                .map(position => bot.blockAt(position))
                .filter(Boolean)
                .map(block => lowestLogInTrunk(bot, block));
        })
        .filter(Boolean)
        .filter(block => isRootedTree(bot, block))
        .filter(block => !isFailedTree(block.position))
        .filter(block => block.position.y <= bot.entity.position.y + 4)
        .filter(block => block.position.y >= bot.entity.position.y - 8)
        .filter((block, index, list) =>
            list.findIndex(other => other.position.equals(block.position)) === index
        )
        .filter(block => hasOpenFace(bot, block.position))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b))[0] || null;
}

function markFailedTree(position) {
    failedTrees.set(positionKey(position), Date.now() + 120000);
}

function isFailedTree(position) {
    const key = positionKey(position);
    const expiresAt = failedTrees.get(key);
    if (!expiresAt) return false;
    if (Date.now() <= expiresAt) return true;
    failedTrees.delete(key);
    return false;
}

function lowestLogInTrunk(bot, block) {
    let current = block;
    for (let y = block.position.y - 1; y >= Math.max(1, block.position.y - 8); y--) {
        const below = bot.blockAt(new Vec3(block.position.x, y, block.position.z));
        if (!below || below.name !== block.name) break;
        current = below;
    }
    return current;
}

function isRootedTree(bot, block) {
    const base = lowestLogInTrunk(bot, block);
    const support = bot.blockAt(base.position.offset(0, -1, 0));
    return Boolean(support && support.boundingBox === 'block' && !LOGS.has(support.name));
}

function findTrunkBlocks(bot, block) {
    const base = lowestLogInTrunk(bot, block);
    const blocks = [];
    for (let y = base.position.y; y <= base.position.y + 12; y++) {
        const current = bot.blockAt(new Vec3(base.position.x, y, base.position.z));
        if (!current || current.name !== base.name) break;
        blocks.push(current);
    }
    return blocks;
}

function isReachable(bot, block) {
    if (!hasOpenFace(bot, block.position)) return false;
    const feet = findWorkPosition(bot, block.position);
    if (!feet) return false;
    const eye = feet.offset(0, 1.6, 0);
    return eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.6;
}

function findWorkPosition(bot, target) {
    return findWorkPositions(bot, target)[0] || null;
}

function findWorkPositions(bot, target) {
    const offsets = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    const currentY = bot.entity.position.floored().y;
    const levels = [];
    for (let y = target.y; y >= target.y - 5; y--) levels.push(y);
    levels.push(currentY, currentY + 1, currentY - 1);

    return levels
        .flatMap(y => offsets.map(([x, z]) => new Vec3(target.x + x, y, target.z + z)))
        .filter((position, index, list) =>
            list.findIndex(other => other.equals(position)) === index
        )
        .filter(position => {
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            const floor = bot.blockAt(position.offset(0, -1, 0));
            const eye = position.offset(0, 1.6, 0);
            return isPassable(feet) &&
                isPassable(head) &&
                floor?.boundingBox === 'block' &&
                eye.distanceTo(target.offset(0.5, 0.5, 0.5)) <= 4.6;
        })
        .sort((a, b) =>
            a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
        );
}

async function approachBlock(bot, block) {
    if (isWithinDigReach(bot, block)) {
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        return;
    }

    let lastError = null;
    const workPositions = findWorkPositions(bot, block.position).slice(0, 4);
    for (const work of workPositions) {
        try {
            await movement.withTimeout(
                bot.pathfinder.goto(new goals.GoalBlock(work.x, work.y, work.z)),
                3000,
                'Timed out walking to mining position'
            );
            if (isWithinDigReach(bot, block)) {
                await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
                return;
            }
        } catch (error) {
            lastError = error;
            movement.stop(bot);
        }
    }

    try {
        await movement.moveNear(bot, block.position, 3, 7000);
    } catch (error) {
        throw lastError || error;
    }

    if (!isWithinDigReach(bot, block)) {
        throw lastError || new Error(`No reachable mining position for ${block.name}`);
    }
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
}

async function equipBestTool(bot, block) {
    const suffix = LOGS.has(block.name) ? '_axe' : '_pickaxe';
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
    const tool = tiers
        .map(tier => `${tier}${suffix}`)
        .map(name => inventorySlots(bot).find(item => item.name === name))
        .find(Boolean);
    if (tool) await bot.equip(tool, 'hand');
}

async function collectDrop(bot, itemName, before, origin) {
    for (let attempt = 0; attempt < 6; attempt++) {
        if (countItem(bot, itemName) > before) return;

        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= 14)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];

        if (drop) {
            try {
                await movement.moveBlock(bot, drop.position.floored(), 2200);
            } catch {
                await nudgeToward(bot, drop.position);
            }
        } else {
            await nudgeToward(bot, origin);
        }
        await movement.sleep(350);
    }

    if (countItem(bot, itemName) <= before) {
        if (hasNearbyDrop(bot, origin, 14)) {
            throw new Error(`${itemName} was broken but did not enter inventory`);
        }
        throw new Error(`${itemName} drop disappeared without a server inventory update`);
    }
}

async function collectLooseDrops(bot, itemName, before, origin, radius = 8) {
    for (let attempt = 0; attempt < 14; attempt++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= radius)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) break;
        try {
            await movement.moveBlock(bot, drop.position.floored(), 3000);
        } catch {
            await nudgeToward(bot, drop.position);
        }
        if (countItem(bot, itemName) > before) before = countItem(bot, itemName);
    }
}

function hasNearbyDrop(bot, origin, radius) {
    return Object.values(bot.entities || {})
        .some(entity => entity.name === 'item' && entity.position.distanceTo(origin) <= radius);
}

async function patrolTreeDrops(bot, itemName, before, base) {
    await collectLooseDrops(bot, itemName, before, base, 18);
    const points = [
        base.offset(1, 0, 0),
        base.offset(-1, 0, 0),
        base.offset(0, 0, 1),
        base.offset(0, 0, -1),
        base.offset(2, 0, 0),
        base.offset(0, 0, 2)
    ];

    for (const point of points) {
        try {
            await movement.moveNear(bot, point, 1, 3000);
        } catch {
            await nudgeToward(bot, point);
        }
        await collectLooseDrops(bot, itemName, before, base, 18);
        before = countItem(bot, itemName);
    }
}

async function digStaircaseForStone(bot) {
    const origin = bot.entity.position.floored();
    const yaw = bot.entity.yaw;
    const dx = Math.abs(Math.cos(yaw)) > Math.abs(Math.sin(yaw))
        ? Math.sign(Math.cos(yaw))
        : 0;
    const dz = dx === 0 ? Math.sign(Math.sin(yaw)) : 0;
    const stepX = dx || 1;
    const stepZ = dz || 0;

    console.log('[MINE] No reachable stone; digging a small staircase.');
    for (let step = 1; step <= 24; step++) {
        const base = bot.entity.position.floored();
        const front = base.offset(stepX, 0, stepZ);
        const head = front.offset(0, 1, 0);
        const down = front.offset(0, -1, 0);

        const nearbyStone = findBestBlock(bot, 'stone');
        if (nearbyStone) {
            await mineBlock(bot, {
                target: 'stone',
                expectedDrop: 'cobblestone'
            });
            return;
        }

        await clearBlock(bot, head);
        await clearBlock(bot, front);
        const before = countItem(bot, 'cobblestone');
        const downBlock = bot.blockAt(down);
        if (downBlock?.name === 'stone') {
            await equipBestTool(bot, downBlock);
            await bot.lookAt(downBlock.position.offset(0.5, 0.5, 0.5), true);
            await digWithTimeout(bot, downBlock);
            await collectDrop(bot, 'cobblestone', before, downBlock.position);
            return;
        }
        await clearBlock(bot, down);

        try {
            await movement.moveNear(bot, down, 1, 8000);
        } catch {
            await nudgeToward(bot, down);
        }
    }

    throw new Error('Staircase was dug but no stone was found');
}

async function clearBlock(bot, blockOrPosition) {
    const block = blockOrPosition?.position
        ? blockOrPosition
        : bot.blockAt(blockOrPosition);
    if (!block || isAir(block)) return;
    if (!bot.canDigBlock(block)) return;
    await equipBestTool(bot, block);
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
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function digTimeoutMs(bot, block) {
    const digTime = Number(bot.digTime?.(block) || 0);
    if (!Number.isFinite(digTime) || digTime <= 0) return 8000;
    return Math.max(8000, Math.min(18000, digTime + 6000));
}

async function digTreeBlock(bot, block) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = bot.blockAt(block.position);
        if (!current || current.name !== block.name) return;

        try {
            if (!isWithinDigReach(bot, current)) {
                await approachBlock(bot, current);
            }
            await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
            await digWithTimeout(bot, current);
            return;
        } catch (error) {
            lastError = error;
            await repositionForTreeBlock(bot, current, attempt);
        }
    }

    throw lastError || new Error(`Could not dig ${block.name} ${block.position.toString()}`);
}

function isWithinDigReach(bot, block) {
    const eye = bot.entity.position.offset(0, 1.6, 0);
    return eye.distanceTo(block.position.offset(0.5, 0.5, 0.5)) <= 4.6 &&
        hasOpenFace(bot, block.position);
}

async function repositionForTreeBlock(bot, block, attempt) {
    const target = block.position;
    const below = target.offset(0, -1, 0);
    const side = findWorkPosition(bot, target) ||
        findWorkPosition(bot, below) ||
        bot.entity.position.floored();

    try {
        await movement.withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(side.x, side.y, side.z, 1)),
            3500,
            'Timed out repositioning for tree block'
        );
    } catch {
        await nudgeToward(bot, target);
    }

    await bot.lookAt(target.offset(0.5, 0.5, 0.5), true);
    if (attempt > 0 && target.y > bot.entity.position.y + 1.4) {
        bot.setControlState('jump', true);
        await movement.sleep(350);
        bot.setControlState('jump', false);
    } else {
        await movement.sleep(250);
    }
}

async function nudgeToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0, 0.2, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('jump', true);
        bot.setControlState('sprint', true);
        await movement.sleep(900);
    } finally {
        bot.clearControlStates();
    }
}

function hasOpenFace(bot, position) {
    return [
        [1, 0, 0], [-1, 0, 0], [0, 1, 0],
        [0, -1, 0], [0, 0, 1], [0, 0, -1]
    ].some(([x, y, z]) => isPassable(bot.blockAt(position.offset(x, y, z))));
}

function isPassable(block) {
    return isAir(block) || block?.boundingBox === 'empty';
}

function scoreBlock(bot, block) {
    const distance = block.position.distanceTo(bot.entity.position);
    const vertical = Math.abs(block.position.y - bot.entity.position.y);
    const hasSameBelow = bot.blockAt(block.position.offset(0, -1, 0))?.name === block.name;
    return distance + vertical * 10 + (hasSameBelow ? 80 : 0);
}

function expectedDropFor(blockName) {
    if (blockName === 'stone') return 'cobblestone';
    return blockName;
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

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    mineBlock
};
