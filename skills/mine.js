const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('./movement');
const actionControl = require('./actionControl');
const shelter = require('./shelter');
const blockPolicy = require('../safety/blockPolicy');

const LOGS = new Set([
    'oak_log',
    'birch_log',
    'spruce_log',
    'jungle_log',
    'acacia_log',
    'dark_oak_log',
    'cherry_log',
    'mangrove_log',
    'pale_oak_log'
]);
const failedTrees = new Map();

async function mineBlock(bot, action) {
    const actionVersion = actionControl.snapshot(bot);
    actionControl.assertActive(bot, actionVersion);
    await shelter.leaveBase(bot);
    actionControl.assertActive(bot, actionVersion);
    const targetName = action.target;
    if (targetName === 'any_log' || LOGS.has(targetName)) {
        await movement.descendFromCanopy(
            bot,
            28,
            () => actionControl.snapshot(bot) === actionVersion
        );
        actionControl.assertActive(bot, actionVersion);
    }
    const block = targetName === 'any_log' ? findBestLog(bot) : findBestBlock(bot, targetName);
    const expectedDrop = action.expectedDrop || (targetName === 'any_log' ? block?.name : expectedDropFor(targetName));
    if (!block) {
        if (targetName === 'any_log' || LOGS.has(targetName)) {
            let visibleLog = findNearestVisibleLog(bot, targetName);
            if (!visibleLog) {
                const exploration = await movement.explore(bot, {
                    target: 'wood',
                    stopWhen: () => findNearestVisibleLog(bot, targetName),
                    isActive: () => actionControl.snapshot(bot) === actionVersion
                });
                actionControl.assertActive(bot, actionVersion);
                visibleLog = exploration?.found || findNearestVisibleLog(bot, targetName);
            }
            if (!visibleLog) {
                throw new Error(`No ${targetName} found after wood exploration`);
            }

            console.log(`[TREE] approaching visible ${visibleLog.name} ${visibleLog.position.toString()}`);
            const failedTreePosition = lowestLogInTrunk(bot, visibleLog).position;
            let reached = false;
            try {
                reached = await approachTreeByWaypoints(bot, visibleLog, actionVersion);
            } catch (error) {
                if (horizontalDistance(bot.entity.position, failedTreePosition) > 8) {
                    markFailedTree(failedTreePosition);
                }
                throw error;
            }
            if (!reached) {
                if (horizontalDistance(bot.entity.position, failedTreePosition) > 8) {
                    markFailedTree(failedTreePosition);
                }
                throw new Error(`Could not reach ${visibleLog.name} at ${visibleLog.position.toString()}`);
            }
            const currentLog = bot.blockAt(visibleLog.position);
            if (currentLog?.name === visibleLog.name) {
                await chopTree(bot, currentLog, visibleLog.name, actionVersion);
                return;
            }
            throw new Error(`${visibleLog.name} disappeared before chopping`);
        }
        if (targetName === 'stone' || targetName === 'cobblestone') {
            await digStaircaseForStone(bot);
            return;
        }
        throw new Error(`No reachable block found for ${targetName}`);
    }

    if (LOGS.has(block.name)) {
        try {
            await chopTree(bot, block, expectedDrop, actionVersion);
        } catch (error) {
            markFailedTree(lowestLogInTrunk(bot, block).position);
            throw error;
        }
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

async function approachTreeByWaypoints(bot, treeBlock, actionVersion) {
    const root = lowestLogInTrunk(bot, treeBlock);
    const workPositions = findWorkPositions(bot, root.position);
    const position = workPositions[0] || root.position;
    const initialDistance = horizontalDistance(bot.entity.position, position);
    const approachBudget = Math.min(90000, Math.max(35000, initialDistance * 1200));
    const deadline = Date.now() + approachBudget;
    const reachedTree = () => {
        const current = bot.blockAt(root.position);
        return current?.name === root.name && isWithinDigReach(bot, current);
    };

    const initialWorkPositions = initialDistance <= 12
        ? workPositions.slice(0, 3)
        : workPositions.slice(0, 1);
    for (const work of initialWorkPositions) {
        try {
            const timeout = initialDistance <= 12 ? 5500 : 12000;
            await movement.moveNear(bot, work, 0.8, Math.min(timeout, deadline - Date.now()));
            if (reachedTree()) return true;
        } catch (error) {
            actionControl.assertActive(bot, actionVersion);
            movement.stop(bot);
            console.log(`[TREE] work position blocked ${work.toString()}: ${error.message}`);
        }
        if (Date.now() >= deadline) return false;
    }

    if (horizontalDistance(bot.entity.position, position) <= 15) {
        try {
            await movement.moveNear(bot, position, 1.2, Math.min(7000, deadline - Date.now()));
            if (reachedTree()) return true;
        } catch (error) {
            actionControl.assertActive(bot, actionVersion);
            movement.stop(bot);
            console.log(`[TREE] primary path failed, using local traversal: ${error.message}`);
        }
    }
    if (horizontalDistance(bot.entity.position, position) <= 12) {
        return approachTreeDirectly(bot, position, actionVersion, root.position);
    }
    let stalled = 0;
    let previousDistance = horizontalDistance(bot.entity.position, position);
    for (let step = 0; step < 16 && previousDistance > 10 && Date.now() < deadline; step++) {
        actionControl.assertActive(bot, actionVersion);
        const origin = bot.entity.position;
        const dx = position.x - origin.x;
        const dz = position.z - origin.z;
        const distance = Math.hypot(dx, dz);
        const stride = Math.min(16, Math.max(6, distance - 7));
        const waypoint = new Vec3(
            Math.round(origin.x + dx / distance * stride),
            Math.floor(origin.y),
            Math.round(origin.z + dz / distance * stride)
        );
        try {
            await movement.moveNearXZ(bot, waypoint, 3, Math.min(6000, deadline - Date.now()));
        } catch (error) {
            actionControl.assertActive(bot, actionVersion);
            movement.stop(bot);
            console.log(`[TREE] waypoint delayed ${waypoint.toString()}: ${error.message}`);
            movement.resyncCollision(bot);
            const beforeFallback = bot.entity.position.clone();
            await clearTreeFoliageToward(bot, position);
            await movement.moveTowardDirectly(bot, position, 3200);
            movement.resyncCollision(bot);
            if (bot.entity.position.distanceTo(beforeFallback) < 1) {
                await movement.moveTowardSafely(bot, waypoint, 12);
            }
        }

        const nextDistance = horizontalDistance(bot.entity.position, position);
        stalled = nextDistance >= previousDistance - 1 ? stalled + 1 : 0;
        previousDistance = nextDistance;
        if (stalled >= 2) {
            movement.resyncCollision(bot);
            const beforeRecovery = horizontalDistance(bot.entity.position, position);
            await clearTreeFoliageToward(bot, position);
            const opened = await openNaturalTraversalExit(bot, position);
            if (opened) {
                if (reachedTree()) {
                    console.log('[TREE] enclosure exit reached the tree work area');
                    return true;
                }
                const exitDistance = horizontalDistance(bot.entity.position, position);
                console.log(`[TREE] enclosure escaped; continuing same tree distance=${exitDistance.toFixed(1)}`);
                if (exitDistance < beforeRecovery - 0.5) {
                    previousDistance = exitDistance;
                    stalled = 0;
                    continue;
                }
            }
            const climbed = await carveNaturalAscent(bot, position, actionVersion);
            if (climbed) {
                const climbDistance = horizontalDistance(bot.entity.position, position);
                console.log(`[TREE] climbed out of the enclosure; continuing same tree distance=${climbDistance.toFixed(1)}`);
                if (climbDistance < beforeRecovery - 0.5) {
                    previousDistance = climbDistance;
                    stalled = 0;
                    continue;
                }
            }
            await movement.moveTowardDirectly(bot, position, 3200);
            movement.resyncCollision(bot);
            const afterRecovery = horizontalDistance(bot.entity.position, position);
            console.log(
                `[TREE] stalled recovery distance=${beforeRecovery.toFixed(1)}->${afterRecovery.toFixed(1)}`
            );
            if (afterRecovery > beforeRecovery - 0.25) return false;
            previousDistance = afterRecovery;
            stalled = 0;
        }
    }

    if (Date.now() >= deadline) return false;

    try {
        await movement.moveNear(bot, position, 3, 12000);
        const finalDistance = bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5));
        if (reachedTree()) return true;
        console.log(`[TREE] path resolved before arrival distance=${finalDistance.toFixed(1)}`);
        return approachTreeDirectly(bot, position, actionVersion, root.position);
    } catch (error) {
        actionControl.assertActive(bot, actionVersion);
        movement.stop(bot);
        console.log(`[TREE] final path approach failed, trying direct movement: ${error.message}`);
        return approachTreeDirectly(bot, position, actionVersion, root.position);
    }
}

