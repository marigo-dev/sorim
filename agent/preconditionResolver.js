const siteSelector = require('../safety/siteSelector');

const BUILD_TARGET = 88;

class PreconditionResolver {
    resolve(step, context = {}) {
        if (!step?.tool) return [];
        const observation = context.observation || {};
        const inventory = observation.inventory || {};
        const attempts = context.preconditionCounts || {};

        if (requiresBase(step.tool) && !observation.base) {
            return [prerequisite('ensure_base', {}, step, 'A remembered base is required')];
        }
        if (['ensure_base', 'build_shelter'].includes(step.tool) && !observation.base) {
            const potential = materialPotential(inventory);
            if (potential < BUILD_TARGET) {
                const logCount = Math.ceil((BUILD_TARGET - potential) / 4);
                return [prerequisite('mine_block', { target: 'any_log', count: logCount }, step, 'Acquire enough building material before construction')];
            }
            if (context.bot && Number(attempts.explore_safe_terrain || 0) < 2 && !safeBuildSite(context.bot)) {
                return [prerequisite('explore', { target: 'safe_terrain' }, step, 'Find flat unprotected terrain before construction')];
            }
        }
        if (step.tool === 'collect_stone' && pickaxeCount(inventory) < 1) {
            return [prerequisite('craft_item', { item: 'wooden_pickaxe', count: 1 }, step, 'Stone collection requires a pickaxe')];
        }
        if (step.tool === 'craft_stone_tools') {
            if (count(inventory, 'cobblestone') < 8) {
                return [prerequisite('collect_stone', { count: 8 - count(inventory, 'cobblestone') }, step, 'Stone tools require eight cobblestone')];
            }
            if (!hasCraftingTable(observation)) {
                return [prerequisite('craft_item', { item: 'crafting_table', count: 1 }, step, 'Stone tools require a crafting table')];
            }
            if (count(inventory, 'stick') < 5) {
                return [prerequisite('craft_item', { item: 'stick', count: 5 - count(inventory, 'stick') }, step, 'Stone tools require five sticks')];
            }
        }
        if (step.tool === 'craft_item') {
            const craftPrerequisite = resolveCraftPrerequisite(step, observation);
            if (craftPrerequisite) return [craftPrerequisite];
        }
        if (step.tool === 'mine_iron') {
            const pickaxes = count(inventory, 'stone_pickaxe') + count(inventory, 'iron_pickaxe');
            if (pickaxes < 1 || count(inventory, 'torch') < 16) {
                return [prerequisite('prepare_mining_kit', {}, step, 'Iron mining requires a pickaxe and torches')];
            }
        }
        if (step.tool === 'establish_wheat_farm' && !observation.base) {
            return [prerequisite('ensure_base', {}, step, 'A farm needs a protected base location')];
        }
        return [];
    }
}

function requiresBase(tool) {
    return ['return_base', 'organize_storage', 'secure_bed', 'prepare_mining_kit'].includes(tool);
}

function materialPotential(inventory) {
    return Object.entries(inventory || {}).reduce((sum, [name, amount]) => {
        const value = Number(amount || 0);
        if (name.endsWith('_log')) return sum + value * 4;
        if (name.endsWith('_planks') || ['dirt', 'cobblestone'].includes(name)) return sum + value;
        return sum;
    }, 0);
}

function resolveCraftPrerequisite(step, observation) {
    const inventory = observation.inventory || {};
    const item = step.args?.item;
    const requested = Math.max(1, Number(step.args?.count || 1));
    if (!item) return null;

    if (item.endsWith('_planks')) {
        const available = count(inventory, item);
        if (available >= requested) return null;
        const log = item.replace(/_planks$/, '_log');
        const requiredLogs = Math.ceil((requested - available) / 4);
        if (count(inventory, log) < requiredLogs) {
            return prerequisite('mine_block', { target: 'any_log', count: requiredLogs - count(inventory, log) }, step, `Acquire logs for ${item}`);
        }
        return null;
    }

    if (item === 'crafting_table') {
        return plankPrerequisite(step, inventory, 4, 'Crafting table requires four planks');
    }

    if (item === 'stick') {
        const operations = Math.ceil(requested / 4);
        return plankPrerequisite(step, inventory, operations * 2, 'Stick crafting requires planks');
    }

    if (item === 'wooden_pickaxe') {
        const tableCost = hasCraftingTable(observation) ? 0 : 4;
        const stickCost = count(inventory, 'stick') >= 2 ? 0 : 2;
        const planks = plankPrerequisite(step, inventory, 3 + tableCost + stickCost, 'Wooden pickaxe kit requires planks');
        if (planks) return planks;
        if (!hasCraftingTable(observation)) {
            return prerequisite('craft_item', { item: 'crafting_table', count: 1 }, step, 'Wooden pickaxe requires a crafting table');
        }
        if (count(inventory, 'stick') < 2) {
            return prerequisite('craft_item', { item: 'stick', count: 2 - count(inventory, 'stick') }, step, 'Wooden pickaxe requires two sticks');
        }
    }
    return null;
}

function plankPrerequisite(parent, inventory, required, reason) {
    const planks = totalBySuffix(inventory, '_planks');
    if (planks >= required) return null;
    const logs = Object.entries(inventory).filter(([name, amount]) => name.endsWith('_log') && Number(amount) > 0);
    const potential = planks + logs.reduce((sum, [, amount]) => sum + Number(amount) * 4, 0);
    if (potential < required) {
        return prerequisite('mine_block', {
            target: 'any_log',
            count: Math.ceil((required - potential) / 4)
        }, parent, reason);
    }
    const [logName, logCount] = logs[0];
    const craftCount = Math.min(required - planks, Number(logCount) * 4);
    return prerequisite('craft_item', {
        item: logName.replace(/_log$/, '_planks'),
        count: craftCount
    }, parent, reason);
}

function hasCraftingTable(observation) {
    if (count(observation.inventory, 'crafting_table') > 0 || observation.hasPlacedCraftingTable) return true;
    return (observation.nearbyBlocks || []).some(block => block.name === 'crafting_table' && Number(block.distance || 0) <= 16);
}

function pickaxeCount(inventory) {
    return ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
        .reduce((sum, name) => sum + count(inventory, name), 0);
}

function totalBySuffix(inventory, suffix) {
    return Object.entries(inventory || {})
        .filter(([name]) => name.endsWith(suffix))
        .reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
}

function safeBuildSite(bot) {
    try {
        return Boolean(siteSelector.findBuildSite(bot, { width: 5, depth: 5, radius: 12 }));
    } catch {
        return false;
    }
}

function prerequisite(tool, args, parent, reason) {
    return {
        tool,
        args,
        reason,
        maxAttempts: 3,
        preconditionFor: parent.id,
        preconditionKey: tool === 'explore' ? `explore_${args.target || 'around'}` : tool
    };
}

function count(inventory, name) {
    return Number(inventory?.[name] || 0);
}

module.exports = {
    PreconditionResolver,
    materialPotential,
    requiresBase,
    resolveCraftPrerequisite,
    hasCraftingTable
};
