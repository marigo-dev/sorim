process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');
const mineflayer = require('mineflayer');
const movement = require('../skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION;
const BOT_USERNAME = process.env.CLARIFICATION_BOT_USERNAME || 'marigo';
const TESTER_USERNAME = process.env.CLARIFICATION_TESTER_USERNAME || 'ClarifyTester';

async function main() {
    const tester = await createTester();
    let setup = null;
    try {
        const marigo = await waitForPlayer(tester, BOT_USERNAME, 15000);
        setup = await prepareArena(tester, marigo);

        const replies = [];
        tester.on('chat', (username, message) => {
            if (username.toLowerCase() === BOT_USERNAME.toLowerCase()) replies.push(message);
        });

        const zombie = await summonZombie(tester, setup);
        tester.chat(`${BOT_USERNAME} onu oldur`);
        await waitUntil(() => replies.some(message => /kime|hangi yaratiga/i.test(message)), 7000,
            'Bot did not ask for the ambiguous combat target');

        tester.chat('zombi');
        await waitUntil(() => replies.some(message => /zombie hedefini kilitledim/i.test(message)), 7000,
            'Bot did not resolve the unaddressed clarification answer');
        await waitUntil(() => !tester.entities[zombie.id] || tester.entities[zombie.id].isValid === false, 15000,
            'Resolved combat task did not defeat the zombie');

        console.log(`[CLARIFICATION_RESULT] ${JSON.stringify({
            asked: true,
            acceptedUnaddressedAnswer: true,
            defeated: true,
            replies
        })}`);
    } finally {
        if (setup) await cleanupArena(tester, setup);
        tester.end();
        await movement.sleep(400);
    }
}

function createTester() {
    return new Promise((resolve, reject) => {
        const tester = mineflayer.createBot({ host: HOST, port: PORT, username: TESTER_USERNAME, version: VERSION });
        install26_2PacketFallbacks(tester);
        install26_2VelocityShim(tester);
        tester.once('spawn', async () => {
            await movement.sleep(900);
            resolve(tester);
        });
        tester.once('error', reject);
    });
}

async function prepareArena(tester, marigo) {
    const originalTester = tester.entity.position.clone();
    const originalBot = marigo.position.clone();
    const x = Math.floor(originalTester.x);
    const y = 120;
    const z = Math.floor(originalTester.z);
    for (const command of [
        `/fill ${x - 3} ${y} ${z - 3} ${x + 10} ${y + 3} ${z + 3} air`,
        `/fill ${x - 3} ${y - 1} ${z - 3} ${x + 10} ${y - 1} ${z + 3} stone`,
        `/tp ${BOT_USERNAME} ${x + 0.5} ${y} ${z + 0.5}`,
        `/tp @s ${x + 6.5} ${y} ${z + 0.5}`,
        `/give ${BOT_USERNAME} iron_sword 1`
    ]) {
        tester.chat(command);
        await movement.sleep(180);
    }
    await movement.sleep(700);
    return { x, y, z, originalTester, originalBot };
}

async function summonZombie(tester, setup) {
    const position = { x: setup.x + 3.5, y: setup.y, z: setup.z + 0.5 };
    const existing = new Set(Object.keys(tester.entities || {}).map(Number));
    tester.chat(`/summon zombie ${position.x} ${position.y} ${position.z} {NoAI:1b,Health:1.0f,PersistenceRequired:1b}`);
    return waitForEntity(tester, entity =>
        entity.name === 'zombie' && !existing.has(entity.id) && entity.position.distanceTo(position) <= 2,
    5000);
}

async function cleanupArena(tester, setup) {
    tester.chat('/kill @e[type=zombie,distance=..32]');
    tester.chat(`/tp ${BOT_USERNAME} ${setup.originalBot.x} ${setup.originalBot.y + 1} ${setup.originalBot.z}`);
    tester.chat(`/tp @s ${setup.originalTester.x} ${setup.originalTester.y + 1} ${setup.originalTester.z}`);
    await movement.sleep(300);
    tester.chat(`/fill ${setup.x - 3} ${setup.y - 1} ${setup.z - 3} ${setup.x + 10} ${setup.y + 3} ${setup.z + 3} air`);
    await movement.sleep(300);
}

async function waitForPlayer(bot, username, timeoutMs) {
    return waitForEntity(bot, entity => entity.type === 'player' && entity.username?.toLowerCase() === username.toLowerCase(), timeoutMs);
}

async function waitForEntity(bot, predicate, timeoutMs) {
    let found = null;
    await waitUntil(() => {
        found = Object.values(bot.entities || {}).find(predicate) || null;
        return Boolean(found);
    }, timeoutMs, 'Expected fixture entity did not appear');
    return found;
}

async function waitUntil(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await movement.sleep(80);
    }
    throw new Error(message);
}

main().catch(error => {
    console.error('[CLARIFICATION_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
