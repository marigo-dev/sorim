const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const memory = require('./memory');

const explorationSessions = new WeakMap();
const navigationVersions = new WeakMap();
const groundedSynchronizers = new WeakMap();

function configure(bot) {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = false;
    movements.allowParkour = false;
    movements.allowSprinting = false;
    movements.maxDropDown = 1;
    movements.infiniteLiquidDropdownDistance = false;
    movements.liquidCost = 10000;
    movements.entityCost = 4;
    movements.exclusionAreasStep.push(block =>
        ['water', 'bubble_column', 'lava'].includes(block?.name) ? Number.POSITIVE_INFINITY : 0
    );
    movements.exclusionAreasStep.push(block =>
        block?.name?.endsWith('_leaves') ? 100 : 0
    );
    bot.pathfinder.setMovements(movements);
    if (!groundedSynchronizers.has(bot)) {
        const synchronize = () => synchronizeGroundedState(bot);
        groundedSynchronizers.set(bot, synchronize);
        if (typeof bot.prependListener === 'function') bot.prependListener('physicsTick', synchronize);
        else bot.on('physicsTick', synchronize);
    }
}

function resyncCollision(bot) {
    if (!bot.entity?.position || typeof bot.blockAt !== 'function') return false;
    const feet = bot.entity.position.floored();
    if (bodyIntersectsSolid(bot)) {
        stop(bot);
        console.log(`[MOVE] body collision detected at ${feet.toString()}; controls released for physical recovery`);
        return true;
    }
    synchronizeGroundedState(bot);
    return false;
}

async function moveNear(bot, position, range = 2, timeoutMs = 20000) {
    if (bot.entity?.position?.distanceTo(position) <= range) return;
    const goal = new goals.GoalNear(position.x, position.y, position.z, range);
    await navigate(bot, goal, position, timeoutMs, 'Timed out walking to target');
}

async function followPlayer(bot, username, options = {}) {
    const range = Math.max(2, Math.min(8, Number(options.range || 3)));
    const durationMs = Math.max(500, Math.min(5000, Number(options.durationMs || 1800)));
    const player = bot.players?.[username]?.entity;
    if (!player?.position) return { status: 'target_unavailable', username };
    const actionVersion = Number(bot.sorimActionVersion || 0);
    const distance = bot.entity?.position?.distanceTo(player.position) ?? Infinity;
    if (distance <= range) {
        stop(bot);
        await sleep(Math.min(durationMs, 600));
        return { status: 'near', username, distance };
    }

    const navigationVersion = beginNavigation(bot);
    markMovementIntent(bot, 'follow', player.position);
    const goal = new goals.GoalFollow(player, range);
    bot.pathfinder.setGoal(goal, true);
    const deadline = Date.now() + durationMs;
    try {
        while (Date.now() < deadline) {
            assertActionVersion(bot, actionVersion);
            const current = bot.players?.[username]?.entity;
            if (!current?.position) return { status: 'target_lost', username };
            await sleep(150);
        }
        const finalTarget = bot.players?.[username]?.entity;
        const finalDistance = finalTarget?.position && bot.entity?.position
            ? bot.entity.position.distanceTo(finalTarget.position) : Infinity;
        return { status: 'tracking', username, distance: finalDistance };
    } finally {
        clearMovementIntent(bot);
        stopNavigation(bot, navigationVersion);
    }
}

async function moveBlock(bot, position, timeoutMs = 12000) {
    if (bot.entity?.position?.floored?.().equals(position)) return;
    const goal = new goals.GoalBlock(position.x, position.y, position.z);
    await navigate(bot, goal, position, timeoutMs, 'Timed out walking to block target');
}

async function moveNearXZ(bot, position, range = 2, timeoutMs = 10000) {
    const dx = bot.entity.position.x - position.x;
    const dz = bot.entity.position.z - position.z;
    if (Math.hypot(dx, dz) <= range) return;
    const goal = new goals.GoalNearXZ(position.x, position.z, range);
    await navigate(bot, goal, position, timeoutMs, 'Timed out walking toward horizontal target');
}

async function moveOutOfWater(bot, position, timeoutMs = 7000) {
    const goal = new goals.GoalBlock(position.x, position.y, position.z);
    const version = beginNavigation(bot);
    markMovementIntent(bot, 'water-exit', position);
    try {
        await withNavigationWatchdog(
            bot,
            bot.pathfinder.goto(goal),
            timeoutMs,
            'Timed out swimming to dry ground',
            2600
        );
        return true;
    } finally {
        clearMovementIntent(bot);
        stopNavigation(bot, version);
    }
}

async function centerInCurrentCell(bot, timeoutMs = 900) {
    const cell = bot.entity.position.floored();
    const target = cell.offset(0.5, 0, 0.5);
    const deadline = Date.now() + timeoutMs;
    bot.clearControlStates();
    markMovementIntent(bot, 'center-cell', target);
    try {
        while (Date.now() < deadline) {
            const dx = target.x - bot.entity.position.x;
            const dz = target.z - bot.entity.position.z;
            const distance = Math.hypot(dx, dz);
            if (distance <= 0.14) return true;
            await bot.look(Math.atan2(-dx, -dz), 0, true);
            bot.setControlState('forward', true);
            await sleep(50);
        }
    } finally {
        bot.clearControlStates();
        clearMovementIntent(bot);
    }
    return horizontalDistance(bot.entity.position, target) <= 0.22;
}

async function navigate(bot, goal, target, timeoutMs, timeoutMessage) {
    markMovementIntent(bot, 'pathfinder', target);
    let lastError = null;
    const startedAt = Date.now();
    const actionVersion = Number(bot.sorimActionVersion || 0);
    for (let attempt = 0; attempt < 3; attempt++) {
        assertActionVersion(bot, actionVersion);
        const remaining = timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        const attemptBudget = Math.min(
            remaining,
            Math.max(2200, Math.min(5000, remaining / Math.max(1, 3 - attempt)))
        );
        const version = beginNavigation(bot);
        try {
            await withNavigationWatchdog(
                bot,
                bot.pathfinder.goto(goal),
                attemptBudget,
                timeoutMessage
            );
            clearMovementIntent(bot);
            return;
        } catch (error) {
            lastError = error;
            stopNavigation(bot, version);
            assertActionVersion(bot, actionVersion);
            const obstacle = frontObstacle(bot, target);
            console.log(
                `[MOVE] path attempt=${attempt + 1} stopped reason=${error.message} ` +
                `position=${bot.entity.position.floored().toString()} obstacle=${obstacle}`
            );
            if (attempt >= 2) break;
            if (obstacle === 'step' || obstacle === 'clear') {
                const locallyReached = await advanceLocallyToGoal(
                    bot,
                    goal,
                    target,
                    Math.min(6500, remaining),
                    actionVersion
                );
                if (locallyReached) {
                    clearMovementIntent(bot);
                    return;
                }
                if (horizontalDistance(bot.entity.position, target) < 2.5) continue;
            }
            break;
        }
    }
    stop(bot);
    clearMovementIntent(bot);
    throw lastError || new Error(timeoutMessage);
}

