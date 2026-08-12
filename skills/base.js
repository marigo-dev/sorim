const mine = require('./mine');
const craft = require('./craft');
const shelter = require('./shelter');
const memory = require('./memory');

const BUILD_TARGET = 92;
const UTILITY_RESERVE = 18;

async function ensureBase(bot) {
    if (memory.hasBase()) return memory.getBase();
    const required = remainingBuildBudget(bot);

    for (let attempt = 0; attempt < 4 && materialPotential(bot) < required; attempt++) {
        await mine.mineBlock(bot, { target: 'any_log' });
    }

    for (const log of inventoryItems(bot).filter(item => item.name.endsWith('_log'))) {
        if (buildBlockCount(bot) >= required) break;
        await craft.craftItem(bot, log.name.replace(/_log$/, '_planks'), log.count * 4);
    }

    if (buildBlockCount(bot) < required) {
        throw new Error(`Base requires ${required} remaining build blocks; only ${buildBlockCount(bot)} are ready`);
    }
    return shelter.buildSafeShelter(bot);
}

function remainingBuildBudget(bot) {
    const construction = memory.getConstructionBase();
    if (!construction) return BUILD_TARGET;
    return Math.max(0, shelter.SHELL_TARGET - shelter.scoreShelterShell(bot, construction)) + UTILITY_RESERVE;
}

function materialPotential(bot) {
    return buildBlockCount(bot) + inventoryItems(bot)
        .filter(item => item.name.endsWith('_log'))
        .reduce((sum, item) => sum + item.count * 4, 0);
}

function buildBlockCount(bot) {
    return inventoryItems(bot)
        .filter(item => item.name === 'dirt' || item.name === 'cobblestone' || item.name.endsWith('_planks'))
        .reduce((sum, item) => sum + item.count, 0);
}

function inventoryItems(bot) {
    return bot.inventory?.items?.() || bot.inventory?.slots?.filter(Boolean) || [];
}

module.exports = { ensureBase, buildBlockCount, materialPotential, remainingBuildBudget };
