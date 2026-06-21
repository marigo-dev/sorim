function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function inventoryCount(bot, itemName) {
    return bot.inventory.items()
        .filter(item => item.name === itemName)
        .reduce((total, item) => total + item.count, 0);
}

function inventoryCountBy(bot, predicate) {
    return bot.inventory.items()
        .filter(predicate)
        .reduce((total, item) => total + item.count, 0);
}

const DANGEROUS_FOODS = new Set([
    'chorus_fruit',
    'pufferfish',
    'poisonous_potato',
    'rotten_flesh',
    'spider_eye',
    'suspicious_stew',
    'raw_chicken'
]);

function isSafeFoodItem(bot, item, allowEmergencyFood = false) {
    if (!bot.registry.foodsByName[item.name]) return false;
    if (!DANGEROUS_FOODS.has(item.name)) return true;
    return allowEmergencyFood && item.name === 'rotten_flesh';
}

function safeFoodInventoryCount(bot, allowEmergencyFood = false) {
    return inventoryCountBy(bot, item =>
        isSafeFoodItem(bot, item, allowEmergencyFood)
    );
}

function summarizeInventory(bot) {
    const grouped = new Map();

    for (const item of bot.inventory.items()) {
        grouped.set(item.name, (grouped.get(item.name) || 0) + item.count);
    }

    return {
        items: Object.fromEntries(grouped),
        emptySlots: bot.inventory.emptySlotCount(),
        text: [...grouped.entries()]
            .map(([name, count]) => `${name}:${count}`)
            .join(', ') || 'Bos'
    };
}

function entityName(entity) {
    const rawName = entity?.name || entity?.displayName;
    if (typeof rawName !== 'string') return '';

    return rawName
        .replace(/^minecraft:/, '')
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .replace(/\s+/g, '_')
        .toLowerCase();
}

module.exports = {
    sleep,
    inventoryCount,
    inventoryCountBy,
    isSafeFoodItem,
    safeFoodInventoryCount,
    summarizeInventory,
    entityName
};