async function advanceLocallyToGoal(bot, goal, target, budgetMs, actionVersion) {
    const deadline = Date.now() + Math.max(500, budgetMs);
    let previousDistance = horizontalDistance(bot.entity.position, target);
    while (Date.now() < deadline) {
        assertActionVersion(bot, actionVersion);
        const current = bot.entity.position.floored();
        if (goal.isEnd(current) || goal.isEnd(current.offset(0, 1, 0))) return true;
        const obstacle = frontObstacle(bot, target);
        let moved = false;
        if (obstacle === 'step') moved = await stepUpToward(bot, target);
        else if (obstacle === 'clear') moved = await walkToward(bot, target, { durationMs: 850 });
        else return false;
        if (!moved) return false;
        const distance = horizontalDistance(bot.entity.position, target);
        console.log(
            `[MOVE] local traversal obstacle=${obstacle} ` +
            `distance=${previousDistance.toFixed(2)}->${distance.toFixed(2)} ` +
            `position=${bot.entity.position.toString()}`
        );
        if (distance >= previousDistance - 0.15) return false;
        previousDistance = distance;
    }
    const current = bot.entity.position.floored();
    return goal.isEnd(current) || goal.isEnd(current.offset(0, 1, 0));
}

function assertActionVersion(bot, expected) {
    if (Number(bot.sorimActionVersion || 0) !== expected) {
        stop(bot);
        throw new Error(`Action cancelled: ${bot.sorimCancelReason || 'safety override'}`);
    }
}

function beginNavigation(bot) {
    stop(bot);
    const version = (navigationVersions.get(bot) || 0) + 1;
    navigationVersions.set(bot, version);
    return version;
}

function stopNavigation(bot, version) {
    if (navigationVersions.get(bot) !== version) return;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
}

async function explore(bot, action = {}) {
    const target = action.target || 'around';
    const isActive = typeof action.isActive === 'function' ? action.isActive : null;
    const stopWhen = typeof action.stopWhen === 'function'
        ? action.stopWhen
        : explorationTargetSensor(bot, target);
    const abortWhen = typeof action.abortWhen === 'function' ? action.abortWhen : null;
    const initiallyVisible = stopWhen ? stopWhen() : null;
    if (initiallyVisible) {
        stop(bot);
        console.log(`[MOVE] Exploration target already visible: ${target}.`);
        return { found: initiallyVisible, reached: false, initiallyVisible: true };
    }
    if (typeof bot.blockAt === 'function') {
        await descendFromCanopy(bot, 28, isActive);
        if (isActive && !isActive()) {
            return { found: null, reached: false, recovered: false, cancelled: true };
        }
    }
    const origin = bot.entity.position.clone();
    const position = selectExplorationWaypoint(bot, target);

    console.log(`[MOVE] Exploring target=${target} x=${position.x} z=${position.z}`);
    let scanTimer = null;
    try {
        // Split mountain descents across attempts so a distant resource cannot
        // pull the bot through a dangerous vertical route.
        const verticalAllowance = target === 'stone' ? 8 : 12;
        const goal = target === 'wood' || target === 'food'
            ? new goals.GoalXZ(position.x, position.z)
            : new goals.GoalNear(position.x, position.y, position.z, 3);
        markMovementIntent(bot, 'explore', position);
        const navigation = withNavigationWatchdog(
            bot,
            bot.pathfinder.goto(goal),
            target === 'wood' ? 20000 : 18000,
            'Exploration path stalled',
            900
        )
            .then(() => ({ type: 'reached' }));
        const candidates = [navigation];
        if (stopWhen) {
            candidates.push(new Promise(resolve => {
                const scan = () => {
                    let found = null;
                    try {
                        found = stopWhen();
                    } catch {
                        return;
                    }
                    if (found) resolve({ type: 'found', value: found });
                };
                scan();
                scanTimer = setInterval(scan, 1000);
            }));
        }
        const outcome = await withTimeout(
            withExplorationGuard(
                bot,
                Promise.race(candidates),
                origin.y - verticalAllowance,
                origin.y + verticalAllowance,
                abortWhen
            ),
            target === 'wood' ? 20000 : 18000,
            'Exploration timed out'
        );
        if (outcome?.type === 'found') {
            stop(bot);
            completeExplorationWaypoint(bot, target);
            console.log(`[MOVE] Exploration found ${target} while walking.`);
            return { found: outcome.value, reached: false };
        }
        completeExplorationWaypoint(bot, target);
        return { found: null, reached: true };
    } catch (error) {
        stop(bot);
        console.log(`[MOVE] Exploration could not complete: ${error.message}`);
        if (error.code === 'EXPLORATION_ABORTED') {
            return { found: null, reached: false, recovered: false, guarded: true, error };
        }
        if (isActive && !isActive()) {
            return { found: null, reached: false, recovered: false, cancelled: true, error };
        }
        if (target === 'wood' || target === 'food') {
            const before = bot.entity.position.clone();
            const localProgress = await moveTowardSafely(bot, position, 16, isActive, abortWhen);
            if (isActive && !isActive()) {
                return { found: null, reached: false, recovered: false, cancelled: true, error };
            }
            const found = stopWhen ? stopWhen() : null;
            if (found) {
                completeExplorationWaypoint(bot, target);
                console.log(`[MOVE] Local traversal found ${target}.`);
                return { found, reached: false, recovered: true };
            }
            let moved = bot.entity.position.distanceTo(before);
            if (!localProgress && moved < 1) {
                const escaped = await escapeLocalDeadEnd(bot, isActive, abortWhen);
                if (escaped) moved = bot.entity.position.distanceTo(before);
            }
            if (moved >= 1) {
                completeExplorationWaypoint(bot, target);
                console.log(`[MOVE] Local traversal advanced ${moved.toFixed(1)} blocks.`);
                return { found: null, reached: false, recovered: true, error };
            }
            noteExplorationProgress(bot, target, false);
        }
        return { found: null, reached: false, recovered: false, error };
    } finally {
        clearMovementIntent(bot);
        if (scanTimer) clearInterval(scanTimer);
    }
}

