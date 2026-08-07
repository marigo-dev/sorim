const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

const explorationSteps = new WeakMap();

function configure(bot) {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = true;
    movements.allowParkour = false;
    movements.maxDropDown = 2;
    bot.pathfinder.setMovements(movements);
}

async function moveNear(bot, position, range = 2, timeoutMs = 20000) {
    if (bot.entity?.position?.distanceTo(position) <= range) return;
    const goal = new goals.GoalNear(position.x, position.y, position.z, range);
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'Timed out walking to target');
}

async function moveBlock(bot, position, timeoutMs = 12000) {
    if (bot.entity?.position?.floored?.().equals(position)) return;
    const goal = new goals.GoalBlock(position.x, position.y, position.z);
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'Timed out walking to block target');
}

async function moveNearXZ(bot, position, range = 2, timeoutMs = 10000) {
    const dx = bot.entity.position.x - position.x;
    const dz = bot.entity.position.z - position.z;
    if (Math.hypot(dx, dz) <= range) return;
    const goal = new goals.GoalNearXZ(position.x, position.z, range);
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'Timed out walking toward horizontal target');
}

async function explore(bot, action = {}) {
    const target = action.target || 'around';
    const origin = bot.entity.position;
    const angle = nextExplorationAngle(bot);
    const distance = target === 'wood' ? 28 : target === 'stone' ? 16 : target === 'food' ? 24 : 24;
    const position = new Vec3(
        Math.floor(origin.x + Math.cos(angle) * distance),
        Math.floor(origin.y),
        Math.floor(origin.z + Math.sin(angle) * distance)
    );

    console.log(`[MOVE] Exploring target=${target} x=${position.x} z=${position.z}`);
    let scanTimer = null;
    try {
        const verticalAllowance = target === 'stone' ? 8 : target === 'wood' ? 14 : 8;
        const goal = target === 'wood' || target === 'food'
            ? new goals.GoalXZ(position.x, position.z)
            : new goals.GoalNear(position.x, position.y, position.z, 3);
        const navigation = bot.pathfinder.goto(goal)
            .then(() => ({ type: 'reached' }));
        const candidates = [navigation];
        if (typeof action.stopWhen === 'function') {
            candidates.push(new Promise(resolve => {
                const scan = () => {
                    let found = null;
                    try {
                        found = action.stopWhen();
                    } catch {
                        return;
                    }
                    if (found) resolve({ type: 'found', value: found });
                };
                scan();
                scanTimer = setInterval(scan, 250);
            }));
        }
        const outcome = await withTimeout(
            withVerticalGuard(
                bot,
                Promise.race(candidates),
                origin.y - verticalAllowance,
                origin.y + verticalAllowance
            ),
            target === 'wood' ? 30000 : 18000,
            'Exploration timed out'
        );
        if (outcome?.type === 'found') {
            stop(bot);
            console.log(`[MOVE] Exploration found ${target} while walking.`);
            return { found: outcome.value, reached: false };
        }
        return { found: null, reached: true };
    } catch (error) {
        stop(bot);
        console.log(`[MOVE] Exploration could not complete: ${error.message}`);
        return { found: null, reached: false, error };
    } finally {
        clearInterval(scanTimer);
    }
}

function nextExplorationAngle(bot) {
    const step = explorationSteps.get(bot) || 0;
    explorationSteps.set(bot, step + 1);
    const name = String(bot.username || 'marigo');
    const seed = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
    return (seed * 0.173 + step * 2.399963229728653) % (Math.PI * 2);
}

function withVerticalGuard(bot, navigation, minimumY, maximumY) {
    let timer = null;
    const guard = new Promise((_, reject) => {
        timer = setInterval(() => {
            const y = bot.entity?.position?.y;
            if (!Number.isFinite(y) || (y >= minimumY && y <= maximumY)) return;
            stop(bot);
            reject(new Error(`Exploration left safe Y range (${y.toFixed(1)})`));
        }, 100);
    });
    return Promise.race([navigation, guard])
        .finally(() => clearInterval(timer));
}

