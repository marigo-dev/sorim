const craft = require('./craft');
const movement = require('./movement');

async function fish(bot) {
    let rod = inventoryItems(bot).find(item => item.name === 'fishing_rod');
    if (!rod) {
        await craft.craftItem(bot, 'fishing_rod', 1);
        rod = inventoryItems(bot).find(item => item.name === 'fishing_rod');
    }
    if (!rod) throw new Error('Fishing rod is unavailable; string and sticks are required');

    const water = findWater(bot);
    if (!water) throw new Error('No safe fishing water found');
    try {
        await movement.moveNear(bot, water.position, 4, 10000);
    } catch (error) {
        if (bot.entity.position.distanceTo(water.position) > 10) throw error;
        movement.stop(bot);
        console.log(`[FISH] shore path ended within casting range: ${error.message}`);
    }
    await bot.equip(rod, 'hand');
    await bot.lookAt(water.position.offset(0.5, 0.2, 0.5), true);
    console.log(`[FISH] casting near ${water.position.toString()}`);
    await fishByBobberMotion(bot, Number(process.env.FISHING_TIMEOUT_MS || 60000));
    await movement.sleep(500);
}

async function fishByBobberMotion(bot, timeoutMs) {
    const before = fishCount(bot);
    let packetCount = 0;
    let splashDetected = false;
    let activeBobber = null;
    const rawParticleListener = packet => {
        const particle = decodeParticle26_2(packet?.data);
        if (!particle) return;
        if (process.env.FISHING_PACKET_DEBUG === 'true' && packetCount++ < 24) {
            console.log(
                `[FISH_PACKET] id=${particle.id} amount=${particle.amount} ` +
                `position=${particle.x.toFixed(2)},${particle.y.toFixed(2)},${particle.z.toFixed(2)}`
            );
        }
        if (!activeBobber || particle.amount !== 6) return;
        const dx = particle.x - activeBobber.position.x;
        const dy = particle.y - activeBobber.position.y;
        const dz = particle.z - activeBobber.position.z;
        const distance = Math.hypot(dx, dy, dz);
        if (process.env.FISHING_PACKET_DEBUG === 'true') {
            console.log(`[FISH_SPLASH] id=${particle.id} distance=${distance.toFixed(2)}`);
        }
        if (distance <= 1.75) splashDetected = true;
    };
    const soundListener = packet => {
        const id = packet?.soundId ?? packet?.sound;
        const registrySound = Number.isFinite(Number(id)) ? bot.registry.sounds?.[Number(id)] : null;
        const name = String(packet?.soundName || packet?.name || registrySound?.name || '');
        if (process.env.FISHING_PACKET_DEBUG === 'true' && name.includes('fishing')) {
            console.log(`[FISH_SOUND] ${name} ${JSON.stringify(packet)}`);
        }
        if (name.includes('fishing_bobber') && name.includes('splash')) splashDetected = true;
    };
    bot._client.on('sorim_raw_particles', rawParticleListener);
    bot._client.on('sound_effect', soundListener);
    bot._client.on('entity_sound_effect', soundListener);
    try {
    for (let cast = 0; cast < Number(process.env.FISHING_CAST_ATTEMPTS || 2); cast++) {
        const existing = new Set(fishingBobbers(bot).map(entity => entity.id));
        bot.activateItem();
        const bobber = await waitForBobber(bot, existing, 6000);
        if (!bobber) throw new Error('Fishing bobber did not spawn');
        activeBobber = bobber;
        splashDetected = false;
        await movement.sleep(1600);
        console.log(
            `[FISH] bobber=${bobber.position.toString()} ` +
            `block=${bot.blockAt(bobber.position.floored())?.name || 'unknown'}`
        );

        const startedAt = Date.now();
        let baseline = bobber.position.y;
        let previousY = baseline;
        while (Date.now() - startedAt < timeoutMs) {
            const live = bot.entities[bobber.id];
            if (!live) break;
            const y = live.position.y;
            const elapsed = Date.now() - startedAt;
            if (elapsed < 5000) {
                baseline = y;
                previousY = y;
                await movement.sleep(100);
                continue;
            }
            const downwardVelocity = Number(live.velocity?.y || 0);
            if (splashDetected) {
                console.log(`[FISH] bite detected elapsed=${elapsed} splash=${splashDetected} drop=${(baseline - y).toFixed(2)} velocity=${downwardVelocity.toFixed(2)}`);
                bot.activateItem();
                if (await waitForFish(bot, before, 6000)) {
                    activeBobber = null;
                    return;
                }
                console.log(`[FISH] reel produced no food fish; retrying (${inventorySummary(bot)})`);
                break;
            }
            previousY = y;
            await movement.sleep(100);
        }

        if (bot.entities[bobber.id]) bot.activateItem();
        activeBobber = null;
        await movement.sleep(700);
    }
    throw new Error('Fishing timed out without a verified catch');
    } finally {
        bot._client.removeListener('sorim_raw_particles', rawParticleListener);
        bot._client.removeListener('sound_effect', soundListener);
        bot._client.removeListener('entity_sound_effect', soundListener);
    }
}