function explorationTargetSensor(bot, target) {
    if (target === 'wood') {
        return () => bot.findBlock?.({
            matching: block => Boolean(
                block?.name?.endsWith('_log') &&
                !hasWaterBarrier(bot, block.position)
            ),
            maxDistance: 72
        }) || null;
    }
    if (target === 'food') {
        const foodMobs = new Set(['cow', 'pig', 'sheep', 'chicken', 'rabbit']);
        return () => Object.values(bot.entities || {})
            .filter(entity => foodMobs.has(String(entity.name || '').toLowerCase()))
            .filter(entity => entity.position?.distanceTo(bot.entity.position) <= 48)
            .filter(entity => !hasWaterBarrier(bot, entity.position))
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) -
                right.position.distanceTo(bot.entity.position)
            )[0] || bot.findBlock?.({
                matching: block => Boolean(
                    block &&
                    !hasWaterBarrier(bot, block.position) &&
                    (
                        block.name === 'melon' ||
                        (
                            block.name === 'sweet_berry_bush' &&
                            Number(block.getProperties?.().age || 0) >= 2
                        )
                    )
                ),
                maxDistance: 32
            }) || null;
    }
    if (target === 'stone') {
        return () => bot.findBlock?.({
            matching: block => ['stone', 'coal_ore', 'deepslate'].includes(block?.name),
            maxDistance: 16
        }) || null;
    }
    if (target === 'water') {
        return () => bot.findBlock?.({
            matching: block => block?.name === 'water',
            maxDistance: 48
        }) || null;
    }
    return null;
}

function hasWaterBarrier(bot, target) {
    if (!bot.entity?.position || !target || typeof bot.blockAt !== 'function') return false;
    const origin = bot.entity.position;
    const distance = horizontalDistance(origin, target);
    const samples = Math.max(1, Math.ceil(distance));
    for (let index = 1; index <= samples; index++) {
        const ratio = index / samples;
        const x = Math.floor(origin.x + (target.x - origin.x) * ratio);
        const z = Math.floor(origin.z + (target.z - origin.z) * ratio);
        const expectedY = Math.round(origin.y + (target.y - origin.y) * ratio);
        for (const yOffset of [0, -1]) {
            const block = bot.blockAt(new Vec3(x, expectedY + yOffset, z));
            if (['water', 'bubble_column', 'lava'].includes(block?.name)) return true;
        }
    }
    return false;
}

function selectExplorationWaypoint(bot, target) {
    const sessions = explorationSessions.get(bot) || new Map();
    explorationSessions.set(bot, sessions);
    let session = sessions.get(target);
    if (!session) {
        session = {
            anchor: bot.entity.position.floored(),
            nextIndex: 0,
            active: null,
            failures: 0
        };
        sessions.set(target, session);
    }
    if (session.active) return session.active.clone();

    const visited = memory.getExploredCells(target);
    for (let attempts = 0; attempts < 512; attempts++) {
        const grid = squareSpiralCell(session.nextIndex++);
        const spacing = explorationSpacing(target);
        const candidate = new Vec3(
            session.anchor.x + grid.x * spacing,
            session.anchor.y,
            session.anchor.z + grid.z * spacing
        );
        if (visited.some(cell => horizontalDistance(cell, candidate) < spacing * 0.6)) continue;
        if ((target === 'wood' || target === 'food') && hasWaterBarrier(bot, candidate)) continue;
        session.active = candidate;
        session.failures = 0;
        return candidate.clone();
    }
    session.anchor = bot.entity.position.floored();
    session.nextIndex = 0;
    session.active = null;
    return selectExplorationWaypoint(bot, target);
}

function completeExplorationWaypoint(bot, target) {
    const session = explorationSessions.get(bot)?.get(target);
    if (!session?.active) return;
    memory.rememberExploredCell(target, session.active);
    session.active = null;
    session.failures = 0;
}

function noteExplorationProgress(bot, target, progressed) {
    const session = explorationSessions.get(bot)?.get(target);
    if (!session?.active) return;
    if (progressed) {
        session.failures = 0;
        return;
    }
    session.failures++;
    if (session.failures >= 2) completeExplorationWaypoint(bot, target);
}

function explorationSpacing(target) {
    if (target === 'stone') return 16;
    if (target === 'food') return 20;
    if (target === 'wood') return 72;
    return 24;
}

function squareSpiralCell(index) {
    let cursor = 0;
    for (let ring = 1; ring < 1024; ring++) {
        const cells = [];
        for (let z = 1 - ring; z <= ring; z++) cells.push({ x: ring, z });
        for (let x = ring - 1; x >= -ring; x--) cells.push({ x, z: ring });
        for (let z = ring - 1; z >= -ring; z--) cells.push({ x: -ring, z });
        for (let x = -ring + 1; x <= ring; x++) cells.push({ x, z: -ring });
        if (index < cursor + cells.length) return cells[index - cursor];
        cursor += cells.length;
    }
    return { x: 1, z: 0 };
}

function withExplorationGuard(bot, navigation, minimumY, maximumY, abortWhen = null) {
    let timer = null;
    const guard = new Promise((_, reject) => {
        timer = setInterval(() => {
            const y = bot.entity?.position?.y;
            if (Number.isFinite(y) && (y < minimumY || y > maximumY)) {
                stop(bot);
                reject(new Error(`Exploration left safe Y range (${y.toFixed(1)})`));
                return;
            }
            const abortReason = abortWhen?.();
            if (!abortReason) return;
            stop(bot);
            const error = new Error(
                typeof abortReason === 'string' ? abortReason : 'Exploration entered a protected area'
            );
            error.code = 'EXPLORATION_ABORTED';
            reject(error);
        }, 100);
    });
    return Promise.race([navigation, guard])
        .finally(() => clearInterval(timer));
}

async function manualNudge(bot, durationMs = 1200) {
    const yaw = bot.entity.yaw;
    const target = bot.entity.position.offset(-Math.sin(yaw) * 2, 0, -Math.cos(yaw) * 2);
    if (await stepUpToward(bot, target)) return true;
    return walkToward(bot, target, { durationMs: Math.min(durationMs, 900) });
}

async function moveTowardDirectly(bot, position, durationMs = 2200) {
    if (await stepUpToward(bot, position)) return true;
    return walkToward(bot, position, { durationMs });
}

