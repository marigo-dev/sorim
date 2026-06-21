const { goals, Movements } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');

function configure(bot) {
    const movements = new Movements(bot);
    movements.canDig = false;
    movements.allow1by1towers = false;
    movements.allowFreeMotion = true;
    movements.allowParkour = true;
    bot.pathfinder.setMovements(movements);
}

async function moveNear(bot, position, range = 2, timeoutMs = 20000) {
    const goal = new goals.GoalNear(position.x, position.y, position.z, range);
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'Timed out walking to target');
}

async function moveBlock(bot, position, timeoutMs = 12000) {
    const goal = new goals.GoalBlock(position.x, position.y, position.z);
    await withTimeout(bot.pathfinder.goto(goal), timeoutMs, 'Timed out walking to block target');
}

async function explore(bot, action = {}) {
    const target = action.target || 'around';
    const origin = bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const distance = target === 'stone' ? 12 : target === 'food' ? 12 : 24;
    const position = new Vec3(
        Math.floor(origin.x + Math.cos(angle) * distance),
        Math.floor(origin.y),
        Math.floor(origin.z + Math.sin(angle) * distance)
    );

    console.log(`[MOVE] Exploring target=${target} x=${position.x} z=${position.z}`);
    try {
        await withTimeout(
            bot.pathfinder.goto(new goals.GoalNearXZ(position.x, position.z, 3)),
            18000,
            'Exploration timed out'
        );
    } catch (error) {
        console.log(`[MOVE] Exploration could not complete: ${error.message}`);
        await manualNudge(bot, 1800);
    }
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

function isFrontBlocked(bot) {
    const yaw = bot.entity.yaw;
    const dx = Math.round(-Math.sin(yaw));
    const dz = Math.round(-Math.cos(yaw));
    const feet = bot.entity.position.floored();
    const frontFeet = bot.blockAt(feet.offset(dx, 0, dz));
    const frontHead = bot.blockAt(feet.offset(dx, 1, dz));
    return isSolid(frontFeet) || isSolid(frontHead);
}

function isSolid(block) {
    return block && !['air', 'cave_air', 'void_air'].includes(block.name) && block.boundingBox === 'block';
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
    explore,
    manualNudge,
    stop,
    sleep,
    withTimeout
};
