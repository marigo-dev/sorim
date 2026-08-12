process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const TaskQueue = require('../agent/taskQueue');
const { PreconditionResolver } = require('../agent/preconditionResolver');
const taskVerifier = require('../agent/taskVerifier');
const toolRegistry = require('../toolRegistry');
const { buildWorldState, toObservation } = require('../perception/stateBuilder');
const movement = require('../skills/movement');
const memory = require('../skills/memory');
const persistentMemory = require('../agent/persistentMemory');
const storage = require('../skills/storage');
const shelter = require('../skills/shelter');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.TASK_CHAIN_USERNAME || 'TaskChain';
const memoryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-task-chain-'));

async function main() {
    memory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'world') });
    persistentMemory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'agent') });
    const bot = await createBot();
    const stopLagMonitor = monitorEventLoop();
    const queue = new TaskQueue(persistentMemory, { preconditionResolver: new PreconditionResolver() });
    const startedAt = Date.now();
    try {
        await prepareNaturalStart(bot);
        queue.enqueue({
            id: `task_chain_${Date.now()}`,
            goal: 'collect 16 wood, build a safe base, return home, and organize storage',
            requestedBy: 'fixture',
            steps: [
                { tool: 'mine_block', args: { target: 'any_log', count: 16 }, reason: 'collect sixteen fresh logs' },
                { tool: 'ensure_base', args: {}, reason: 'build the verified 5x5 starter base' },
                { tool: 'return_base', args: {}, reason: 'return inside the remembered base' },
                { tool: 'organize_storage', args: {}, reason: 'deposit excess inventory into the base chest' }
            ]
        });

        let completedSteps = 0;
        for (let iteration = 0; iteration < 24 && queue.active(); iteration++) {
            const observation = observe(bot);
            const call = queue.toolCall({ observation, bot });
            if (!call) throw new Error('Task queue returned no executable step');
            const before = taskVerifier.capture(bot, observation);
            console.log(`[TASK_CHAIN] iteration=${iteration + 1} tool=${call.tool} args=${JSON.stringify(call.args)}`);
            try {
                const executionResult = await toolRegistry.executeToolCall(bot, call);
                await movement.sleep(400);
                const afterObservation = observe(bot);
                const verification = taskVerifier.verify(call, before, taskVerifier.capture(bot, afterObservation), {
                    bot,
                    executionResult,
                    beforeObservation: observation,
                    afterObservation
                });
                if (!verification.ok) throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
                queue.completeCurrentStep(verification);
                completedSteps++;
                console.log(`[TASK_CHAIN_VERIFIED] tool=${call.tool} reason=${verification.reason}`);
            } catch (error) {
                const failure = queue.failCurrentStep(error);
                console.log(`[TASK_CHAIN_RETRY] tool=${call.tool} error=${error.message}`);
                if (failure?.taskFailed) throw error;
            }
        }

        if (queue.active()) throw new Error('Task chain did not finish within 24 queue iterations');
        const base = memory.getBase();
        const shellScore = base ? shelter.scoreShelterShell(bot, base) : 0;
        const chestReady = storage.hasChestNearby(bot);
        if (!base || shellScore < shelter.SHELL_TARGET || !chestReady) {
            throw new Error(`Final world state invalid base=${Boolean(base)} shell=${shellScore} chest=${chestReady}`);
        }
        console.log(`[TASK_CHAIN_RESULT] ${JSON.stringify({
            protocol: VERSION,
            mode: bot.game?.gameMode,
            completedSteps,
            elapsedMs: Date.now() - startedAt,
            base,
            shellScore,
            chestReady,
            inventory: observe(bot).inventory
        })}`);
    } finally {
        stopLagMonitor();
        bot.chat('/difficulty easy');
        await movement.sleep(150);
        bot.end();
        await movement.sleep(300);
        persistentMemory.flush();
        fs.rmSync(memoryDirectory, { recursive: true, force: true });
    }
}

function monitorEventLoop() {
    let expected = Date.now() + 1000;
    const timer = setInterval(() => {
        const now = Date.now();
        const lagMs = now - expected;
        if (lagMs >= 1000) console.log(`[TASK_CHAIN_LAG] eventLoopLagMs=${lagMs}`);
        expected = now + 1000;
    }, 1000);
    return () => clearInterval(timer);
}