function canClearNaturalTraversalBlock(bot, block) {
    const naturalTerrain = new Set([
        'dirt', 'grass_block', 'stone', 'andesite', 'diorite', 'granite',
        'gravel', 'sand', 'clay', 'mud', 'tuff', 'calcite', 'deepslate'
    ]);
    if (!naturalTerrain.has(block?.name)) return false;
    return blockPolicy.canBreak(bot, block, 'terrain_recovery').allowed;
}

async function openNaturalTraversalExit(bot, target) {
    const origin = bot.entity.position.floored();
    const targetDx = target.x - origin.x;
    const targetDz = target.z - origin.z;
    const directions = [
        { x: 1, z: 0 }, { x: -1, z: 0 },
        { x: 0, z: 1 }, { x: 0, z: -1 }
    ].sort((left, right) =>
        (right.x * targetDx + right.z * targetDz) -
        (left.x * targetDx + left.z * targetDz)
    );

    for (const direction of directions) {
        let progressed = 0;
        for (let distance = 1; distance <= 3; distance++) {
            const cell = origin.offset(direction.x * distance, 0, direction.z * distance);
            const floor = bot.blockAt(cell.offset(0, -1, 0));
            const obstacles = [bot.blockAt(cell), bot.blockAt(cell.offset(0, 1, 0))]
                .filter(block => block?.boundingBox === 'block');
            if (floor?.boundingBox !== 'block') break;
            if (obstacles.some(block => !canClearNaturalTraversalBlock(bot, block))) break;

            if (obstacles.length > 0) {
                const opened = await movement.clearStepToward(
                    bot,
                    cell,
                    1,
                    block => canClearNaturalTraversalBlock(bot, block)
                );
                if (!opened) break;
            }

            const before = bot.entity.position.clone();
            await movement.walkToward(bot, cell, { durationMs: 1800 });
            if (bot.entity.position.distanceTo(before) < 0.4) break;
            progressed++;
        }
        if (progressed >= 2) {
            const exit = bot.entity.position.floored();
            console.log(`[TREE] opened safe natural corridor ${exit.toString()} length=${progressed}`);
            return exit;
        }
    }
    return false;
}

