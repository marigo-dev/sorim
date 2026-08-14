process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../src/protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const movement = require('../src/skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const BOT_USERNAME = process.env.PVP_BOT_USERNAME || 'marigo';
const TESTER_USERNAME = process.env.PVP_TESTER_USERNAME || 'CombatTester';
const USE_SETUP_TELEPORT = process.env.PVP_FIXTURE_TELEPORT !== 'false';

async function main() {
    const tester = await createBot(TESTER_USERNAME);
    let duelReply = null;
    let stopSent = false;
    tester.on('chat', (username, message) => {
        if (username.toLowerCase() !== BOT_USERNAME.toLowerCase()) return;
        if (/duello|duel/i.test(message)) duelReply = message;
    });

    try {
        await waitForPlayer(tester, BOT_USERNAME, 15000);
        if (USE_SETUP_TELEPORT) {
            tester.chat(`/tp @s ${BOT_USERNAME}`);
            await movement.sleep(700);
        }
        await approachPlayer(tester, BOT_USERNAME, 15000);
        const healthBefore = tester.health;
        const firstDamage = new Promise(resolve => {
            const onHealth = () => {
                if (tester.health >= healthBefore) return;
                tester.removeListener('health', onHealth);
                if (!stopSent) {
                    stopSent = true;
                    tester.chat(`${BOT_USERNAME} dur`);
                }
                resolve(tester.health);
            };
            tester.on('health', onHealth);
        });

        tester.chat(`${BOT_USERNAME} benimle savas`);
        const healthAfterFirstHit = await withTimeout(firstDamage, 15000, 'Bot did not damage the duel target');
        await movement.sleep(1000);
        const healthAfterStopSettled = tester.health;
        await movement.sleep(1800);
        const finalHealth = tester.health;

        const result = {
            healthBefore,
            healthAfterFirstHit,
            healthAfterStopSettled,
            finalHealth,
            duelReply,
            stopped: finalHealth === healthAfterStopSettled
        };
        console.log(`[PVP_COMMAND_RESULT] ${JSON.stringify(result)}`);
        if (!duelReply) throw new Error('Bot did not acknowledge duel intent');
        if (healthAfterFirstHit >= healthBefore) throw new Error('Duel did not cause player damage');
        if (!result.stopped) throw new Error('Bot continued attacking after the stop command');
    } finally {
        tester.end();
        await movement.sleep(500);
    }
}

function createBot(username) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username, version: VERSION });
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

async function approachPlayer(bot, username, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const target = findPlayer(bot, username)?.entity;
        if (!target) throw new Error(`${username} disappeared before duel setup`);
        const distance = target.position.distanceTo(bot.entity.position);
        if (distance <= 2.8) return;
        await movement.followPlayer(bot, target.username || username, { range: 2.2, durationMs: 1300 });
    }
    throw new Error(`Could not approach ${username} for duel setup`);
}

function findPlayer(bot, username) {
    const wanted = username.toLowerCase();
    const entry = Object.entries(bot.players || {}).find(([name]) => name.toLowerCase() === wanted);
    return entry?.[1] || null;
}

function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(message)), timeoutMs))
    ]);
}

main().catch(error => {
    console.error('[PVP_COMMAND_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