async function walkToward(bot, position, options = {}) {
    const durationMs = Math.max(100, Math.min(Number(options.durationMs || 900), 2200));
    const arrivalRange = Math.max(0.18, Number(options.arrivalRange || 0.35));
    const aim = targetAimPoint(position);
    const initialDirection = horizontalUnitToward(bot, position);
    const origin = bot.entity.position.clone();
    const deadline = Date.now() + durationMs;
    let stopReason = 'duration';
    stop(bot);
    markMovementIntent(bot, 'manual-walk', position);
    try {
        if (bodyIntersectsSolid(bot)) {
            stopReason = 'body-contact';
            await releaseWallContact(bot, position);
        }
        let progressPosition = bot.entity.position.clone();
        let lastProgressAt = Date.now();
        while (Date.now() < deadline) {
            const descendingTarget = Number.isFinite(position.y) &&
                position.y < bot.entity.position.y - 0.45;
            const effectiveArrivalRange = descendingTarget
                ? Math.min(arrivalRange, 0.12)
                : arrivalRange;
            const remainingAlongPath = initialDirection
                ? (aim.x - bot.entity.position.x) * initialDirection.x +
                    (aim.z - bot.entity.position.z) * initialDirection.z
                : 0;
            const crossedTargetPlane = remainingAlongPath <= 0;
            if ((horizontalDistance(bot.entity.position, aim) <= effectiveArrivalRange || crossedTargetPlane) &&
                (!Number.isFinite(position.y) || position.y <= bot.entity.position.y + 0.25)) {
                bot.clearControlStates();
                if (descendingTarget) await waitForStableGround(bot, 700);
                const verticalReached = !Number.isFinite(position.y) ||
                    Math.abs(bot.entity.position.y - position.y) <= 0.2;
                stopReason = verticalReached ? 'reached' : 'vertical-blocked';
                break;
            }
            if (isSuspendedAgainstWall(bot)) {
                stopReason = 'suspended';
                bot.clearControlStates();
                await sleep(300);
                break;
            }
            const contact = contactObstacle(bot, position);
            const obstacle = contact.type;
            if (isUnsafeFrontDrop(bot, position)) {
                stopReason = 'unsafe-drop';
                break;
            }
            if (isLiquidAhead(bot, position)) {
                stopReason = 'unsafe-liquid';
                break;
            }
            if (obstacle === 'wall') {
                stopReason = `wall:${contact.position?.toString() || 'unknown'}:${contact.blockName || 'unknown'}`;
                break;
            }
            if (obstacle === 'step') {
                stopReason = await stepUpToward(bot, position) ? 'climbed-step' : 'failed-step';
                break;
            }
            await bot.lookAt(targetAimPoint(position).offset(0, 0.5, 0), true);
            bot.setControlState('forward', true);
            bot.setControlState('sprint', false);
            bot.setControlState('jump', false);
            await sleep(100);
            if (bot.entity.position.distanceTo(progressPosition) >= 0.12) {
                progressPosition = bot.entity.position.clone();
                lastProgressAt = Date.now();
            } else if (Date.now() - lastProgressAt >= 450) {
                stopReason = 'stalled';
                bot.clearControlStates();
                break;
            }
        }
    } finally {
        clearMovementIntent(bot);
        stop(bot);
    }
    if (!bot.entity.onGround) await waitForStableGround(bot, 700);
    const moved = bot.entity.position.distanceTo(origin);
    console.log(
        `[MOVE] walk result reason=${stopReason} moved=${moved.toFixed(2)} ` +
        `from=${origin.toString()} to=${bot.entity.position.toString()}`
    );
    return moved >= 0.6;
}

function isLiquidAhead(bot, target) {
    const direction = horizontalUnitToward(bot, target);
    if (!direction) return false;
    const x = Math.floor(bot.entity.position.x + direction.x * 0.7);
    const z = Math.floor(bot.entity.position.z + direction.z * 0.7);
    const y = bot.entity.position.floored().y;
    return [0, -1].some(yOffset => {
        const block = bot.blockAt(new Vec3(x, y + yOffset, z));
        return ['water', 'bubble_column', 'lava'].includes(block?.name);
    });
}

async function waitForStableGround(bot, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const velocityY = Math.abs(bot.entity.velocity?.y || 0);
        const closeToLevel = Math.abs(bot.entity.position.y - Math.round(bot.entity.position.y)) <= 0.08;
        if (velocityY <= 0.08 && closeToLevel && hasGroundSupport(bot)) {
            synchronizeGroundedState(bot);
            return true;
        }
        await sleep(50);
    }
    return false;
}

async function stepUpToward(bot, position) {
    let contact = contactObstacle(bot, position);
    if (contact.type !== 'step' || !contact.position) return false;
    const initialContact = contact;
    let top = contact.position.offset(0, 1, 0);
    let reachedJumpHeight = false;
    let crossedOntoStep = false;
    stop(bot);
    try {
        // A player pressed directly against a full block cannot gain horizontal
        // momentum before the jump clears its top edge. Create a small run-up
        // so diagonal and hillside jumps behave like ordinary player input.
        await bot.lookAt(top.offset(0.5, 0.7, 0.5), true);
        bot.setControlState('back', true);
        await sleep(140);
        stop(bot);
        contact = contactObstacle(bot, position);
        if (contact.type !== 'step' || !contact.position) contact = initialContact;
        top = contact.position.offset(0, 1, 0);
        const origin = bot.entity.position.clone();
        synchronizeGroundedState(bot);
        await bot.lookAt(top.offset(0.5, 0.7, 0.5), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', true);
        const deadline = Date.now() + 1050;
        while (Date.now() < deadline) {
            const nowAtJumpHeight = bot.entity.position.y >= origin.y + 0.55;
            if (nowAtJumpHeight && !reachedJumpHeight) {
                reachedJumpHeight = true;
                bot.setControlState('jump', false);
            }
            const topCenter = top.offset(0.5, 0, 0.5);
            crossedOntoStep = reachedJumpHeight &&
                bot.entity.position.y >= top.y - 0.08 &&
                Math.abs(bot.entity.position.x - topCenter.x) <= 0.72 &&
                Math.abs(bot.entity.position.z - topCenter.z) <= 0.72;
            if (crossedOntoStep) break;
            await sleep(50);
        }
        stop(bot);
        let stable = await waitForStableGround(bot, 1200);
        if (!stable && bot.entity.position.y >= origin.y + 0.7) {
            bot.setControlState('forward', true);
            await sleep(300);
            stop(bot);
            stable = await waitForStableGround(bot, 1400);
        }
        if (!stable) {
            await releaseWallContact(bot, position);
            stable = await waitForStableGround(bot, 1400);
        }
        const landedHigher = stable &&
            bot.entity.position.y >= origin.y + 0.75 &&
            hasGroundSupport(bot);
        const climbed = reachedJumpHeight && (landedHigher || (
            crossedOntoStep && Math.abs(bot.entity.position.y - top.y) <= 0.12
        ));
        console.log(
            `[MOVE] step result climbed=${climbed} block=${contact.position.toString()} ` +
            `from=${origin.toString()} to=${bot.entity.position.toString()}`
        );
        return climbed;
    } finally {
        stop(bot);
    }
}

async function waitForStepLanding(bot, expectedY, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const velocityY = Math.abs(bot.entity.velocity?.y || 0);
        const settledHeight = Math.abs(bot.entity.position.y - expectedY) <= 0.08;
        if (settledHeight && velocityY <= 0.08) {
            synchronizeGroundedState(bot);
            return true;
        }
        const settledElsewhere = velocityY <= 0.08 &&
            Math.abs(bot.entity.position.y - Math.round(bot.entity.position.y)) <= 0.08;
        if (settledElsewhere && Math.abs(bot.entity.position.y - expectedY) > 0.2) {
            return false;
        }
        await sleep(50);
    }
    return false;
}