async function carveNaturalAscent(bot, target, actionVersion) {
    const startY = bot.entity.position.y;
    const origin = bot.entity.position.floored();
    const dxRaw = target.x - origin.x;
    const dzRaw = target.z - origin.z;
    const direction = Math.abs(dxRaw) >= Math.abs(dzRaw)
        ? { x: Math.sign(dxRaw) || 1, z: 0 }
        : { x: 0, z: Math.sign(dzRaw) || 1 };

    for (let step = 0; step < 5; step++) {
        actionControl.assertActive(bot, actionVersion);
        const current = bot.entity.position.floored();
        const stand = current.offset(direction.x, 1, direction.z);
        const floor = bot.blockAt(stand.offset(0, -1, 0));
        if (floor?.boundingBox !== 'block') break;

        for (const position of [stand, stand.offset(0, 1, 0)]) {
            const block = bot.blockAt(position);
            if (block?.boundingBox !== 'block') continue;
            if (!canClearNaturalTraversalBlock(bot, block) || !bot.canDigBlock(block)) {
                return bot.entity.position.y >= startY + 1.7;
            }
            await equipTraversalTool(bot, block);
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await movement.withTimeout(bot.dig(block), 12000, `Timed out carving ascent through ${block.name}`);
            await movement.sleep(150);
        }

        const beforeY = bot.entity.position.y;
        let climbed = await movement.stepUpToward(bot, stand);
        if (!climbed) {
            await movement.walkToward(bot, stand, { durationMs: 1800 });
            climbed = bot.entity.position.y >= beforeY + 0.7;
        }
        if (!climbed) break;
        console.log(`[TREE] natural ascent step y=${beforeY.toFixed(1)}->${bot.entity.position.y.toFixed(1)}`);
    }
    return bot.entity.position.y >= startY + 1.7;
}

