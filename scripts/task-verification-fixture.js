process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');
const mineflayer = require('mineflayer');
const taskVerifier = require('../agent/taskVerifier');
const toolRegistry = require('../toolRegistry');
const movement = require('../skills/movement');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.TASK_VERIFIER_USERNAME || 'TaskVerifier';

async function main() {
    const bot = await createBot();
    let arena = null;
    try {
        arena = await prepareArena(bot);
        const call = {
            tool: 'build_blueprint',
            args: { name: 'village_well', x: arena.x, y: arena.y, z: arena.z }
        };
        const before = taskVerifier.capture(bot);
        const executionResult = await toolRegistry.executeToolCall(bot, call);
        await movement.sleep(500);
        const verification = taskVerifier.verify(call, before, taskVerifier.capture(bot), {
            bot,
            executionResult
        });
        if (!verification.ok) throw new Error(verification.reason);

        const unknown = taskVerifier.verify(
            { tool: 'unregistered_world_mutation', args: {} },
            before,
            taskVerifier.capture(bot),
            { bot }
        );
        if (unknown.ok) throw new Error('Unknown tool incorrectly passed verification');

        console.log(`[TASK_VERIFICATION_RESULT] ${JSON.stringify({
            protocol: VERSION,
            blueprint: executionResult.name,
            matched: executionResult.matched,
            expected: executionResult.expected,
            taskVerified: verification.ok,
            unknownRejected: !unknown.ok
        })}`);
    } finally {
        if (arena) {
            bot.chat(`/fill ${arena.x - 3} ${arena.y - 1} ${arena.z - 3} ${arena.x + 12} ${arena.y + 12} ${arena.z + 12} air`);
            await movement.sleep(300);
        }
        bot.end();
        await movement.sleep(300);
    }
}

function createBot() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.once('spawn', async () => {
            await movement.sleep(800);
            resolve(bot);
        });
        bot.once('error', reject);
    });
}

async function prepareArena(bot) {
    const x = Math.floor(bot.entity.position.x);
    const y = 120;
    const z = Math.floor(bot.entity.position.z);
    bot.chat(`/fill ${x - 3} ${y} ${z - 3} ${x + 12} ${y + 12} ${z + 12} air`);
    await movement.sleep(250);
    bot.chat(`/fill ${x - 3} ${y - 1} ${z - 3} ${x + 12} ${y - 1} ${z + 12} stone`);
    await movement.sleep(250);
    bot.chat(`/tp @s ${x - 1.5} ${y} ${z - 1.5}`);
    await movement.sleep(500);
    return { x, y, z };
}

main().catch(error => {
    console.error('[TASK_VERIFICATION_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
