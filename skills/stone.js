const { Vec3 } = require('vec3');
const movement = require('./movement');

const DIRECTIONS = [
    new Vec3(1, 0, 0),
    new Vec3(0, 0, 1),
    new Vec3(-1, 0, 0),
    new Vec3(0, 0, -1)
];
let directionIndex = 0;

async function collectStone(bot, count = 16) {
    const start = bot.entity.position.floored();
    const before = countItem(bot, 'cobblestone');
    const target = before + count;
    const shaft = [];
    const direction = DIRECTIONS[directionIndex++ % DIRECTIONS.length];
    let stuckSteps = 0;
    let noProgressMines = 0;

    console.log(`[STONE] target cobblestone=${target}, start=${start.toString()} direction=${direction.toString()}`);
    try {
        for (let step = 0; step < 32 && countItem(bot, 'cobblestone') < target; step++) {
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
        await returnToSurface(bot, start, shaft);
    }

    if (countItem(bot, 'cobblestone') <= before) {
        throw new Error('Safe staircase was opened but no cobblestone was collected');
    }
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
    if (!current || (current.name !== 'stone' && current.name !== 'cobblestone')) return false;
    await digBlock(bot, current);
    await collectNearby(bot, 'cobblestone', before, current.position);
    console.log(`[STONE] cobblestone ${before} -> ${countItem(bot, 'cobblestone')}`);
    return countItem(bot, 'cobblestone') > before;
}

function findReachableStone(bot) {
    const ids = ['stone', 'cobblestone']
        .map(name => bot.registry.blocksByName[name]?.id)
        .filter(Boolean);
    return bot.findBlocks({ matching: ids, maxDistance: 8, count: 32 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => hasOpenFace(bot, block.position))
        .filter(block => block.position.distanceTo(bot.entity.position) <= 5)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        )[0] || null;
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
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
            try {
                bot.stopDigging();
            } catch {
                // Mineflayer may already have cleared the digging state.
            }
            reject(new Error(`Timed out digging ${block.name} ${block.position.toString()}`));
        }, 10000);
    });

    try {
        await Promise.race([bot.dig(block), timeout]);
    } finally {
        clearTimeout(timer);
    }
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
                await movement.moveNear(bot, drop.position, 1, 3000);
            } catch {
                await jumpToward(bot, drop.position);
            }
        }
        await movement.sleep(200);
    }

    if (countItem(bot, itemName) <= before) {
        await jumpToward(bot, origin);
        await movement.sleep(400);
    }
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
