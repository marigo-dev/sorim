const movement = require('./movement');

const FEED = {
    cow: ['wheat'],
    sheep: ['wheat'],
    pig: ['carrot', 'potato', 'beetroot'],
    chicken: ['wheat_seeds', 'beetroot_seeds', 'melon_seeds', 'pumpkin_seeds'],
    rabbit: ['carrot', 'dandelion']
};

async function careForAnimals(bot) {
    const animals = Object.values(bot.entities || {})
        .filter(entity => entity !== bot.entity && entity.position && FEED[entity.name])
        .filter(entity => entity.position.distanceTo(bot.entity.position) <= 28)
        .sort((left, right) => left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position));

    for (const [name, feedItems] of Object.entries(FEED)) {
        const herd = animals.filter(entity => entity.name === name);
        const feed = inventoryItems(bot).find(item => feedItems.includes(item.name) && item.count >= 2);
        if (herd.length < 2 || !feed) continue;
        await bot.equip(feed, 'hand');
        let fed = 0;
        for (const animal of herd.slice(0, 4)) {
            try {
                await movement.moveNear(bot, animal.position, 2, 8000);
                await bot.lookAt(animal.position.offset(0, 0.8, 0), true);
                await bot.activateEntity(animal);
                fed++;
                await movement.sleep(450);
            } catch (error) {
                console.log(`[RANCH] could not feed ${name}: ${error.message}`);
            }
        }
        console.log(`[RANCH] species=${name} fed=${fed}`);
        return { species: name, fed, success: fed >= 2 };
    }

    console.log('[RANCH] no breedable animal pair with matching feed nearby');
    await movement.sleep(1000);
    return { species: null, fed: 0, success: false };
}

function inventoryItems(bot) {
    return bot.inventory?.items?.() || bot.inventory?.slots?.filter(Boolean) || [];
}

module.exports = { careForAnimals };
