process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Vec3 } = require('vec3');
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../src/protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const taskVerifier = require('../src/agent/taskVerifier');
const toolRegistry = require('../src/toolRegistry');
const { buildWorldState, toObservation } = require('../src/perception/stateBuilder');
const movement = require('../src/skills/movement');
const memory = require('../src/skills/memory');
const persistentMemory = require('../src/agent/persistentMemory');
const food = require('../src/skills/food');
const homestead = require('../src/skills/homestead');
const shelter = require('../src/skills/shelter');
const storage = require('../src/skills/storage');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.FOOD_FARM_USERNAME || 'TaskFarm';
const FIXTURE_SHELL_MINIMUM = shelter.SHELL_TARGET - 4;
const memoryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-food-farm-'));

async function main() {
    memory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'world') });
    persistentMemory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'agent') });
    const bot = await createBot();
    const startedAt = Date.now();
    try {
        const farmSite = await prepare(bot);
        await executeVerified(bot, {
            tool: 'establish_wheat_farm',
            args: { site: vector(farmSite), alreadyOutside: true }
        });

        let foodVerification = null;
        for (let attempt = 1; attempt <= 12; attempt++) {
            await matureWheat(bot);
            await positionAtFarm(bot);
            foodVerification = await executeVerified(bot, {
                tool: 'maintain_food_supply',
                args: { minimum: 16, alreadyOutside: true, expandFarm: false }
            }, { allowFailure: true });
            console.log(`[FOOD_FARM] reserve attempt=${attempt} result=${foodVerification.reason}`);
            if (foodVerification.ok) break;
        }
        if (!foodVerification?.ok) throw new Error(foodVerification?.reason || 'Food reserve was not completed');

        bot.chat(`/give ${USERNAME} minecraft:dirt 40`);
        await movement.sleep(500);
        await executeVerified(bot, { tool: 'organize_storage', args: {} });

        const center = homestead.findFarmCenter(bot);
        const inventory = observe(bot).inventory;
        const result = {
            protocol: VERSION,
            mode: bot.game?.gameMode,
            elapsedMs: Date.now() - startedAt,
            base: memory.getBase(),
            farmCenter: center ? vector(center) : null,
            farmCapacity: homestead.farmCapacity(bot, center),
            foodCount: food.foodCount(inventory),
            chestReady: storage.hasChestNearby(bot),
            inventory
        };
        if (result.foodCount < 16 || result.farmCapacity < 6 || !result.chestReady) {
            throw new Error(`Invalid final state ${JSON.stringify(result)}`);
        }
        console.log(`[FOOD_FARM_RESULT] ${JSON.stringify(result)}`);
    } finally {
        bot.end();
        await movement.sleep(300);
        persistentMemory.flush();
        fs.rmSync(memoryDirectory, { recursive: true, force: true });
    }
}

async function executeVerified(bot, call, options = {}) {
    const beforeObservation = observe(bot);
    const before = taskVerifier.capture(bot, beforeObservation);
    try {
        const executionResult = await toolRegistry.executeToolCall(bot, call);
        await movement.sleep(350);
        const afterObservation = observe(bot);
        const verification = taskVerifier.verify(
            call,
            before,
            taskVerifier.capture(bot, afterObservation),
            { bot, executionResult, beforeObservation, afterObservation }
        );
        if (!verification.ok && !options.allowFailure) {
            throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
        }
        return verification;
    } catch (error) {
        if (options.allowFailure && error instanceof taskVerifier.TaskVerificationError) {
            return { ok: false, reason: error.message, details: error.details || {} };
        }
        throw error;
    }
}

async function prepare(bot) {
    bot.chat('/difficulty peaceful');
    bot.chat('/time set day');
    bot.chat('/weather clear');
    bot.chat(`/gamemode survival ${USERNAME}`);
    bot.chat(`/clear ${USERNAME}`);
    const anchor = process.env.FOOD_FARM_ANCHOR || '18 67 -32';
    bot.chat(`/tp ${USERNAME} ${anchor}`);
    await movement.sleep(1200);

    const discovered = discoverVerifiedBase(bot);
    if (!discovered) throw new Error('No verified starter base was loaded within 160 blocks');
    const { base, table, score } = discovered;
    memory.setBase(base);
    memory.rememberPlacedBlock('crafting_table');
    bot.chat(`/tp ${USERNAME} ${base.x + 0.5} ${base.y} ${base.z + 0.5}`);
    await movement.sleep(500);
    await clearFixtureFarm(bot);
    bot.chat(`/give ${USERNAME} minecraft:stone_hoe 1`);
    bot.chat(`/give ${USERNAME} minecraft:wheat_seeds 16`);
    await movement.sleep(900);
    const waterAnchor = process.env.FOOD_FARM_WATER_ANCHOR || '16 63 -50';
    bot.chat(`/tp ${USERNAME} ${waterAnchor}`);
    await movement.sleep(700);
    const farmSite = await prepareFlatNaturalWaterSite(bot);
    bot.chat(`/tp ${USERNAME} ${farmSite.x + 0.5} ${farmSite.y} ${farmSite.z + 0.5}`);
    await movement.sleep(500);
    console.log(`[FOOD_FARM] base=${base.toString()} table=${table.position.toString()} shell=${score}`);
    return farmSite;
}