async function equipTraversalTool(bot, block) {
    const pickaxeBlock = new Set([
        'stone', 'andesite', 'diorite', 'granite', 'tuff', 'calcite', 'deepslate'
    ]).has(block.name);
    const suffix = pickaxeBlock ? '_pickaxe' : '_shovel';
    const item = bot.inventory.items().find(candidate => candidate.name.endsWith(suffix));
    if (item) await bot.equip(item, 'hand');
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

async function approachTreeDirectly(bot, position, actionVersion, rootPosition = position) {
    const reachedTree = () => {
        const current = bot.blockAt(rootPosition);
        return current && LOGS.has(current.name) && isWithinDigReach(bot, current);
    };
    let previousDistance = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
        actionControl.assertActive(bot, actionVersion);
        const distance = bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5));
        if (reachedTree() || distance <= 1.4) return true;
        await nudgeToward(bot, position);
        const nextDistance = bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5));
        if (nextDistance >= previousDistance - 0.2 && attempt >= 1) break;
        previousDistance = nextDistance;
    }
    if (reachedTree() || bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5)) <= 1.4) return true;

    const opened = await openNaturalTraversalExit(bot, position);
    if (opened) {
        if (reachedTree()) return true;
        let previousExitDistance = horizontalDistance(bot.entity.position, position);
        for (let attempt = 0; attempt < 6; attempt++) {
            actionControl.assertActive(bot, actionVersion);
            await clearTreeFoliageToward(bot, position);
            await nudgeToward(bot, position);
            if (reachedTree()) return true;
            const exitDistance = horizontalDistance(bot.entity.position, position);
            if (exitDistance >= previousExitDistance - 0.2 && attempt >= 1) break;
            previousExitDistance = exitDistance;
        }
    }
    await carveNaturalAscent(bot, position, actionVersion);
    return reachedTree() || bot.entity.position.distanceTo(position.offset(0.5, 0, 0.5)) <= 1.4;
}

async function mineSpecificBlock(bot, blockOrPosition, expectedDrop) {
    const actionVersion = actionControl.snapshot(bot);
    actionControl.assertActive(bot, actionVersion);
    const position = blockOrPosition?.position || blockOrPosition;
    let block = bot.blockAt(position);
    if (!block || isAir(block)) return false;

    const before = countItem(bot, expectedDrop);
    await equipBestTool(bot, block);
    await approachBlock(bot, block);
    actionControl.assertActive(bot, actionVersion);

    block = bot.blockAt(position);
    if (!block || isAir(block)) return countItem(bot, expectedDrop) > before;
    if (!bot.canDigBlock(block)) throw new Error(`${block.name} cannot be dug`);

    console.log(`[MINE] direct ${block.name} ${block.position.toString()}`);
    await digWithTimeout(bot, block);
    await collectDrop(bot, expectedDrop, before, block.position);
    return countItem(bot, expectedDrop) > before;
}

