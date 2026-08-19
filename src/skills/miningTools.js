const movement = require('./movement');

// Minecraft data exposes harvestTools as item ids. An empty list means the
// block is harvestable by hand, so do not waste a tool on it.
async function equipForBlock(bot, block) {
    const data = bot.registry?.blocksByName?.[block?.name];
    const requiredIds = data?.harvestTools && typeof data.harvestTools === 'object'
        ? Object.keys(data.harvestTools).map(Number)
        : [];
    if (requiredIds.length === 0) {
        await bot.unequip('hand');
        return { mode: 'hand', tool: null };
    }

    const candidates = bot.inventory.items()
        .filter(item => requiredIds.includes(item.type))
        .filter(item => remainingDurability(bot, item) > 2)
        .sort((left, right) => toolRank(right) - toolRank(left));
    const tool = candidates[0];
    if (!tool) {
        throw new Error(`No suitable tool for ${block.name}`);
    }

    await bot.equip(tool, 'hand');
    if (bot.heldItem?.type !== tool.type) {
        throw new Error(`Could not equip ${tool.name} for ${block.name}`);
    }
    return { mode: 'tool', tool };
}

async function collectDrop(bot, expectedName, beforeCount, origin, options = {}) {
    const timeoutMs = options.timeoutMs ?? 7000;
    const radius = options.radius ?? 10;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (countItem(bot, expectedName) > beforeCount) return true;
        const drops = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item' && entity.position)
            .filter(entity => entity.position.distanceTo(origin) <= radius)
            .sort((left, right) =>
                left.position.distanceTo(bot.entity.position) -
                right.position.distanceTo(bot.entity.position)
            );

        if (drops.length > 0) {
            try {
                // Normal pickup is navigation, never a direct-control fallback.
                await movement.moveNear(bot, drops[0].position, 1, Math.min(3000, deadline - Date.now()));
            } catch (error) {
                console.log(`[PICKUP] pathfinder could not reach ${expectedName}: ${error.message}`);
                break;
            }
        } else {
            await movement.sleep(250);
        }
        await movement.sleep(250);
    }

    return countItem(bot, expectedName) > beforeCount;
}

function countItem(bot, name) {
    return bot.inventory.items()
        .filter(item => item.name === name)
        .reduce((sum, item) => sum + item.count, 0);
}

function remainingDurability(bot, item) {
    const maximum = Number(item.maxDurability || bot.registry?.itemsByName?.[item.name]?.maxDurability || 0);
    if (!maximum) return Number.POSITIVE_INFINITY;
    return maximum - Number(item.durabilityUsed || 0);
}

function toolRank(item) {
    return ['wooden', 'golden', 'stone', 'iron', 'diamond', 'netherite']
        .findIndex(tier => item.name.startsWith(`${tier}_`));
}

module.exports = { equipForBlock, collectDrop, countItem };
