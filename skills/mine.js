const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const movement = require('./movement');

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

async function mineBlock(bot, action) {
    const targetName = action.target;
    const block = targetName === 'any_log' ? findBestLog(bot) : findBestBlock(bot, targetName);
    const expectedDrop = action.expectedDrop || (targetName === 'any_log' ? block?.name : expectedDropFor(targetName));
    if (!block) {
        if (targetName === 'any_log' || LOGS.has(targetName)) {
            await movement.explore(bot, { target: 'wood' });
            return;
        }
        if (targetName === 'stone' || targetName === 'cobblestone') {
            await digStaircaseForStone(bot);
            return;
        }
        throw new Error(`${targetName} icin erisilebilir blok bulunamadi`);
    }

    if (LOGS.has(block.name)) {
        await chopTree(bot, block, expectedDrop);
        return;
    }

    const before = countItem(bot, expectedDrop);
    await equipBestTool(bot, block);
    await approachBlock(bot, block);

    const current = bot.blockAt(block.position);
    if (!current || current.name !== block.name) {
        throw new Error(`${targetName} hedefi kayboldu`);
    }
    if (!bot.canDigBlock(current)) {
        throw new Error(`${targetName} kirilamiyor`);
    }

    console.log(`[MINE] ${current.name} ${current.position.toString()}`);
    await bot.dig(current);
    await collectDrop(bot, expectedDrop, before, current.position);
}

async function chopTree(bot, baseBlock, expectedDrop) {
    const base = lowestLogInTrunk(bot, baseBlock);
    const initialTrunk = findTrunkBlocks(bot, base);
    if (initialTrunk.length === 0) throw new Error(`${baseBlock.name} icin govde yok`);

    console.log(`[TREE] ${baseBlock.name} govde=${initialTrunk.length} base=${base.position.toString()}`);
    let before = countItem(bot, expectedDrop);
    let mined = 0;
    const skipped = new Set();

    for (let pass = 0; pass < 10; pass++) {
        const current = findNextTrunkBlock(bot, base.position, baseBlock.name, skipped);
        if (!current) break;

        await equipBestTool(bot, current);
        try {
            await approachBlock(bot, current);
        } catch {
            await nudgeToward(bot, current.position);
        }

        if (!bot.canDigBlock(current)) {
            console.log(`[TREE] atlandi, kirilamiyor ${current.position.toString()}`);
            skipped.add(positionKey(current.position));
            continue;
        }

        console.log(`[MINE] ${current.name} ${current.position.toString()}`);
        await bot.dig(current);
        mined++;
        try {
            await collectDrop(bot, expectedDrop, before, current.position);
            before = countItem(bot, expectedDrop);
        } catch (error) {
            console.log(`[TREE] drop gecikti: ${error.message}`);
        }
    }

    if (mined === 0) throw new Error(`${baseBlock.name} govdesinden blok kirilamadi`);
    await patrolTreeDrops(bot, expectedDrop, before, base.position);
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
        .filter(block => bot.canDigBlock(block))
        .filter(block => isReachable(bot, block))
        .sort((a, b) => scoreBlock(bot, a) - scoreBlock(bot, b))[0] || null;
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
            return isAir(feet) &&
                isAir(head) &&
                floor?.boundingBox === 'block' &&
                eye.distanceTo(target.offset(0.5, 0.5, 0.5)) <= 4.6;
        })
        .sort((a, b) =>
            a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position)
        )[0] || null;
}

async function approachBlock(bot, block) {
    const work = findWorkPosition(bot, block.position);
    if (work) {
        await movement.withTimeout(
            bot.pathfinder.goto(new goals.GoalNear(work.x, work.y, work.z, 1)),
            18000,
            'Kazma noktasina yurume zaman asimi'
        );
    } else {
        await movement.moveNear(bot, block.position, 3, 18000);
    }

    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
}

async function equipBestTool(bot, block) {
    const suffix = LOGS.has(block.name) ? '_axe' : '_pickaxe';
    const tiers = ['netherite', 'diamond', 'iron', 'stone', 'wooden'];
    const tool = tiers
        .map(tier => `${tier}${suffix}`)
        .map(name => bot.inventory.items().find(item => item.name === name))
        .find(Boolean);
    if (tool) await bot.equip(tool, 'hand');
}

async function collectDrop(bot, itemName, before, origin) {
    for (let attempt = 0; attempt < 8; attempt++) {
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
                await movement.moveNear(bot, drop.position, 1, 1500);
            } catch {
                await nudgeToward(bot, drop.position);
            }
        } else {
            await nudgeToward(bot, origin);
        }
        await movement.sleep(250);
    }

    if (countItem(bot, itemName) <= before) {
        throw new Error(`${itemName} kirildi ama envantere girmedi`);
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
            await movement.moveNear(bot, drop.position, 1, 4000);
        } catch {
            await nudgeToward(bot, drop.position);
        }
        if (countItem(bot, itemName) > before) before = countItem(bot, itemName);
    }
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

    console.log('[MINE] Erisilebilir stone yok; kucuk merdiven kaziliyor.');
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
            await bot.dig(downBlock);
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

    throw new Error('Merdiven kazildi ama stone bulunamadi');
}

async function clearBlock(bot, blockOrPosition) {
    const block = blockOrPosition?.position
        ? blockOrPosition
        : bot.blockAt(blockOrPosition);
    if (!block || isAir(block)) return;
    if (!bot.canDigBlock(block)) return;
    await equipBestTool(bot, block);
    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(block);
    await movement.sleep(150);
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
    ].some(([x, y, z]) => isAir(bot.blockAt(position.offset(x, y, z))));
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
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    mineBlock
};