async function chopTree(bot, baseBlock, expectedDrop, actionVersion = actionControl.snapshot(bot)) {
    const base = lowestLogInTrunk(bot, baseBlock);
    const policy = blockPolicy.canHarvestTree(bot, base);
    if (!policy.allowed) {
        markFailedTree(base.position);
        throw new Error(`Protected tree skipped: ${policy.reason}`);
    }
    const initialTrunk = findTrunkBlocks(bot, base);
    if (initialTrunk.length === 0) throw new Error(`No trunk found for ${baseBlock.name}`);

    console.log(`[TREE] ${baseBlock.name} trunk=${initialTrunk.length} base=${base.position.toString()}`);
    const before = countItem(bot, expectedDrop);
    let mined = 0;
    const skipped = new Set();
    const startedAt = Date.now();

    if (
        horizontalDistance(bot.entity.position, base.position) <= 2.5 &&
        bot.entity.position.y >= base.position.y + 3
    ) {
        mined += await chopTreeDownwardFromCanopy(bot, base, actionVersion);
        if (mined > 0) {
            await patrolTreeDrops(bot, expectedDrop, before, base.position);
            if (countItem(bot, expectedDrop) <= before) {
                throw new Error(`Canopy log was cut but no ${expectedDrop} entered inventory`);
            }
            console.log(`[TREE] canopy layer complete mined=${mined} ${base.position.toString()}`);
            return;
        }
    }

    // Start beside the natural root so the first drop is inside pickup range.
    // Breaking an upper log from maximum reach commonly strands the drop
    // behind foliage on uneven terrain.
    let entry = bot.blockAt(base.position);
    if (entry?.name === baseBlock.name) {
        try {
            await approachTreeEntry(bot, entry);
        } catch (error) {
            markFailedTree(base.position);
            throw error;
        }
        entry = bot.blockAt(base.position);
        if (!entry || entry.name !== baseBlock.name || !bot.canDigBlock(entry)) {
            markFailedTree(base.position);
            throw new Error(`Tree root is not diggable after approach at ${base.position.toString()}`);
        }
        await equipBestTool(bot, entry);
        console.log(`[MINE] tree entry ${entry.name} ${entry.position.toString()}`);
        await digTreeBlock(bot, entry);
        mined++;
        await movement.sleep(200);
    }

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

        // Continue only through the original contiguous trunk. Searching past a
        // gap makes detached canopy logs look like the next trunk block and can
        // trap the bot in repeated jump/reposition attempts several blocks up.
        const current = bot.blockAt(base.position.offset(0, mined, 0));
        if (!current || current.name !== baseBlock.name) break;
        if (skipped.has(positionKey(current.position))) break;
        const currentPolicy = blockPolicy.canHarvestTree(bot, current);
        if (!currentPolicy.allowed) {
            skipped.add(positionKey(current.position));
            console.log(`[TREE] protected ${current.position.toString()}: ${currentPolicy.reason}`);
            continue;
        }

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
        await movement.sleep(200);
    }

    if (mined === 0) {
        markFailedTree(base.position);
        throw new Error(`Could not dig any block from ${baseBlock.name} trunk`);
    }
    await patrolTreeDrops(bot, expectedDrop, before, base.position);
    const gained = countItem(bot, expectedDrop) - before;
    if (gained <= 0) {
        markFailedTree(base.position);
        throw new Error(`Tree was cut but no ${expectedDrop} entered inventory`);
    }
    console.log(`[TREE] complete mined=${mined} ${base.position.toString()}`);
}

async function chopTreeDownwardFromCanopy(bot, base, actionVersion) {
    let mined = 0;
    console.log(`[TREE] descending through trunk from canopy ${base.position.toString()}`);
    for (let y = base.position.y + 12; y >= base.position.y; y--) {
        actionControl.assertActive(bot, actionVersion);
        const block = bot.blockAt(new Vec3(base.position.x, y, base.position.z));
        if (!block || block.name !== base.name) continue;
        const center = block.position.offset(0.5, 0.5, 0.5);
        if (bot.entity.position.distanceTo(center) > 3.2) continue;
        await equipBestTool(bot, block);
        await bot.lookAt(center, true);
        await digTreeBlock(bot, block);
        mined++;
        const beforeY = bot.entity.position.y;
        const deadline = Date.now() + 1800;
        while (Date.now() < deadline && bot.entity.position.y >= beforeY - 0.7) {
            await movement.sleep(50);
        }
        await movement.sleep(200);
    }
    return mined;
}