function decodeParticle26_2(data) {
    if (!Buffer.isBuffer(data) || data.length < 47) return null;
    try {
        const particleId = readVarInt(data, 46);
        return {
            x: data.readDoubleBE(2),
            y: data.readDoubleBE(10),
            z: data.readDoubleBE(18),
            amount: data.readInt32BE(42),
            id: particleId.value
        };
    } catch {
        return null;
    }
}

function readVarInt(buffer, offset) {
    let value = 0;
    let position = 0;
    let byte;
    do {
        if (offset >= buffer.length || position >= 35) throw new Error('Invalid VarInt');
        byte = buffer[offset++];
        value |= (byte & 0x7f) << position;
        position += 7;
    } while ((byte & 0x80) !== 0);
    return { value, offset };
}

async function waitForBobber(bot, existing, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const bobber = fishingBobbers(bot).find(entity => !existing.has(entity.id));
        if (bobber) return bobber;
        await movement.sleep(100);
    }
    return null;
}

async function waitForFish(bot, before, timeoutMs) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (fishCount(bot) > before) return true;
        await movement.sleep(100);
    }
    return false;
}

function fishingBobbers(bot) {
    return Object.values(bot.entities || {}).filter(entity =>
        ['fishing_bobber', 'fishing_hook'].includes(entity.name)
    );
}

function fishCount(bot) {
    return inventoryItems(bot)
        .filter(item => ['cod', 'salmon', 'tropical_fish', 'pufferfish'].includes(item.name))
        .reduce((sum, item) => sum + item.count, 0);
}

function findWater(bot) {
    const id = bot.registry.blocksByName.water?.id;
    if (!Number.isFinite(id)) return null;
    const candidates = bot.findBlocks({ matching: id, maxDistance: 32, count: 128 })
        .map(position => bot.blockAt(position))
        .filter(Boolean)
        .filter(block => !bot.blockAt(block.position.offset(0, 1, 0))?.boundingBox ||
            bot.blockAt(block.position.offset(0, 1, 0))?.boundingBox === 'empty')
        .sort((left, right) =>
            left.position.distanceTo(bot.entity.position) - right.position.distanceTo(bot.entity.position)
        );
    const open = candidates
        .map(block => ({ block, score: openWaterScore(bot, block.position) }))
        .filter(entry => entry.score >= 20)
        .sort((left, right) =>
            right.score - left.score ||
            left.block.position.distanceTo(bot.entity.position) - right.block.position.distanceTo(bot.entity.position)
        );
    return open[0]?.block || candidates[0] || null;
}

function openWaterScore(bot, center) {
    let water = 0;
    for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
            if (bot.blockAt(center.offset(dx, 0, dz))?.name === 'water') water++;
        }
    }
    return water;
}

function inventoryItems(bot) {
    return bot.inventory?.items?.() || bot.inventory?.slots?.filter(Boolean) || [];
}

function inventorySummary(bot) {
    return inventoryItems(bot).map(item => `${item.name}:${item.count}`).join(', ') || 'empty';
}

module.exports = { fish, decodeParticle26_2 };
