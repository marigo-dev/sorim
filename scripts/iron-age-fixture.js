process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../src/protocol26Shim');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const taskVerifier = require('../src/agent/taskVerifier');
const toolRegistry = require('../src/toolRegistry');
const { buildWorldState, toObservation } = require('../src/perception/stateBuilder');
const movement = require('../src/skills/movement');
const memory = require('../src/skills/memory');
const persistentMemory = require('../src/agent/persistentMemory');
const shelter = require('../src/skills/shelter');
const iron = require('../src/skills/iron');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const USERNAME = process.env.IRON_FIXTURE_USERNAME || 'TaskIron';
const memoryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-iron-age-'));

async function main() {
    memory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'world') });
    persistentMemory.initialize(USERNAME, { directory: path.join(memoryDirectory, 'agent') });
    const bot = await createBot();
    const startedAt = Date.now();
    try {
        const base = await prepare(bot);
        await executeVerified(bot, { tool: 'prepare_mining_kit', args: {} });
        await executeVerified(bot, { tool: 'mine_iron', args: { count: 1 } });

        const rawIron = inventory(bot).raw_iron || 0;
        if (rawIron < 44) {
            await command(bot, `/give ${USERNAME} minecraft:raw_iron ${44 - rawIron}`, 600);
        }
        await executeVerified(bot, {
            tool: 'smelt_item',
            args: { input: 'raw_iron', output: 'iron_ingot', count: 44 }
        });
        await executeVerified(bot, { tool: 'craft_iron_kit', args: {} });
        await executeVerified(bot, { tool: 'craft_iron_armor', args: {} });

        const finalInventory = inventory(bot);
        const finalCapture = taskVerifier.capture(bot, observe(bot));
        const result = {
            protocol: VERSION,
            mode: bot.game?.gameMode,
            elapsedMs: Date.now() - startedAt,
            base,
            coreKit: iron.hasIronCoreItems({ ...finalInventory, ...equipmentCounts(finalCapture.equipment) }),
            fullArmor: iron.hasFullIronArmor({ ...finalInventory, ...equipmentCounts(finalCapture.equipment) }),
            reserve: finalInventory.iron_ingot || 0,
            equipment: finalCapture.equipment,
            inventory: finalInventory
        };
        if (!result.coreKit || !result.fullArmor || result.reserve < 8) {
            throw new Error(`Invalid final iron state ${JSON.stringify(result)}`);
        }
        console.log(`[IRON_AGE_RESULT] ${JSON.stringify(result)}`);
    } finally {
        bot.end();
        await movement.sleep(300);
        persistentMemory.flush();
        fs.rmSync(memoryDirectory, { recursive: true, force: true });
    }
}

async function prepare(bot) {
    await command(bot, '/difficulty peaceful', 200);
    await command(bot, '/time set day', 200);
    await command(bot, '/weather clear', 200);
    await command(bot, `/gamemode survival ${USERNAME}`, 200);
    await command(bot, `/clear ${USERNAME}`, 300);
    await command(bot, `/tp ${USERNAME} ${process.env.IRON_FIXTURE_ANCHOR || '18 67 -32'}`, 900);

    const discovered = discoverVerifiedBase(bot);
    if (!discovered) throw new Error('No verified starter base loaded near the fixture anchor');
    const { base, score } = discovered;
    memory.setBase(base);
    memory.rememberPlacedBlock('crafting_table');
    await command(bot, `/tp ${USERNAME} ${base.x + 0.5} ${base.y} ${base.z + 0.5}`, 500);

    for (const furnace of bot.findBlocks({
        matching: bot.registry.blocksByName.furnace?.id,
        maxDistance: 16,
        count: 16
    })) {
        await command(bot, `/setblock ${furnace.x} ${furnace.y} ${furnace.z} air`, 80);
    }
    for (const [item, count] of [
        ['stone_pickaxe', 2],
        ['cobblestone', 32],
        ['oak_planks', 16],
        ['stick', 8],
        ['bread', 16],
        ['coal', 12]
    ]) {
        await command(bot, `/give ${USERNAME} minecraft:${item} ${count}`, 120);
    }

    const entrance = base.offset(12, 0, 0);
    await command(bot, `/fill ${entrance.x - 2} ${base.y - 1} ${entrance.z - 2} ${entrance.x + 5} ${base.y - 1} ${entrance.z + 2} stone`, 200);
    await command(bot, `/fill ${entrance.x - 2} ${base.y} ${entrance.z - 2} ${entrance.x + 5} ${base.y + 3} ${entrance.z + 2} air`, 200);
    await command(bot, `/setblock ${entrance.x + 2} ${base.y} ${entrance.z} iron_ore`, 500);
    console.log(`[IRON_AGE] base=${base.toString()} shell=${score} ore=${entrance.offset(2, 0, 0).toString()}`);
    return vector(base);
}

async function executeVerified(bot, call) {
    const beforeObservation = observe(bot);
    const before = taskVerifier.capture(bot, beforeObservation);
    console.log(`[IRON_AGE_STEP] tool=${call.tool} args=${JSON.stringify(call.args)}`);
    const executionResult = await toolRegistry.executeToolCall(bot, call);
    await movement.sleep(500);
    const afterObservation = observe(bot);
    const verification = taskVerifier.verify(
        call,
        before,
        taskVerifier.capture(bot, afterObservation),
        { bot, executionResult, beforeObservation, afterObservation }
    );
    if (!verification.ok) {
        throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
    }
    console.log(`[IRON_AGE_VERIFIED] tool=${call.tool} reason=${verification.reason}`);
    return verification;
}

function discoverVerifiedBase(bot) {
    const tableId = bot.registry.blocksByName.crafting_table?.id;
    if (!Number.isInteger(tableId)) return null;
    const candidates = [];
    for (const tablePosition of bot.findBlocks({ matching: tableId, maxDistance: 80, count: 32 })) {
        for (let dx = -4; dx <= 4; dx++) {
            for (let dz = -4; dz <= 4; dz++) {
                const base = tablePosition.offset(dx, 0, dz);
                const score = shelter.scoreShelterShell(bot, base);
                if (score >= shelter.SHELL_TARGET - 4) candidates.push({ base, score });
            }
        }
    }
    return candidates.sort((left, right) => right.score - left.score)[0] || null;
}

function observe(bot) {
    const state = buildWorldState(bot, { base: memory.getBase(), blockRange: 48 });
    return toObservation(state, {
        hasPlacedCraftingTable: memory.hasPlacedBlock('crafting_table'),
        hasPlacedFurnace: memory.hasPlacedBlock('furnace')
    });
}

function inventory(bot) {
    return bot.inventory.items().reduce((counts, item) => {
        counts[item.name] = (counts[item.name] || 0) + item.count;
        return counts;
    }, {});
}

function equipmentCounts(equipment) {
    return (equipment || []).reduce((counts, name) => {
        counts[name] = (counts[name] || 0) + 1;
        return counts;
    }, {});
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

async function command(bot, text, waitMs = 250) {
    bot.chat(text);
    await movement.sleep(waitMs);
}

function vector(position) {
    const value = position instanceof Vec3 ? position : new Vec3(position.x, position.y, position.z);
    return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) };
}

main().catch(error => {
    console.error('[IRON_AGE_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