function synchronizeGroundedState(bot) {
    const position = bot.entity.position;
    const feet = bot.blockAt(position.floored());
    if (
        bot.entity.isInWater ||
        ['water', 'bubble_column', 'lava'].includes(feet?.name)
    ) {
        bot.entity.onGround = false;
        return;
    }
    const floor = bot.blockAt(position.floored().offset(0, -1, 0));
    const verticalVelocity = Math.abs(bot.entity.velocity?.y || 0);
    const closeToBlockTop = Math.abs(position.y - Math.round(position.y)) <= 0.08;
    if (isSolid(floor) && verticalVelocity <= 0.08 && closeToBlockTop) {
        bot.entity.onGround = true;
    }
}

function frontObstacle(bot, target = null) {
    return contactObstacle(bot, target).type;
}

function horizontalUnitToward(bot, target) {
    let dx;
    let dz;
    if (target && Number.isFinite(target.x) && Number.isFinite(target.z)) {
        const aim = targetAimPoint(target);
        dx = aim.x - bot.entity.position.x;
        dz = aim.z - bot.entity.position.z;
    } else {
        dx = -Math.sin(bot.entity.yaw);
        dz = -Math.cos(bot.entity.yaw);
    }
    if (Math.abs(dx) < 0.05 && Math.abs(dz) < 0.05) return null;
    const length = Math.hypot(dx, dz);
    return { x: dx / length, z: dz / length };
}

function targetAimPoint(target) {
    return new Vec3(
        Number.isInteger(target.x) ? target.x + 0.5 : target.x,
        Number.isInteger(target.y) ? target.y + 0.5 : target.y,
        Number.isInteger(target.z) ? target.z + 0.5 : target.z
    );
}

