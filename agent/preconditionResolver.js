const siteSelector = require('../safety/siteSelector');

const BUILD_TARGET = 28;

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
            if (materialPotential(inventory) < BUILD_TARGET) {
                return [prerequisite('mine_block', { target: 'any_log' }, step, 'Acquire building material before construction')];
            }
            if (context.bot && Number(attempts.explore_safe_terrain || 0) < 2 && !safeBuildSite(context.bot)) {
                return [prerequisite('explore', { target: 'safe_terrain' }, step, 'Find flat unprotected terrain before construction')];
            }
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

module.exports = { PreconditionResolver, materialPotential, requiresBase };
