process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const movement = require('../skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const BOT_USERNAME = process.env.PVP_BOT_USERNAME || 'marigo';
const TESTER_USERNAME = process.env.PVP_TACTICS_TESTER || 'CombatTactics';

async function main() {
    const tester = await createBot();
    let setup = null;
    try {
        const target = await waitForPlayer(tester, BOT_USERNAME, 15000);
        setup = await prepareArena(tester, target);
        await giveCombatKit(tester);

        const bowResult = await runPhase(tester, setup, {
            label: 'bow',
            testerX: setup.x + 9.5,
            expectedWeapon: 'bow',
            equipTargetShield: false
        });
        await healTester(tester);
        const axeResult = await runPhase(tester, setup, {
            label: 'axe',
            testerX: setup.x + 2.5,
            expectedWeapon: 'iron_axe',
            equipTargetShield: true
        });
        const mobResult = await runMobCommandPhase(tester, setup);

        const result = { bow: bowResult, axe: axeResult, mob: mobResult };
        console.log(`[PVP_TACTICS_RESULT] ${JSON.stringify(result)}`);
        if (!bowResult.weaponObserved || !bowResult.damaged || !bowResult.stopped) {
            throw new Error('Ranged bow phase did not satisfy weapon, damage, and stop checks');
        }
        if (!axeResult.weaponObserved || !axeResult.damaged || !axeResult.stopped) {
            throw new Error('Shield-counter axe phase did not satisfy weapon, damage, and stop checks');
        }
        if (!mobResult.acknowledged || !mobResult.defeated) {
            throw new Error('Natural-language mob combat phase was not acknowledged and verified');
        }
    } finally {
        if (setup) await cleanupArena(tester, setup);
        tester.end();
        await movement.sleep(400);
    }
}

async function runMobCommandPhase(tester, setup) {
    tester.chat(`/tp ${BOT_USERNAME} ${setup.x + 0.5} ${setup.y} ${setup.z + 0.5}`);
    tester.chat(`/tp @s ${setup.x + 6.5} ${setup.y} ${setup.z + 0.5}`);
    await movement.sleep(500);
    let acknowledged = false;
    const onChat = (username, message) => {
        if (username.toLowerCase() === BOT_USERNAME.toLowerCase() && /zombie hedefini kilitledim/i.test(message)) {
            acknowledged = true;
        }
    };
    tester.on('chat', onChat);
    try {
        const summonPosition = { x: setup.x + 10.5, y: setup.y, z: setup.z + 0.5 };
        const existingIds = new Set(Object.keys(tester.entities || {}).map(Number));
        tester.chat(`/summon zombie ${summonPosition.x} ${summonPosition.y} ${summonPosition.z} {NoAI:1b,Health:1.0f,PersistenceRequired:1b}`);
        const zombie = await waitForEntity(tester, entity =>
            entity.name === 'zombie' && !existingIds.has(entity.id) &&
            entity.position.distanceTo(summonPosition) <= 2,
        5000);
        await movement.sleep(300);
        tester.chat(`${BOT_USERNAME} zombiyi oldur`);
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            const live = tester.entities[zombie.id];
            if (!live || live.isValid === false) {
                await movement.sleep(450);
                return { acknowledged, defeated: true, entityId: zombie.id };
            }
            await movement.sleep(100);
        }
        tester.chat(`${BOT_USERNAME} dur`);
        return { acknowledged, defeated: false, entityId: zombie.id };
    } finally {
        tester.removeListener('chat', onChat);
        tester.chat('/kill @e[type=zombie,distance=..32]');
        await movement.sleep(250);
    }
}