async function approachTreeEntry(bot, block) {
    const center = block.position.offset(0.5, 0.5, 0.5);
    if (bot.entity.position.distanceTo(center) <= 2.6 || bot.canDigBlock(block)) return;

    for (const stand of findWorkPositions(bot, block.position).slice(0, 4)) {
        try {
            await movement.moveBlock(bot, stand, 4500);
        } catch {
            movement.stop(bot);
        }
        if (bot.entity.position.distanceTo(center) <= 2.6 || bot.canDigBlock(block)) return;
    }

    await clearTreeFoliageToward(bot, block.position);
    await movement.moveTowardSafely(bot, block.position, 8);
    if (bot.entity.position.distanceTo(center) <= 2.8 || bot.canDigBlock(block)) return;

    try {
        await movement.moveNear(bot, block.position, 1, 5000);
    } catch {
        movement.stop(bot);
    }
    if (bot.entity.position.distanceTo(center) > 2.8 && !bot.canDigBlock(block)) {
        throw new Error(`Could not enter pickup range for ${block.name} at ${block.position.toString()}`);
    }
}

async function clearTreeFoliageToward(bot, target) {
    const origin = bot.entity.position.floored();
    const dx = Math.sign(target.x - origin.x);
    const dz = Math.sign(target.z - origin.z);
    if (dx === 0 && dz === 0) return false;

    let cleared = false;
    for (let distance = 1; distance <= 2; distance++) {
        const feet = origin.offset(dx * distance, 0, dz * distance);
        for (const position of [feet, feet.offset(0, 1, 0)]) {
            const block = bot.blockAt(position);
            if (!block?.name?.endsWith('_leaves') || !bot.canDigBlock(block)) continue;
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await digWithTimeout(bot, block);
            await movement.sleep(100);
            cleared = true;
        }
    }
    if (cleared) console.log('[TREE] cleared blocking foliage without modifying terrain');
    return cleared;
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
        .filter(block => !LOGS.has(block.name) || blockPolicy.canHarvestTree(bot, block).allowed)
        .filter(block => !isFailedTree(block.position))
        .filter(block => bot.canDigBlock(block))
        .filter(block => isReachable(bot, block))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b));

    return candidates[0] || null;
}

function findBestLog(bot) {
    return bot.findBlocks({
        matching: block => LOGS.has(block?.name),
        maxDistance: 56,
        count: 128
    })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => isRootedTree(bot, block))
        .filter(block => blockPolicy.canHarvestTree(bot, block).allowed)
        .filter(block => !isFailedTree(lowestLogInTrunk(bot, block).position))
        .filter(block => bot.canDigBlock(block))
        .filter(block => isReachable(bot, block))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b))[0] || null;
}

function findNearestVisibleLog(bot, targetName = 'any_log') {
    const names = targetName === 'any_log' ? LOGS : new Set([targetName]);
    return bot.findBlocks({
        matching: block => names.has(block?.name),
        maxDistance: 72,
        count: 128
    })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .map(block => lowestLogInTrunk(bot, block))
        .filter(block => isRootedTree(bot, block))
        .filter(block => blockPolicy.canHarvestTree(bot, block).allowed)
        .filter(block => !isFailedTree(block.position))
        .filter(block => block.position.y <= bot.entity.position.y + 4)
        .filter(block => block.position.y >= bot.entity.position.y - 4)
        .filter((block, index, list) =>
            list.findIndex(other => other.position.equals(block.position)) === index
        )
        .filter(block => hasOpenFace(bot, block.position))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b))[0] || null;
}

function markFailedTree(position) {
    failedTrees.set(positionKey(position), Date.now() + 60 * 1000);
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
    const trunk = findTrunkBlocks(bot, base);
    return Boolean(
        support &&
        support.boundingBox === 'block' &&
        !LOGS.has(support.name) &&
        trunk.length >= 2 &&
        hasNaturalCanopy(bot, trunk[trunk.length - 1].position)
    );
}

