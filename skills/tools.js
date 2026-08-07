const craft = require('./craft');
const movement = require('./movement');

const TOOL_ORDER = [
    'stone_pickaxe',
    'stone_axe',
    'stone_sword'
];

const STICK_REQUIREMENTS = {
    stone_pickaxe: 2,
    stone_axe: 2,
    stone_sword: 1
};

async function craftStoneTools(bot) {
    await ensureCraftingTable(bot);

    for (const tool of TOOL_ORDER) {
        if (hasItem(bot, tool, 1)) continue;
        await ensureSticks(bot, STICK_REQUIREMENTS[tool] || 1);
        await craft.craftItem(bot, tool, 1);
    }
}

async function ensureCraftingTable(bot) {
    if (hasItem(bot, 'crafting_table', 1)) {
        await moveToOpenWorkspace(bot);
        await craft.placeBlock(bot, 'crafting_table');
        return;
    }

    const id = bot.registry.blocksByName.crafting_table?.id;
    const nearbyTables = id
        ? bot.findBlocks({ matching: id, maxDistance: 16, count: 32 })
            .map(position => bot.blockAt(position))
            .filter(Boolean)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )
        : [];
    for (const nearby of nearbyTables.slice(0, 8)) {
        try {
            await movement.moveNear(bot, nearby.position, 4, 5000);
            return;
        } catch (error) {
            console.log(`[TOOLS] table is unreachable, trying a new one: ${error.message}`);
        }
    }

    await moveToOpenWorkspace(bot);

    await craft.craftItem(bot, 'crafting_table', 1);
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
        .map(name => inventorySlots(bot).find(item => item.name === name))
        .find(Boolean);
    if (weapon) await bot.equip(weapon, 'hand');
    return weapon || null;
}

async function equipBestTool(bot, kind) {
    const suffix = kind === 'axe' ? '_axe' : '_pickaxe';
    const tool = ['netherite', 'diamond', 'iron', 'stone', 'wooden']
        .map(tier => `${tier}${suffix}`)
        .map(name => inventorySlots(bot).find(item => item.name === name))
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
    const slotCount = inventorySlots(bot)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

function inventorySlots(bot) {
    return bot.inventory.slots.filter(Boolean);
}

async function moveToOpenWorkspace(bot) {
    const origin = bot.entity.position.floored();
    if (isOpenStand(bot, origin)) return;

    const candidates = [];
    for (let dx = -6; dx <= 6; dx++) {
        for (let dz = -6; dz <= 6; dz++) {
            for (let dy = 4; dy >= -2; dy--) {
                const position = origin.offset(dx, dy, dz);
                if (isOpenStand(bot, position)) {
                    candidates.push(position);
                }
            }
        }
    }

    candidates.sort((a, b) => a.distanceTo(origin) - b.distanceTo(origin));
    for (const position of candidates.slice(0, 12)) {
        try {
            await movement.moveNear(bot, position, 1, 6000);
            return;
        } catch {
            // Try the next open stand.
        }
    }
}

function isOpenStand(bot, position) {
    const feet = bot.blockAt(position);
    const head = bot.blockAt(position.offset(0, 1, 0));
    const floor = bot.blockAt(position.offset(0, -1, 0));
    return isAir(feet) && isAir(head) && floor?.boundingBox === 'block';
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

module.exports = {
    craftStoneTools,
    equipBestWeapon,
    equipBestTool,
    hasStoneTools
};
