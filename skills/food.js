const movement = require('./movement');
const tools = require('./tools');

const FOOD_VALUES = {
    bread: 5,
    cooked_beef: 8,
    cooked_porkchop: 8,
    cooked_mutton: 6,
    cooked_chicken: 6,
    cooked_cod: 5,
    cooked_salmon: 6,
    beef: 3,
    porkchop: 3,
    mutton: 2,
    chicken: 2,
    cod: 2,
    salmon: 2,
    apple: 4,
    carrot: 3,
    potato: 1,
    baked_potato: 5,
    wheat: 0
};

const FOOD_MOBS = new Set([
    'cow',
    'pig',
    'sheep',
    'chicken'
]);

let failedSearches = 0;
let foodUnavailableUntil = 0;

async function eatBestFood(bot) {
    const food = bestFoodItem(bot);
    if (!food) throw new Error('No edible food available');

    console.log(`[FOOD] yeniyor ${food.name}`);
    await bot.equip(food, 'hand');
    await bot.consume();
}

async function findFood(bot) {
    if (Date.now() < foodUnavailableUntil) {
        console.log('[FOOD] no nearby food source; temporarily moving to the next goal.');
        return;
    }

    const animal = nearestFoodMob(bot);
    if (!animal) {
        await searchForFood(bot);
        return;
    }

    const startDistance = animal.position.distanceTo(bot.entity.position);
    console.log(`[FOOD] hunting target ${animal.name} distance=${startDistance.toFixed(1)}`);
    if (startDistance > 18) {
        await searchForFood(bot);
        return;
    }

    await tools.equipBestWeapon(bot);
    try {
        await movement.moveNear(bot, animal.position, 1, 12000);
    } catch (error) {
        console.log(`[FOOD] could not reach target: ${error.message}`);
        await markFailedSearch(bot);
        return;
    }

    const before = foodScore(countInventory(bot));
    for (let i = 0; i < 14 && animal.isValid !== false; i++) {
        const distance = animal.position.distanceTo(bot.entity.position);
        if (distance > 3) {
            try {
                await movement.moveNear(bot, animal.position, 1, 4000);
            } catch {
                await nudgeToward(bot, animal.position);
            }
        }
        await bot.lookAt(animal.position.offset(0, 0.8, 0), true);
        bot.attack(animal);
        await movement.sleep(450);
    }

    await collectNearbyDrops(bot);
    if (foodScore(countInventory(bot)) > before) {
        failedSearches = 0;
    } else {
        await markFailedSearch(bot);
    }
}

function foodScore(inventory) {
    return Object.entries(inventory)
        .reduce((sum, [name, count]) => sum + (FOOD_VALUES[name] || 0) * count, 0);
}

function hasFoodStock(inventory, minimum = 16) {
    return foodScore(inventory) >= minimum;
}

function isTemporarilyUnavailable() {
    return Date.now() < foodUnavailableUntil;
}

function bestFoodItem(bot) {
    return bot.inventory.items()
        .filter(item => (FOOD_VALUES[item.name] || 0) > 0)
        .sort((a, b) => FOOD_VALUES[b.name] - FOOD_VALUES[a.name])[0] || null;
}

function nearestFoodMob(bot) {
    return Object.values(bot.entities || {})
        .filter(entity => FOOD_MOBS.has(entity.name))
        .filter(entity => entity.position && entity.position.distanceTo(bot.entity.position) <= 24)
        .sort((a, b) =>
            a.position.distanceTo(bot.entity.position) -
            b.position.distanceTo(bot.entity.position)
        )[0] || null;
}

async function collectNearbyDrops(bot) {
    for (let i = 0; i < 8; i++) {
        const drop = Object.values(bot.entities || {})
            .filter(entity => entity.name === 'item')
            .filter(entity => entity.position.distanceTo(bot.entity.position) <= 8)
            .sort((a, b) =>
                a.position.distanceTo(bot.entity.position) -
                b.position.distanceTo(bot.entity.position)
            )[0];
        if (!drop) {
            await movement.sleep(250);
            continue;
        }
        try {
            await movement.moveNear(bot, drop.position, 1, 4000);
        } catch {
            await movement.manualNudge?.(bot, 800);
        }
    }
}

async function searchForFood(bot) {
    try {
        await movement.explore(bot, { target: 'food' });
    } finally {
        await markFailedSearch(bot);
    }
}

async function markFailedSearch(bot) {
    failedSearches++;
    console.log(`[FOOD] failed searches=${failedSearches}`);
    if (failedSearches >= 3) {
        foodUnavailableUntil = Date.now() + 5 * 60 * 1000;
        failedSearches = 0;
        console.log('[FOOD] no mob/crop found; delaying for 5 minutes.');
    }
    await movement.sleep(500);
}

function countInventory(bot) {
    const counts = {};
    for (const item of bot.inventory.items()) {
        counts[item.name] = (counts[item.name] || 0) + item.count;
    }
    return counts;
}

async function nudgeToward(bot, position) {
    try {
        await bot.lookAt(position.offset(0, 0.5, 0), true);
        bot.setControlState('forward', true);
        bot.setControlState('sprint', true);
        bot.setControlState('jump', true);
        await movement.sleep(900);
    } finally {
        bot.clearControlStates();
    }
}

module.exports = {
    eatBestFood,
    findFood,
    foodScore,
    hasFoodStock,
    isTemporarilyUnavailable
};