function hasNaturalCanopy(bot, top) {
    let leaves = 0;
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                if (bot.blockAt(top.offset(dx, dy, dz))?.name?.endsWith('_leaves')) leaves++;
                if (leaves >= 4) return true;
            }
        }
    }
    return false;
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
    const candidates = tiers
        .map(tier => `${tier}${suffix}`)
        .map(name => inventorySlots(bot).find(item => item.name === name))
        .filter(Boolean);
    const tool = candidates.find(item => toolRemainingDurability(bot, item) > 8) || candidates[0];
    if (tool) await bot.equip(tool, 'hand');
}

function toolRemainingDurability(bot, item) {
    const maximum = Number(
        item?.maxDurability || bot.registry.itemsByName[item?.name]?.maxDurability || 0
    );
    if (!maximum) return Number.POSITIVE_INFINITY;
    return Math.max(0, maximum - Number(item.durabilityUsed || 0));
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
                movement.stop(bot);
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

async function collectLooseDrops(bot, itemName, before, origin, radius = 8, deadline = Infinity, visited = new Set()) {
    for (let attempt = 0; attempt < 4 && Date.now() < deadline; attempt++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(origin) <= radius)
            .filter(entity => !visited.has(entity.id))
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) break;
        visited.add(drop.id);
        try {
            await movement.moveNear(bot, drop.position, 1, 1600);
        } catch {
            movement.stop(bot);
        }
        if (countItem(bot, itemName) > before) before = countItem(bot, itemName);
    }
}

function hasNearbyDrop(bot, origin, radius) {
    return Object.values(bot.entities || {})
        .some(entity => entity.name === 'item' && entity.position.distanceTo(origin) <= radius);
}

async function patrolTreeDrops(bot, itemName, before, base) {
    const deadline = Date.now() + 12000;
    const visited = new Set();
    try {
        await movement.moveNear(bot, base, 1, 2600);
    } catch {
        movement.stop(bot);
        await nudgeToward(bot, base);
    }
    await movement.sleep(500);
    await collectLooseDrops(bot, itemName, before, base, 18, deadline, visited);
    const points = [
        base.offset(1, 0, 0),
        base.offset(-1, 0, 0),
        base.offset(0, 0, 1),
        base.offset(0, 0, -1)
    ];

    for (const point of points) {
        if (Date.now() >= deadline) break;
        try {
            await movement.moveNear(bot, point, 1, 1400);
        } catch {
            movement.stop(bot);
            await nudgeToward(bot, point);
        }
        await movement.sleep(300);
        await collectLooseDrops(bot, itemName, before, base, 18, deadline, visited);
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
        if (await digWithProtocolFallback(bot, current)) return;
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

async function digWithProtocolFallback(bot, block) {
    const duration = Math.max(250, Math.min(15000, Number(bot.digTime?.(block) || 1000) + 250));
    console.log(`[MINE] protocol dig fallback ${block.position.toString()} wait=${duration}`);
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
    if (!Number.isFinite(digTime) || digTime <= 0) return 8000;
    return Math.max(8000, Math.min(18000, digTime + 6000));
}

async function digTreeBlock(bot, block) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const current = bot.blockAt(block.position);
        if (!current || current.name !== block.name) return;

        try {
            if (!isWithinTreeDigReach(bot, current)) {
                const distance = bot.entity.position.offset(0, 1.65, 0)
                    .distanceTo(current.position.offset(0.5, 0.5, 0.5));
                console.log(
                    `[TREE] reposition distance=${distance.toFixed(2)} ` +
                    `diggable=${current.diggable} bot=${bot.entity.position.toString()}`
                );
                await approachBlock(bot, current);
            }
            await bot.lookAt(current.position.offset(0.5, 0.5, 0.5), true);
            await digWithTimeout(bot, current);
            return;
        } catch (error) {
            lastError = error;
            console.log(`[TREE] dig attempt ${attempt + 1} failed: ${error.message}`);
            await repositionForTreeBlock(bot, current, attempt);
        }
    }

    throw lastError || new Error(`Could not dig ${block.name} ${block.position.toString()}`);
}

function isWithinTreeDigReach(bot, block) {
    return bot.canDigBlock(block);
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
    await movement.walkToward(bot, position, { durationMs: 900 });
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
    mineBlock,
    mineSpecificBlock,
    clearBlock
};
