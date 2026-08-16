const food = require('../skills/food');

function assessMiningKit(observation = {}) {
    const inventory = observation.inventory || {};
    const nearbyBlocks = observation.nearbyBlocks || [];
    const furnaceReady = count(inventory, 'furnace') > 0 ||
        observation.hasPlacedFurnace === true ||
        nearbyBlocks.some(block => block.name === 'furnace' && Number(block.distance || 0) <= 16);
    const fuelReady = count(inventory, 'coal') > 0 ||
        count(inventory, 'charcoal') > 0 ||
        totalBySuffix(inventory, '_log') > 0 ||
        totalBySuffix(inventory, '_planks') > 0;
    const pickaxeReady = ['stone', 'iron', 'diamond', 'netherite']
        .some(material => count(inventory, `${material}_pickaxe`) > 0);
    const weaponReady = ['stone', 'iron', 'diamond', 'netherite']
        .some(material => count(inventory, `${material}_sword`) > 0);
    const torches = count(inventory, 'torch');
    const support = count(inventory, 'cobblestone') + count(inventory, 'dirt');
    const foodCount = food.foodCount(inventory);
    const foodReady = foodCount >= 16 || observation.foodUnavailable === true;
    return {
        ready: furnaceReady && fuelReady && pickaxeReady && weaponReady &&
            torches >= 16 && support >= 16 && foodReady,
        furnaceReady,
        fuelReady,
        pickaxeReady,
        weaponReady,
        torches,
        support,
        foodCount,
        foodReady
    };
}

function count(inventory, name) {
    return Number(inventory?.[name] || 0);
}

function totalBySuffix(inventory, suffix) {
    return Object.entries(inventory || {})
        .filter(([name]) => name.endsWith(suffix))
        .reduce((sum, [, amount]) => sum + Number(amount || 0), 0);
}

module.exports = { assessMiningKit };
