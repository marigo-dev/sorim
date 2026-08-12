const { Vec3 } = require('vec3');
const movement = require('./movement');
const blockPolicy = require('../safety/blockPolicy');

async function replantSapling(bot) {
    const sapling = inventoryItems(bot).find(item => item.name.endsWith('_sapling'));
    if (!sapling) return false;
    const ground = findPlantingGround(bot);
    if (!ground) return false;

    await movement.moveNear(bot, ground.position, 3, 8000);
    await bot.equip(sapling, 'hand');
    await bot.lookAt(ground.position.offset(0.5, 1, 0.5), true);
    await bot.placeBlock(ground, new Vec3(0, 1, 0));
    await movement.sleep(300);
    const planted = bot.blockAt(ground.position.offset(0, 1, 0));
    if (planted?.name !== sapling.name) throw new Error('Planted sapling was not visible in world state');
    console.log(`[FORESTRY] planted ${sapling.name} at ${planted.position.toString()}`);
    return planted;
}

function findPlantingGround(bot) {
    const ids = ['grass_block', 'dirt', 'podzol']
        .map(name => bot.registry.blocksByName[name]?.id)
        .filter(Number.isFinite);
    return bot.findBlocks({ matching: ids, maxDistance: 24, count: 96 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => !blockPolicy.protectedZoneAt(block.position.offset(0, 1, 0)))
        .filter(block => passable(bot.blockAt(block.position.offset(0, 1, 0))) &&
            passable(bot.blockAt(block.position.offset(0, 2, 0))) && noNearbyTrunk(bot, block.position, 3))
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        )[0] || null;
}

function noNearbyTrunk(bot, position, radius) {
    for (let x = -radius; x <= radius; x++) {
        for (let z = -radius; z <= radius; z++) {
            for (let y = 0; y <= 4; y++) {
                if (bot.blockAt(position.offset(x, y, z))?.name?.endsWith('_log')) return false;
            }
        }
    }
    return true;
}

function passable(block) {
    return !block || block.boundingBox === 'empty' || ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass'].includes(block.name);
}

function inventoryItems(bot) {
    return bot.inventory?.items?.() || bot.inventory?.slots?.filter(Boolean) || [];
}

module.exports = { replantSapling };
