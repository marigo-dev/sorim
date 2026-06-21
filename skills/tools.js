const craft = require('./craft');
const movement = require('./movement');

const TOOL_ORDER = [
    'stone_pickaxe',
    'stone_axe',
    'stone_sword'
];

async function craftStoneTools(bot) {
    await ensureCraftingTable(bot);
    await ensureSticks(bot, 5);

    for (const tool of TOOL_ORDER) {
        if (hasItem(bot, tool, 1)) continue;
        await craft.craftItem(bot, tool, 1);
    }
}

async function ensureCraftingTable(bot) {
    const id = bot.registry.blocksByName.crafting_table?.id;
    const nearby = id ? bot.findBlock({ matching: id, maxDistance: 16 }) : null;
    if (nearby) {
        try {
            await movement.moveNear(bot, nearby.position, 3, 6000);
            return;
        } catch (error) {
            console.log(`[TOOLS] masa erisilemiyor, yenisi deneniyor: ${error.message}`);
        }
    }

    if (!hasItem(bot, 'crafting_table', 1)) {
        await craft.craftItem(bot, 'crafting_table', 1);
    }
    await craft.placeBlock(bot, 'crafting_table');
}

async function ensureSticks(bot, minimum) {
    while (countItem(bot, 'stick') < minimum) {
        await craft.craftItem(bot, 'stick', 2);
    }
}

async function equipBestWeapon(bot) {
    const weapon = [
        'netherite_sword',
        'diamond_sword',
        'iron_sword',
        'stone_sword',
        'wooden_sword',
        'stone_axe',
        'wooden_axe'
    ]
        .map(name => bot.inventory.items().find(item => item.name === name))
        .find(Boolean);
    if (weapon) await bot.equip(weapon, 'hand');
}

async function equipBestTool(bot, kind) {
    const suffix = kind === 'axe' ? '_axe' : '_pickaxe';
    const tool = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
        .map(tier => `${tier}${suffix}`)
        .map(name => bot.inventory.items().find(item => item.name === name))
        .find(Boolean);
    if (tool) await bot.equip(tool, 'hand');
}

function hasStoneTools(inventory) {
    return TOOL_ORDER.every(name => (inventory[name] || 0) >= 1);
}

function hasItem(bot, itemName, count) {
    return countItem(bot, itemName) >= count;
}

function countItem(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

module.exports = {
    craftStoneTools,
    equipBestWeapon,
    equipBestTool,
    hasStoneTools
};
