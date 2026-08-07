const craft = require('./craft');
const mine = require('./mine');
const tools = require('./tools');

const CORE_KIT = [
    'iron_pickaxe',
    'iron_sword',
    'iron_axe',
    'shield'
];

const ARMOR = [
    'iron_chestplate',
    'iron_leggings',
    'iron_helmet',
    'iron_boots'
];

const ARMOR_SLOTS = {
    iron_helmet: 'head',
    iron_chestplate: 'torso',
    iron_leggings: 'legs',
    iron_boots: 'feet'
};

const IRON_COSTS = {
    iron_pickaxe: 3,
    iron_sword: 2,
    iron_axe: 3,
    shield: 1,
    iron_helmet: 5,
    iron_chestplate: 8,
    iron_leggings: 7,
    iron_boots: 4
};

async function craftIronKit(bot) {
    const plankMinimum = requiredCorePlanks(countItem(bot, 'stick'));
    await ensurePlanks(bot, plankMinimum);
    await ensureSticks(bot, 6);

    for (const item of CORE_KIT) {
        if (countItem(bot, item) <= 0) {
            await craft.craftItem(bot, item, 1);
        }
    }

    await tools.equipBestWeapon(bot);
}

function hasIronCoreKit(inventory) {
    return CORE_KIT.every(name => (inventory[name] || 0) >= 1) &&
        (inventory.iron_ingot || 0) >= 8;
}

function hasFullIronArmor(inventory) {
    return ARMOR.every(name => (inventory[name] || 0) >= 1);
}

function requiredCorePlanks(stickCount = 0) {
    const missingSticks = Math.max(0, 6 - stickCount);
    return 6 + Math.ceil(missingSticks / 4) * 2;
}

async function ensureSticks(bot, minimum) {
    while (countItem(bot, 'stick') < minimum) {
        await craft.craftItem(bot, 'stick', 2);
    }
}

async function ensurePlanks(bot, minimum) {
    if (totalPlanks(bot) < minimum && totalLogs(bot) === 0) {
        await mine.mineBlock(bot, { target: 'any_log' });
    }
    while (totalPlanks(bot) < minimum) {
        const log = bot.inventory.items().find(item => item.name.endsWith('_log'));
        if (!log) throw new Error('Shield icin plank veya log yok');
        await craft.craftItem(bot, log.name.replace(/_log$/, '_planks'), 4);
    }
}

function totalLogs(bot) {
    return bot.inventory.items()
        .filter(item => item.name.endsWith('_log'))
        .reduce((total, item) => total + item.count, 0);
}

async function equipArmor(bot, itemName) {
    const item = bot.inventory.items().find(entry => entry.name === itemName);
    const slot = ARMOR_SLOTS[itemName];
    if (item && slot) await bot.equip(item, slot);
}

function ingotsFor(itemName) {
    return IRON_COSTS[itemName] || 0;
}

function ironInvestment(inventory) {
    return Object.entries(IRON_COSTS)
        .reduce((total, [itemName, cost]) =>
            total + Math.min(1, inventory[itemName] || 0) * cost,
        0);
}

function countItem(bot, itemName) {
    const slotCount = bot.inventory.slots
        .filter(Boolean)
        .filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
    const heldCount = bot.heldItem?.name === itemName ? bot.heldItem.count : 0;
    return Math.max(slotCount, heldCount);
}

function totalPlanks(bot) {
    return bot.inventory.items()
        .filter(item => item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
}

module.exports = {
    craftIronKit,
    hasIronCoreKit,
    hasFullIronArmor,
    requiredCorePlanks,
    ironInvestment
};