function observe(bot) {
    return toObservation(buildWorldState(bot, { base: memory.getBase(), blockRange: 48 }), {
        hasUsableChest: storage.hasChestNearby(bot),
        hasPlacedCraftingTable: memory.hasPlacedBlock('crafting_table')
    });
}

function createBot() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: USERNAME, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', async () => {
            movement.configure(bot);
            await movement.sleep(1200);
            resolve(bot);
        });
        bot.once('error', reject);
    });
}

async function prepareNaturalStart(bot) {
    bot.chat('/difficulty peaceful');
    bot.chat('/time set day');
    bot.chat('/weather clear');
    bot.chat(`/gamemode survival ${USERNAME}`);
    bot.chat(`/clear ${USERNAME}`);
    await movement.sleep(800);
    const roots = bot.findBlocks({
        matching: block => Boolean(block?.name?.endsWith('_log')),
        maxDistance: 160,
        count: 256
    }).map(position => bot.blockAt(position)).filter(Boolean)
        .filter(log => !bot.blockAt(log.position.offset(0, -1, 0))?.name?.endsWith('_log'))
        .filter(log => hasNaturalTreeShape(bot, log));
    const starts = roots
        .map(log => ({
            log,
            stand: findSafeStandNear(bot, log.position),
            nearbyTrees: roots.filter(other =>
                Math.hypot(other.position.x - log.position.x, other.position.z - log.position.z) <= 40 &&
                Math.abs(other.position.y - log.position.y) <= 12
            ).length
        }))
        .filter(entry => entry.stand)
        .sort((left, right) =>
            right.nearbyTrees - left.nearbyTrees ||
            left.stand.distanceTo(bot.entity.position) - right.stand.distanceTo(bot.entity.position)
        );
    const start = starts[0];
    if (!start) throw new Error('No naturally generated tree with a safe root-level stand was loaded within 160 blocks');
    const { log, stand } = start;
    bot.chat(`/tp @s ${stand.x + 0.5} ${stand.y} ${stand.z + 0.5}`);
    await movement.sleep(700);
    console.log(
        `[TASK_CHAIN] natural tree=${log.name}@${log.position.toString()} ` +
        `start=${stand.toString()} nearbyTrees=${start.nearbyTrees}`
    );
}

function hasNaturalTreeShape(bot, root) {
    let trunkHeight = 0;
    let top = root.position;
    for (let dy = 0; dy <= 12; dy++) {
        const block = bot.blockAt(root.position.offset(0, dy, 0));
        if (block?.name !== root.name) break;
        trunkHeight++;
        top = block.position;
    }
    if (trunkHeight < 2) return false;

    let leaves = 0;
    for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
            for (let dz = -3; dz <= 3; dz++) {
                if (bot.blockAt(top.offset(dx, dy, dz))?.name?.endsWith('_leaves')) leaves++;
                if (leaves >= 4) return true;
            }
        }
    }
    return false;
}

function findSafeStandNear(bot, origin) {
    const candidates = [];
    for (let radius = 2; radius <= 5; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
            for (let dz = -radius; dz <= radius; dz++) {
                for (let dy = -1; dy <= 1; dy++) {
                    const position = origin.offset(dx, dy, dz);
                    const feet = bot.blockAt(position);
                    const head = bot.blockAt(position.offset(0, 1, 0));
                    const floor = bot.blockAt(position.offset(0, -1, 0));
                    if (passable(feet) && passable(head) && floor?.boundingBox === 'block' && supportedNeighborhood(bot, position) >= 6) {
                        candidates.push(position);
                    }
                }
            }
        }
        if (candidates.length > 0) break;
    }
    return candidates.sort((left, right) => left.distanceTo(origin) - right.distanceTo(origin))[0] || null;
}

function supportedNeighborhood(bot, origin) {
    let score = 0;
    for (let dx = -1; dx <= 1; dx++) {
        for (let dz = -1; dz <= 1; dz++) {
            const position = origin.offset(dx, 0, dz);
            if (passable(bot.blockAt(position)) && passable(bot.blockAt(position.offset(0, 1, 0))) &&
                bot.blockAt(position.offset(0, -1, 0))?.boundingBox === 'block') score++;
        }
    }
    return score;
}

function passable(block) {
    return !block || block.boundingBox === 'empty' || ['air', 'cave_air', 'void_air', 'short_grass', 'tall_grass'].includes(block.name);
}

main().catch(error => {
    console.error('[TASK_CHAIN_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