async function prepareFlatNaturalWaterSite(bot) {
    const water = bot.findBlock({ matching: block => block?.name === 'water', maxDistance: 32 });
    if (!water) throw new Error('No natural water source is loaded for the fixture farm');
    const center = water.position.offset(3, 1, 0);
    for (let dx = -5; dx <= 5; dx++) {
        for (let dz = -5; dz <= 5; dz++) {
            const ground = center.offset(dx, -1, dz);
            if (ground.equals(water.position)) continue;
            bot.chat(`/setblock ${ground.x} ${ground.y} ${ground.z} minecraft:dirt`);
            bot.chat(`/setblock ${ground.x} ${ground.y + 1} ${ground.z} minecraft:air`);
            bot.chat(`/setblock ${ground.x} ${ground.y + 2} ${ground.z} minecraft:air`);
        }
    }
    bot.chat(`/setblock ${water.position.x} ${water.position.y} ${water.position.z} minecraft:water`);
    await movement.sleep(900);
    if (!homestead.hasHydrationWater(bot, center)) {
        throw new Error(`Prepared fixture site ${center.toString()} is not hydrated by natural water`);
    }
    return center;
}

async function clearFixtureFarm(bot) {
    const cropNames = new Set(['wheat']);
    const positions = bot.findBlocks({
        matching: block => cropNames.has(block?.name) || block?.name === 'farmland',
        maxDistance: 80,
        count: 256
    });
    for (const position of positions) {
        const name = bot.blockAt(position)?.name;
        const replacement = name === 'farmland' ? 'minecraft:dirt' : 'minecraft:air';
        bot.chat(`/setblock ${position.x} ${position.y} ${position.z} ${replacement}`);
    }
    if (positions.length > 0) await movement.sleep(600);
    console.log(`[FOOD_FARM] clearedFixtureBlocks=${positions.length}`);
}

function discoverVerifiedBase(bot) {
    const tableId = bot.registry.blocksByName.crafting_table?.id;
    if (!Number.isInteger(tableId)) return null;
    const candidates = [];
    const tablePositions = bot.findBlocks({ matching: tableId, maxDistance: 160, count: 64 });
    let bestObservedScore = 0;
    for (const tablePosition of tablePositions) {
        const table = bot.blockAt(tablePosition);
        if (!table) continue;
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                const base = tablePosition.offset(dx, 0, dz);
                const score = shelter.scoreShelterShell(bot, base);
                bestObservedScore = Math.max(bestObservedScore, score);
                if (score >= FIXTURE_SHELL_MINIMUM) candidates.push({ base, table, score });
            }
        }
    }
    console.log(`[FOOD_FARM] tables=${tablePositions.length} bestObservedShell=${bestObservedScore}`);
    return candidates.sort((left, right) =>
        right.score - left.score ||
        left.base.distanceTo(bot.entity.position) - right.base.distanceTo(bot.entity.position)
    )[0] || null;
}

async function matureWheat(bot) {
    const center = homestead.findFarmCenter(bot);
    if (!center) return;
    for (const position of homestead.farmPlotPositions(center)) {
        if (bot.blockAt(position)?.name !== 'wheat') continue;
        bot.chat(`/setblock ${position.x} ${position.y} ${position.z} minecraft:wheat[age=7]`);
    }
    await movement.sleep(350);
}

async function positionAtFarm(bot) {
    const center = homestead.findFarmCenter(bot);
    if (!center) throw new Error('Farm center disappeared before food maintenance');
    bot.chat(`/tp ${USERNAME} ${center.x + 0.5} ${center.y} ${center.z + 0.5}`);
    await movement.sleep(350);
}

function observe(bot) {
    return toObservation(buildWorldState(bot, { base: memory.getBase(), blockRange: 48 }), {
        farmReady: homestead.farmCapacity(bot) >= 6,
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

function vector(value) {
    const position = value instanceof Vec3 ? value : new Vec3(value.x, value.y, value.z);
    return { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
}

main().catch(error => {
    console.error('[FOOD_FARM_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