async function runPhase(tester, setup, options) {
    tester.chat(`/tp ${BOT_USERNAME} ${setup.x + 0.5} ${setup.y} ${setup.z + 0.5}`);
    tester.chat(`/tp @s ${options.testerX} ${setup.y} ${setup.z + 0.5}`);
    await movement.sleep(700);
    if (options.equipTargetShield) {
        const shield = tester.inventory.items().find(item => item.name === 'shield');
        if (!shield) throw new Error('Tester shield was not delivered');
        await tester.equip(shield, 'off-hand');
        await movement.sleep(500);
    } else {
        try { await tester.unequip('off-hand'); } catch {}
    }

    const healthBefore = tester.health;
    let weaponObserved = false;
    let stopped = false;
    let stopSentAt = 0;
    const deadline = Date.now() + 18000;
    tester.chat(`${BOT_USERNAME} benimle savas`);
    while (Date.now() < deadline) {
        const marigo = findPlayer(tester, BOT_USERNAME)?.entity;
        const equipment = (marigo?.equipment || []).map(item => item?.name).filter(Boolean);
        if (equipment.includes(options.expectedWeapon)) weaponObserved = true;
        if (tester.health < healthBefore && !stopSentAt) {
            stopSentAt = Date.now();
            tester.chat(`${BOT_USERNAME} dur`);
        }
        if (stopSentAt && Date.now() - stopSentAt >= 1300) {
            const settledHealth = tester.health;
            await movement.sleep(1200);
            stopped = tester.health >= settledHealth;
            break;
        }
        await movement.sleep(80);
    }
    if (!stopSentAt) tester.chat(`${BOT_USERNAME} dur`);
    await movement.sleep(500);
    return {
        label: options.label,
        expectedWeapon: options.expectedWeapon,
        weaponObserved,
        healthBefore,
        healthAfter: tester.health,
        damaged: tester.health < healthBefore || Boolean(stopSentAt),
        stopped
    };
}

async function giveCombatKit(tester) {
    for (const command of [
        `/give ${BOT_USERNAME} bow 1`,
        `/give ${BOT_USERNAME} arrow 16`,
        `/give ${BOT_USERNAME} shield 1`,
        `/give ${BOT_USERNAME} iron_axe 1`,
        `/give ${BOT_USERNAME} iron_sword 1`,
        '/give @s shield 1'
    ]) {
        tester.chat(command);
        await movement.sleep(120);
    }
    await movement.sleep(900);
}

async function healTester(tester) {
    tester.chat('/effect give @s regeneration 3 10 true');
    await movement.sleep(1800);
    tester.chat('/effect clear @s regeneration');
    await movement.sleep(250);
}

async function prepareArena(tester, target) {
    const originalTester = tester.entity.position.clone();
    const originalBot = target.position.clone();
    const x = Math.floor(originalTester.x);
    const z = Math.floor(originalTester.z);
    const y = 120;
    tester.chat(`/fill ${x - 3} ${y} ${z - 4} ${x + 13} ${y + 3} ${z + 4} air`);
    await movement.sleep(250);
    tester.chat(`/fill ${x - 3} ${y - 1} ${z - 4} ${x + 13} ${y - 1} ${z + 4} stone`);
    await movement.sleep(350);
    tester.chat('/time set day');
    tester.chat('/weather clear');
    tester.chat('/kill @e[type=!player,distance=..48]');
    await movement.sleep(250);
    tester.chat(`/tp ${BOT_USERNAME} ${x + 0.5} ${y} ${z + 0.5}`);
    tester.chat(`/tp @s ${x + 6.5} ${y} ${z + 0.5}`);
    await movement.sleep(700);
    return { x, y, z, originalTester, originalBot };
}

async function cleanupArena(tester, setup) {
    tester.chat(`/tp ${BOT_USERNAME} ${setup.originalBot.x} ${setup.originalBot.y + 1} ${setup.originalBot.z}`);
    tester.chat(`/tp @s ${setup.originalTester.x} ${setup.originalTester.y + 1} ${setup.originalTester.z}`);
    await movement.sleep(300);
    tester.chat(`/fill ${setup.x - 3} ${setup.y - 1} ${setup.z - 4} ${setup.x + 13} ${setup.y + 3} ${setup.z + 4} air`);
    await movement.sleep(300);
}

function createBot() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: TESTER_USERNAME, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', async () => {
            movement.configure(bot);
            await movement.sleep(900);
            resolve(bot);
        });
        bot.once('error', reject);
    });
}

async function waitForPlayer(bot, username, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const entity = findPlayer(bot, username)?.entity;
        if (entity) return entity;
        await movement.sleep(100);
    }
    throw new Error(`Could not see ${username}`);
}

async function waitForEntity(bot, predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const entity = Object.values(bot.entities || {}).find(predicate);
        if (entity) return entity;
        await movement.sleep(80);
    }
    throw new Error('Expected fixture entity did not appear');
}

function findPlayer(bot, username) {
    const wanted = username.toLowerCase();
    const entry = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === wanted);
    return entry?.[1] || null;
}

main().catch(error => {
    console.error('[PVP_TACTICS_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