async function manualNudge(bot, durationMs = 1200) {
    try {
        const blocked = isFrontBlocked(bot);
        if (blocked) {
            bot.setControlState('back', true);
            bot.setControlState('jump', true);
            await sleep(450);
            bot.clearControlStates();
            bot.setControlState('right', true);
            bot.setControlState('jump', true);
            await sleep(350);
            bot.clearControlStates();
        }
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', true);
        await sleep(durationMs);
    } finally {
        stop(bot);
    }
}

async function moveTowardDirectly(bot, position, durationMs = 2200) {
    const origin = bot.entity.position.clone();
    const deadline = Date.now() + durationMs;
    try {
        await bot.lookAt(position.offset(0.5, 1, 0.5), true);
        while (Date.now() < deadline) {
            if (isUnsafeFrontDrop(bot)) break;
            bot.setControlState('forward', true);
            bot.setControlState('sprint', true);
            bot.setControlState('jump', isFrontBlocked(bot));
            await sleep(100);
        }
    } finally {
        stop(bot);
    }
    return bot.entity.position.distanceTo(origin) >= 1;
}

async function moveTowardSafely(bot, target, maxSteps = 12) {
    const visited = new Set();
    const startDistance = horizontalDistance(bot.entity.position, target);
    for (let step = 0; step < maxSteps; step++) {
        const current = bot.entity.position.floored();
        visited.add(current.toString());
        if (horizontalDistance(current, target) <= 3) return true;
        const candidates = localWalkableSteps(bot, current)
            .filter(position => !visited.has(position.toString()))
            .sort((left, right) =>
                horizontalDistance(left, target) - horizontalDistance(right, target) ||
                Math.abs(left.y - current.y) - Math.abs(right.y - current.y)
            );
        const next = candidates[0];
        if (!next) break;
        const before = bot.entity.position.clone();
        try {
            await moveBlock(bot, next, 2500);
        } catch {
            stop(bot);
            await moveTowardDirectly(bot, next, 1200);
        }
        if (bot.entity.position.distanceTo(before) < 0.7) {
            visited.add(next.toString());
        }
    }
    return horizontalDistance(bot.entity.position, target) <= startDistance - 2;
}

function localWalkableSteps(bot, origin) {
    const directions = [
        [1, 0], [-1, 0], [0, 1], [0, -1],
        [1, 1], [1, -1], [-1, 1], [-1, -1]
    ];
    const candidates = [];
    for (const [dx, dz] of directions) {
        for (const dy of [1, 0, -1, -2]) {
            const position = origin.offset(dx, dy, dz);
            const feet = bot.blockAt(position);
            const head = bot.blockAt(position.offset(0, 1, 0));
            const floor = bot.blockAt(position.offset(0, -1, 0));
            if (!isPassable(feet) || !isPassable(head) || !isSolid(floor)) continue;
            candidates.push(position);
            break;
        }
    }
    return candidates;
}

function horizontalDistance(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

function isFrontBlocked(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored();
    const frontFeet = bot.blockAt(feet.offset(dx, 0, dz));
    const frontHead = bot.blockAt(feet.offset(dx, 1, dz));
    return isSolid(frontFeet) || isSolid(frontHead);
}

function isUnsafeFrontDrop(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored();
    const front = feet.offset(dx, 0, dz);
    for (let depth = 1; depth <= 3; depth++) {
        if (isSolid(bot.blockAt(front.offset(0, -depth, 0)))) return false;
    }
    return true;
}

function isSolid(block) {
    return block && !['air', 'cave_air', 'void_air'].includes(block.name) && block.boundingBox === 'block';
}

function isPassable(block) {
    return Boolean(
        block &&
        block.boundingBox !== 'block' &&
        !['water', 'lava', 'powder_snow', 'fire', 'soul_fire'].includes(block.name)
    );
}

function stop(bot) {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
}

function withTimeout(promise, timeoutMs, message) {
    let timer = null;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return Promise.race([promise, timeout])
        .finally(() => clearTimeout(timer));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    configure,
    moveNear,
    moveBlock,
    moveNearXZ,
    explore,
    manualNudge,
    moveTowardDirectly,
    moveTowardSafely,
    stop,
    sleep,
    withTimeout
};
