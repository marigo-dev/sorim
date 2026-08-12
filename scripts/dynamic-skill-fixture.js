process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const movement = require('../skills/movement');
const persistentMemory = require('../agent/persistentMemory');
const sandbox = require('../agent/dynamicSkillSandbox');
const toolRegistry = require('../toolRegistry');
const taskVerifier = require('../agent/taskVerifier');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.DYNAMIC_SKILL_TESTER || 'SkillTester';

async function main() {
    const bot = await createBot();
    persistentMemory.initialize(USERNAME);
    let target = null;
    let setup = null;
    try {
        bot.chat('/give @s dirt 2');
        await waitUntil(() => countItem(bot, 'dirt') >= 2, 5000, 'Fixture did not receive dirt');
        setup = await prepareTestPlatform(bot);
        target = findPlacementTarget(bot);
        if (!target) throw new Error('No nearby supported air block for dynamic placement');

        const origin = bot.entity.position.floored();
        const offset = {
            x: target.x - origin.x,
            y: target.y - origin.y,
            z: target.z - origin.z
        };
        const compiled = sandbox.compile({
            id: 'live_dirt_marker',
            displayName: 'Live Dirt Marker',
            purpose: 'Place and verify one bounded marker on Minecraft 26.2.',
            capabilities: {
                radius: 4,
                vertical: 2,
                maxOperations: 2,
                maxMutations: 1,
                maxDurationMs: 15000,
                mutableBlocks: ['dirt']
            },
            program: [{ op: 'place', offset, item: 'dirt' }],
            postconditions: [{ type: 'block_equals', offset, block: 'dirt' }]
        });
        if (!compiled.ok) throw new Error(compiled.error);
        persistentMemory.saveDynamicSkill(compiled.profile);

        const call = compiled.steps[0];
        const before = taskVerifier.capture(bot);
        const executionResult = await toolRegistry.executeToolCall(bot, call);
        await movement.sleep(500);
        const verification = taskVerifier.verify(call, before, taskVerifier.capture(bot), {
            bot,
            executionResult
        });
        persistentMemory.markDynamicSkillResult(compiled.profile.id, verification.ok, {
            verification: verification.reason
        });
        const stored = persistentMemory.getDynamicSkill(compiled.profile.id);
        const result = {
            verification: verification.ok,
            status: stored.status,
            target: { x: target.x, y: target.y, z: target.z },
            worldBlock: bot.blockAt(target)?.name,
            operations: executionResult.operations,
            mutations: executionResult.mutations
        };
        console.log(`[DYNAMIC_SKILL_RESULT] ${JSON.stringify(result)}`);
        if (!verification.ok || stored.status !== 'active' || result.worldBlock !== 'dirt') {
            throw new Error(`Live dynamic skill verification failed: ${verification.reason}`);
        }
    } finally {
        if (target) {
            bot.chat(`/setblock ${target.x} ${target.y} ${target.z} air`);
            await movement.sleep(300);
        }
        if (setup) await cleanupTestPlatform(bot, setup);
        persistentMemory.flush();
        bot.end();
        await movement.sleep(400);
    }
}

async function prepareTestPlatform(bot) {
    const original = bot.entity.position.clone();
    const x = Math.floor(original.x);
    const z = Math.floor(original.z);
    const y = 120;
    bot.chat(`/fill ${x - 3} ${y} ${z - 3} ${x + 3} ${y + 2} ${z + 3} air`);
    await movement.sleep(250);
    bot.chat(`/fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y - 1} ${z + 3} stone`);
    await movement.sleep(250);
    bot.chat(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`);
    await waitUntil(() => bot.entity.position.y >= y - 0.5, 3000, 'Fixture teleport did not complete');
    await movement.sleep(250);
    return { original, x, y, z };
}

async function cleanupTestPlatform(bot, setup) {
    const { original, x, y, z } = setup;
    bot.chat(`/tp @s ${original.x} ${original.y + 1} ${original.z}`);
    await movement.sleep(250);
    bot.chat(`/fill ${x - 3} ${y - 1} ${z - 3} ${x + 3} ${y + 2} ${z + 3} air`);
    await movement.sleep(250);
}

function createBot() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION });
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

function findPlacementTarget(bot) {
    const origin = bot.entity.position.floored();
    const candidates = [
        [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1],
        [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2]
    ];
    for (const [x, y, z] of candidates) {
        const target = origin.offset(x, y, z);
        const block = bot.blockAt(target);
        const support = bot.blockAt(target.offset(0, -1, 0));
        if (isAir(block) && support?.boundingBox === 'block') return target;
    }
    return null;
}

function countItem(bot, itemName) {
    return bot.inventory.items().filter(item => item.name === itemName)
        .reduce((sum, item) => sum + item.count, 0);
}

function isAir(block) {
    return ['air', 'cave_air', 'void_air'].includes(block?.name);
}

async function waitUntil(predicate, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await movement.sleep(100);
    }
    throw new Error(message);
}

main().catch(error => {
    console.error('[DYNAMIC_SKILL_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