function contactObstacle(bot, target) {
    const direction = horizontalUnitToward(bot, target);
    if (!direction) return { type: 'clear', position: null };
    const y = bot.entity.position.floored().y;
    const seen = new Set();
    for (const distance of [0.32, 0.5, 0.72, 0.92, 1.08]) {
        const centerX = bot.entity.position.x + direction.x * distance;
        const centerZ = bot.entity.position.z + direction.z * distance;
        const cells = collisionCells(centerX, centerZ);
        let step = null;
        for (const [x, z] of cells) {
            const relativeX = x + 0.5 - bot.entity.position.x;
            const relativeZ = z + 0.5 - bot.entity.position.z;
            const forward = relativeX * direction.x + relativeZ * direction.z;
            const lateral = Math.abs(relativeX * direction.z - relativeZ * direction.x);
            if (forward <= 0.05 || lateral > 0.72) continue;
            const key = `${x},${z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const position = new Vec3(x, y, z);
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            if (isPassable(feet) && isPassable(head)) continue;
            const above = bot.blockAt(position.offset(0, 2, 0));
            if (isFullStep(feet) && isPassable(head) && isPassable(above)) {
                step ||= position;
                continue;
            }
            return { type: 'wall', position, blockName: !isPassable(head) ? head.name : feet.name };
        }
        if (step) return { type: 'step', position: step };
    }
    return { type: 'clear', position: null };
}

function collisionCells(centerX, centerZ) {
    const radius = 0.3;
    const result = [];
    for (let x = Math.floor(centerX - radius); x <= Math.floor(centerX + radius); x++) {
        for (let z = Math.floor(centerZ - radius); z <= Math.floor(centerZ + radius); z++) {
            result.push([x, z]);
        }
    }
    return result;
}

function isFullStep(block) {
    if (!isSolid(block)) return false;
    if (!Array.isArray(block.shapes) || block.shapes.length === 0) return true;
    const maximumHeight = Math.max(...block.shapes.map(shape => Number(shape[4] || 0)));
    return maximumHeight <= 1.01;
}

async function moveTowardSafely(bot, target, maxSteps = 12, isActive = null, abortWhen = null) {
    const startDistance = localTargetDistance(bot.entity.position, target);
    await centerForLocalRoute(bot);
    const route = findLocalRoute(bot, bot.entity.position.floored(), target, 20, 1600)
        .slice(0, maxSteps);
    for (const next of route) {
        if (isActive && !isActive()) {
            stop(bot);
            return false;
        }
        if (abortWhen?.()) {
            stop(bot);
            return false;
        }
        const current = bot.entity.position.floored();
        if (isNearLocalTarget(current, target)) return true;
        const before = bot.entity.position.clone();
        const moved = next.y > current.y
            ? await stepUpToward(bot, next)
            : await walkToward(bot, next, { durationMs: 1100 });
        if (!moved || bot.entity.position.distanceTo(before) < 0.45) {
            const detoured = await sidestepAroundLocalObstacle(bot, target, next);
            if (!detoured) break;
        }
    }
    return localTargetDistance(bot.entity.position, target) <= startDistance - 2;
}

async function sidestepAroundLocalObstacle(bot, target, blockedStep) {
    const before = bot.entity.position.clone();
    const candidates = localDetourCandidates(bot, target, blockedStep).slice(0, 4);
    for (const candidate of candidates) {
        const attemptOrigin = bot.entity.position.clone();
        const moved = await walkToward(bot, candidate, { durationMs: 900 });
        if (moved && bot.entity.position.distanceTo(attemptOrigin) >= 0.55) {
            console.log(`[MOVE] local detour escaped blocked step via ${candidate.toString()}`);
            return true;
        }
    }
    return bot.entity.position.distanceTo(before) >= 0.55;
}

async function escapeLocalDeadEnd(bot, isActive = null, abortWhen = null) {
    const origin = bot.entity.position.clone();
    for (const candidate of localEscapeCandidates(bot)) {
        if ((isActive && !isActive()) || abortWhen?.()) {
            stop(bot);
            return false;
        }
        const attemptOrigin = bot.entity.position.clone();
        const moved = candidate.y > attemptOrigin.floored().y
            ? await stepUpToward(bot, candidate)
            : await walkToward(bot, candidate, { durationMs: 1000 });
        if (moved && bot.entity.position.distanceTo(attemptOrigin) >= 0.55) {
            console.log(`[MOVE] escaped local dead end via ${candidate.toString()}`);
            return bot.entity.position.distanceTo(origin) >= 0.55;
        }
    }
    const carved = await carveSoftEscapeStep(bot, isActive, abortWhen);
    if (carved) {
        const moved = await walkToward(bot, carved, { durationMs: 1200 });
        if (moved && bot.entity.position.distanceTo(origin) >= 0.55) {
            console.log(`[MOVE] escaped local dead end through soft terrain ${carved.toString()}`);
            return true;
        }
    }
    return false;
}

async function carveSoftEscapeStep(bot, isActive = null, abortWhen = null) {
    const origin = bot.entity.position.floored();
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const softTerrain = new Set([
        'dirt', 'grass_block', 'coarse_dirt', 'rooted_dirt', 'podzol',
        'sand', 'red_sand', 'gravel', 'clay', 'snow', 'snow_block'
    ]);
    for (const [dx, dz] of directions) {
        if ((isActive && !isActive()) || abortWhen?.()) return null;
        const target = origin.offset(dx, 0, dz);
        const opened = await clearStepToward(
            bot,
            target,
            1,
            block => softTerrain.has(block.name)
        );
        if (opened) return opened;
    }
    return null;
}

function localEscapeCandidates(bot) {
    const origin = bot.entity.position.floored();
    return localWalkableSteps(bot, origin)
        .filter(position => position.y >= origin.y - 1 && position.y <= origin.y + 1)
        .sort((left, right) =>
            localClearanceScore(bot, right) - localClearanceScore(bot, left) ||
            Math.abs(left.y - origin.y) - Math.abs(right.y - origin.y)
        );
}

function localClearanceScore(bot, position) {
    const directions = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    return directions.reduce((score, [dx, dz]) => {
        const feet = position.offset(dx, 0, dz);
        return score + (
            isPassable(bot.blockAt(feet)) &&
            isPassable(bot.blockAt(feet.offset(0, 1, 0)))
                ? 1
                : 0
        );
    }, 0);
}

function localDetourCandidates(bot, target, blockedStep = null) {
    const origin = bot.entity.position.floored();
    return localWalkableSteps(bot, origin)
        .filter(position => position.y >= origin.y - 1 && position.y <= origin.y)
        .filter(position => !blockedStep || !position.equals(blockedStep))
        .sort((left, right) => {
            const leftCost = localTargetDistance(left, target) + detourBacktrackPenalty(origin, left, target);
            const rightCost = localTargetDistance(right, target) + detourBacktrackPenalty(origin, right, target);
            return leftCost - rightCost;
        });
}

function detourBacktrackPenalty(origin, candidate, target) {
    const targetX = target.x - origin.x;
    const targetZ = target.z - origin.z;
    const stepX = candidate.x - origin.x;
    const stepZ = candidate.z - origin.z;
    return targetX * stepX + targetZ * stepZ < 0 ? 3 : 0;
}

async function centerForLocalRoute(bot) {
    const cell = bot.entity.position.floored();
    const center = cell.offset(0.5, 0, 0.5);
    const offset = horizontalDistance(bot.entity.position, center);
    if (offset < 0.16 && !bodyIntersectsSolid(bot)) return;

    const feet = bot.blockAt(cell);
    const head = bot.blockAt(cell.offset(0, 1, 0));
    const floor = bot.blockAt(cell.offset(0, -1, 0));
    if (!isPassable(feet) || !isPassable(head) || !isSolid(floor)) return;

    const before = bot.entity.position.clone();
    await walkToward(bot, center, { durationMs: 650, arrivalRange: 0.12 });
    if (horizontalDistance(before, bot.entity.position) >= 0.12) {
        console.log(`[MOVE] centered local route origin ${cell.toString()}`);
    }
}

async function descendFromCanopy(bot, maxSteps = 28, isActive = null) {
    const origin = bot.entity.position.floored();
    const support = bot.blockAt(origin.offset(0, -1, 0));
    const canopySupport = support?.name?.endsWith('_leaves') ||
        support?.name?.endsWith('_log') || support?.name?.endsWith('_wood');
    if (!canopySupport) return false;

    const route = (await findCanopyExitRoute(bot, origin, 12, 300)).slice(0, maxSteps);
    if (route.length === 0) {
        console.log(`[MOVE] no safe canopy descent found support=${support.name}`);
        return carveLeafDescent(bot, origin, isActive);
    }
    console.log(`[MOVE] canopy descent route steps=${route.length}`);
    for (const next of route) {
        if (isActive && !isActive()) {
            stop(bot);
            return false;
        }
        const current = bot.entity.position.floored();
        const moved = next.y > current.y
            ? await stepUpToward(bot, next)
            : await walkToward(bot, next, { durationMs: 1200 });
        if (!moved) break;
        const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
        if (floor?.boundingBox === 'block' && !floor.name.endsWith('_leaves')) {
            console.log(`[MOVE] descended from canopy to ${bot.entity.position.floored().toString()}`);
            return true;
        }
    }
    return false;
}

async function carveLeafDescent(bot, origin, isActive) {
    const landing = findNonLeafLanding(bot, origin, 8);
    if (!landing) return false;
    console.log(`[MOVE] controlled leaf descent landingY=${landing.y}`);
    for (let layer = 0; layer < 8 && bot.entity.position.y > landing.y + 1.1; layer++) {
        if (isActive && !isActive()) return false;
        const feet = bot.entity.position.floored();
        const support = bot.blockAt(feet.offset(0, -1, 0));
        if (!support?.name?.endsWith('_leaves') || !bot.canDigBlock?.(support)) break;
        await bot.lookAt(support.position.offset(0.5, 0.5, 0.5), true);
        await withTimeout(bot.dig(support), 8000, 'Timed out opening canopy descent');
        const beforeY = bot.entity.position.y;
        const deadline = Date.now() + 4500;
        while (Date.now() < deadline && bot.entity.position.y >= beforeY - 0.7) {
            await sleep(50);
        }
        while (Date.now() < deadline && !bot.entity.onGround) await sleep(50);
        await sleep(200);
    }
    const floor = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
    const descended = bot.entity.position.y <= origin.y - 1 &&
        floor?.boundingBox === 'block' && !floor.name.endsWith('_leaves');
    if (descended) console.log(`[MOVE] descended through canopy to ${bot.entity.position.floored().toString()}`);
    return descended;
}

function findNonLeafLanding(bot, origin, maxDepth) {
    for (let depth = 2; depth <= maxDepth; depth++) {
        const block = bot.blockAt(origin.offset(0, -depth, 0));
        if (!block || ['water', 'lava', 'powder_snow'].includes(block.name)) return null;
        if (block.boundingBox !== 'block' || block.name.endsWith('_leaves')) continue;
        return block.position;
    }
    return null;
}

async function findCanopyExitRoute(bot, origin, radius, maxNodes) {
    const originKey = origin.toString();
    const queue = [origin];
    const parents = new Map([[originKey, null]]);
    const positions = new Map([[originKey, origin]]);
    let cursor = 0;
    let exit = null;

    while (cursor < queue.length && positions.size < maxNodes) {
        if (cursor > 0 && cursor % 50 === 0) await new Promise(resolve => setImmediate(resolve));
        const current = queue[cursor++];
        const floor = bot.blockAt(current.offset(0, -1, 0));
        if (
            current.y <= origin.y - 2 &&
            floor?.boundingBox === 'block' &&
            !floor.name.endsWith('_leaves')
        ) {
            exit = current;
            break;
        }
        for (const next of localWalkableSteps(bot, current)) {
            if (horizontalDistance(next, origin) > radius) continue;
            if (Math.abs(next.y - origin.y) > 12) continue;
            const key = next.toString();
            if (parents.has(key)) continue;
            parents.set(key, current.toString());
            positions.set(key, next);
            queue.push(next);
        }
    }
    if (!exit) return [];
    const route = [];
    let key = exit.toString();
    while (key && key !== originKey) {
        route.push(positions.get(key));
        key = parents.get(key);
    }
    return route.reverse();
}

function findLocalRoute(bot, origin, target, radius, maxNodes) {
    const originKey = origin.toString();
    const queue = [origin];
    const parents = new Map([[originKey, null]]);
    const positions = new Map([[originKey, origin]]);
    let cursor = 0;
    let best = origin;

    while (cursor < queue.length && positions.size < maxNodes) {
        const current = queue[cursor++];
        if (localTargetDistance(current, target) < localTargetDistance(best, target)) best = current;
        if (isNearLocalTarget(current, target)) {
            best = current;
            break;
        }
        for (const next of localWalkableSteps(bot, current)) {
            if (horizontalDistance(next, origin) > radius) continue;
            if (Math.abs(next.y - origin.y) > 8) continue;
            const key = next.toString();
            if (parents.has(key)) continue;
            parents.set(key, current.toString());
            positions.set(key, next);
            queue.push(next);
        }
    }

    if (best.equals(origin)) return [];
    const route = [];
    let key = best.toString();
    while (key && key !== originKey) {
        route.push(positions.get(key));
        key = parents.get(key);
    }
    route.reverse();
    console.log(
        `[MOVE] local route nodes=${positions.size} steps=${route.length} ` +
        `distance=${localTargetDistance(origin, target).toFixed(1)}->${localTargetDistance(best, target).toFixed(1)}`
    );
    return route;
}

function localTargetDistance(left, right) {
    return horizontalDistance(left, right) + Math.abs(left.y - right.y) * 1.5;
}

function isNearLocalTarget(left, right) {
    return horizontalDistance(left, right) <= 2 && Math.abs(left.y - right.y) <= 1.5;
}

async function clearStepToward(bot, target, maxReach = 3, canClear = () => true) {
    const origin = bot.entity.position.floored();
    const deltaX = target.x - origin.x;
    const deltaZ = target.z - origin.z;
    const dx = Math.abs(deltaX) >= Math.abs(deltaZ) ? Math.sign(deltaX) : 0;
    const dz = dx === 0 ? Math.sign(deltaZ) : 0;
    if (dx === 0 && dz === 0) return false;

    for (let distance = 1; distance <= maxReach; distance++) {
        const feet = origin.offset(dx * distance, 0, dz * distance);
        const floor = bot.blockAt(feet.offset(0, -1, 0));
        const obstacles = [bot.blockAt(feet), bot.blockAt(feet.offset(0, 1, 0))]
            .filter(block => block?.boundingBox === 'block');
        if (obstacles.length === 0) continue;
        if (!isSolid(floor)) return false;
        if (obstacles.some(block => ['bedrock', 'barrier'].includes(block.name))) return false;
        if (obstacles.some(block => !canClear(block))) return false;

        let dug = 0;
        for (const block of obstacles) {
            if (!bot.canDigBlock?.(block)) return false;
            await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
            await withTimeout(bot.dig(block), 12000, `Timed out clearing ${block.name}`);
            dug++;
            await sleep(150);
        }
        if (dug > 0) {
            console.log(`[MOVE] opened traversal step ${feet.toString()} blocks=${dug}`);
            return feet;
        }
    }
    return false;
}

async function clearNearbyFoliage(bot, target, maxBlocks = 2) {
    const origin = bot.entity.position.floored();
    const towardX = Math.sign(target.x - origin.x);
    const towardZ = Math.sign(target.z - origin.z);
    const candidates = [];
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            for (let dy = 0; dy <= 1; dy++) {
                const block = bot.blockAt(origin.offset(dx, dy, dz));
                if (!block?.name?.endsWith('_leaves')) continue;
                candidates.push({ block, score: dx * towardX + dz * towardZ });
            }
        }
    }
    let cleared = 0;
    for (const { block } of candidates.sort((a, b) => b.score - a.score)) {
        if (cleared >= maxBlocks || !bot.canDigBlock?.(block)) break;
        await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
        await withTimeout(bot.dig(block), 8000, `Timed out clearing ${block.name}`);
        cleared++;
        await sleep(120);
    }
    if (cleared > 0) console.log(`[MOVE] cleared adjacent foliage blocks=${cleared}`);
    return cleared > 0;
}

function localWalkableSteps(bot, origin) {
    const directions = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    const candidates = [];
    for (const [dx, dz] of directions) {
        for (const dy of [0, 1, -1]) {
            const position = origin.offset(dx, dy, dz);
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            const floor = bot.blockAt(position.offset(0, -1, 0));
            if (!isPassable(feet) || !isPassable(head) || !isSolid(floor)) continue;
            if (dx !== 0 && dz !== 0 && !hasDiagonalClearance(bot, origin, dx, dz, dy)) {
                continue;
            }
            candidates.push(position);
            break;
        }
    }
    return candidates;
}

function hasDiagonalClearance(bot, origin, dx, dz, dy) {
    return [origin.offset(dx, dy, 0), origin.offset(0, dy, dz)].every(position =>
        isPassable(bot.blockAt(position)) &&
        isPassable(bot.blockAt(position.offset(0, 1, 0)))
    );
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function isUnsafeFrontDrop(bot, target = null) {
    const direction = horizontalUnitToward(bot, target);
    if (!direction) return false;
    const centerX = bot.entity.position.x + direction.x * 0.75;
    const centerZ = bot.entity.position.z + direction.z * 0.75;
    const y = bot.entity.position.floored().y;
    for (const [x, z] of collisionCells(centerX, centerZ)) {
        const feet = new Vec3(x, y, z);
        if (isSolid(bot.blockAt(feet))) return false;
        for (let depth = 1; depth <= 2; depth++) {
            if (isSolid(bot.blockAt(feet.offset(0, -depth, 0)))) return false;
        }
    }
    return true;
}

function bodyIntersectsSolid(bot) {
    return bodyCollisionBlocks(bot).length > 0;
}

function bodyCollisionBlocks(bot) {
    if (!bot.entity?.position || typeof bot.blockAt !== 'function') return [];
    const position = bot.entity.position;
    const y = position.floored().y;
    const blocks = [];
    const seen = new Set();
    for (const [x, z] of collisionCells(position.x, position.z)) {
        for (const blockY of [y + 1, y]) {
            const blockPosition = new Vec3(x, blockY, z);
            const block = bot.blockAt(blockPosition);
            if (!blockIntersectsBody(block, position, blockPosition)) continue;
            const key = `${x},${blockY},${z}`;
            if (seen.has(key)) continue;
            seen.add(key);
            blocks.push(block);
        }
    }
    return blocks;
}

function blockIntersectsBody(block, bodyPosition, fallbackPosition) {
    if (!block || block.boundingBox !== 'block' || !Array.isArray(block.shapes)) return false;
    const position = block.position || fallbackPosition;
    const body = {
        minX: bodyPosition.x - 0.3,
        maxX: bodyPosition.x + 0.3,
        minY: bodyPosition.y + 0.001,
        maxY: bodyPosition.y + 1.799,
        minZ: bodyPosition.z - 0.3,
        maxZ: bodyPosition.z + 0.3
    };
    return block.shapes.some(shape => {
        if (!Array.isArray(shape) || shape.length < 6) return false;
        const minX = position.x + Number(shape[0]);
        const minY = position.y + Number(shape[1]);
        const minZ = position.z + Number(shape[2]);
        const maxX = position.x + Number(shape[3]);
        const maxY = position.y + Number(shape[4]);
        const maxZ = position.z + Number(shape[5]);
        return maxX > body.minX && minX < body.maxX &&
            maxY > body.minY && minY < body.maxY &&
            maxZ > body.minZ && minZ < body.maxZ;
    });
}

function hasGroundSupport(bot) {
    const position = bot.entity.position;
    const y = Math.floor(position.y - 0.05);
    return collisionCells(position.x, position.z).some(([x, z]) =>
        isSolid(bot.blockAt(new Vec3(x, y, z)))
    );
}

function isSuspendedAgainstWall(bot) {
    const velocityY = Math.abs(bot.entity.velocity?.y || 0);
    return !bot.entity.onGround && velocityY < 0.03 &&
        !hasGroundSupport(bot) && bodyIntersectsSolid(bot);
}

async function releaseWallContact(bot, target) {
    stop(bot);
    try {
        await bot.lookAt(targetAimPoint(target).offset(0, 0.5, 0), true);
        bot.setControlState('back', true);
        bot.setControlState('sprint', false);
        bot.setControlState('jump', false);
        await sleep(300);
    } finally {
        stop(bot);
    }
    await sleep(200);
}

function isSolid(block) {
    return block && !['air', 'cave_air', 'void_air'].includes(block.name) && block.boundingBox === 'block';
}

function isPassable(block) {
    if (!block || ['water', 'lava', 'powder_snow', 'fire', 'soul_fire'].includes(block.name)) {
        return false;
    }
    if (block.name.endsWith('_leaves')) return false;
    if (block.boundingBox !== 'block') return true;
    if (!Array.isArray(block.shapes) || block.shapes.length === 0) return false;
    const maximumHeight = Math.max(...block.shapes.map(shape => Number(shape[4] || 0)));
    return maximumHeight <= 0.25;
}

function stop(bot) {
    navigationVersions.set(bot, (navigationVersions.get(bot) || 0) + 1);
    bot.pathfinder?.setGoal?.(null);
    bot.clearControlStates?.();
}

function markMovementIntent(bot, kind, target) {
    bot.sorimMovementIntent = {
        kind,
        target: target ? { x: target.x, y: target.y, z: target.z } : null,
        at: Date.now()
    };
}

function clearMovementIntent(bot) {
    bot.sorimMovementIntent = null;
}

function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout])
        .finally(() => clearTimeout(timer));
}

function withNavigationWatchdog(bot, promise, timeoutMs, message, stallMs = 1800) {
    let timeout = null;
    let monitor = null;
    let anchor = bot.entity.position.clone();
    let lastProgressAt = Date.now();
    const deadline = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
        monitor = setInterval(() => {
            if (!bot.entity?.position) {
                reject(new Error('Pathfinder lost the controlled entity'));
                return;
            }
            const commanded = ['forward', 'back', 'left', 'right', 'jump']
                .some(control => bot.controlState?.[control]);
            if (!commanded) {
                anchor = bot.entity.position.clone();
                lastProgressAt = Date.now();
                return;
            }
            if (horizontalDistance(anchor, bot.entity.position) >= 0.15) {
                anchor = bot.entity.position.clone();
                lastProgressAt = Date.now();
                return;
            }
            if (Date.now() - lastProgressAt < stallMs) return;
            const error = new Error('Pathfinder commanded movement without progress');
            error.code = 'PATHFINDER_STALLED';
            reject(error);
        }, 100);
    });
    return Promise.race([promise, deadline])
        .finally(() => {
            clearTimeout(timeout);
            clearInterval(monitor);
        });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    configure,
    resyncCollision,
    bodyIntersectsSolid,
    bodyCollisionBlocks,
    moveNear,
    followPlayer,
    moveBlock,
    moveNearXZ,
    moveOutOfWater,
    centerInCurrentCell,
    explore,
    manualNudge,
    moveTowardDirectly,
    walkToward,
    stepUpToward,
    frontObstacle,
    moveTowardSafely,
    escapeLocalDeadEnd,
    clearStepToward,
    clearNearbyFoliage,
    descendFromCanopy,
    selectExplorationWaypoint,
    completeExplorationWaypoint,
    noteExplorationProgress,
    hasWaterBarrier,
    squareSpiralCell,
    localDetourCandidates,
    localEscapeCandidates,
    stop,
    sleep,
    withTimeout
};
