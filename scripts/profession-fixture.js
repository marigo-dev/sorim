process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../logger').installConsoleFilter();
const { install26_2PacketFallbacks, install26_2VelocityShim } = require('../protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const movement = require('../skills/movement');
const memory = require('../skills/memory');
const toolRegistry = require('../toolRegistry');
const taskVerifier = require('../agent/taskVerifier');
const ProfessionManager = require('../professions/professionManager');

const FIXTURE = String(process.env.PROFESSION_FIXTURE || 'farmer').toLowerCase();
const FIXTURE_MEMORY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sorim-profession-fixture-'));
const FIXTURES = {
    farmer: { username: 'Bot_Mico', center: new Vec3(3200, 70, 3200) },
    rancher: { username: 'Bot_Mico', center: new Vec3(3240, 70, 3200) },
    fisher: { username: 'Bot_Mico', center: new Vec3(3280, 70, 3200) },
    miner: { username: 'Bot_Mira', center: new Vec3(3320, 70, 3200) },
    shelter: { username: 'Bot_Mico', center: new Vec3(3360, 70, 3200) },
    tools: { username: 'Bot_Mico', center: new Vec3(3400, 70, 3200) },
    combat: { username: 'Bot_Mico', center: new Vec3(3440, 70, 3200) },
    bed: { username: 'Bot_Mico', center: new Vec3(3480, 70, 3200) },
    stone: { username: 'Bot_Mico', center: new Vec3(3520, 70, 3200) },
    smelt: { username: 'Bot_Mico', center: new Vec3(3560, 70, 3200) },
    movement: { username: 'Bot_Mico', center: new Vec3(3600, 70, 3200) }
};

async function main() {
    const fixture = FIXTURES[FIXTURE];
    if (!fixture) {
        throw new Error(`Unknown fixture ${FIXTURE}; use farmer, rancher, fisher, miner, shelter, tools, combat, bed, stone, smelt, or movement`);
    }
    const bot = await createBot(fixture.username);
    try {
        movement.configure(bot);
        memory.initialize(`fixture-${FIXTURE}`, { directory: FIXTURE_MEMORY_DIR });
        await prepareCommon(bot, fixture);
        await prepareFixture(bot, fixture);
        await command(bot, `/gamemode survival ${bot.username}`, 500);
        await command(bot, `/tp ${bot.username} ${fixture.center.x} ${fixture.center.y} ${fixture.center.z}`, 900);
        if (FIXTURE === 'tools') {
            memory.setSurfaceExit(fixture.center);
            await command(
                bot,
                `/tp ${bot.username} ${fixture.center.x + 0.5} ${fixture.center.y - 2} ${fixture.center.z + 0.5}`,
                900
            );
        } else if (FIXTURE !== 'shelter') {
            memory.setBase(fixture.center);
        }

        const observation = observe(bot, FIXTURE);
        const directCall = fixtureToolCall(FIXTURE, bot);
        const manager = directCall ? null : new ProfessionManager(professionStore(FIXTURE));
        let call = directCall || manager.nextTool(observation);
        if (!call) throw new Error(`Profession ${FIXTURE} did not select a tool`);
        if (FIXTURE === 'miner') call = { ...call, args: { count: 1 } };

        console.log(`[FIXTURE] profession=${FIXTURE} tool=${JSON.stringify(call)}`);
        const before = taskVerifier.capture(bot, observation);
        const movementTelemetry = FIXTURE === 'movement' ? trackMovement(bot) : null;
        const executionResult = await toolRegistry.executeToolCall(bot, call);
        const telemetry = movementTelemetry?.stop();
        if (telemetry) {
            console.log(`[MOVEMENT_RESULT] ${JSON.stringify(telemetry)}`);
            if (telemetry.sprintTicks > 0) throw new Error('Movement fixture used sprint unexpectedly');
            if (telemetry.peakBlocksPerSecond > 6.2) {
                throw new Error(`Movement speed spiked to ${telemetry.peakBlocksPerSecond} blocks/s`);
            }
        }
        await movement.sleep(800);
        const afterObservation = observe(bot, FIXTURE);
        const verification = taskVerifier.verify(
            call,
            before,
            taskVerifier.capture(bot, afterObservation),
            { bot, executionResult, beforeObservation: observation, afterObservation }
        );
        console.log(`[FIXTURE_RESULT] ${JSON.stringify(verification)}`);
        if (!verification.ok || verification.details?.fallback) {
            throw new taskVerifier.TaskVerificationError(verification.reason, verification.details);
        }
        if (FIXTURE === 'movement') await runAdditionalMovementScenarios(bot, fixture.center);
    } finally {
        movement.stop(bot);
        bot.end();
        await movement.sleep(500);
        fs.rmSync(FIXTURE_MEMORY_DIR, { recursive: true, force: true });
    }
}

function createBot(username) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({
            host: process.env.MC_HOST || 'localhost',
            port: Number(process.env.MC_PORT || 25566),
            username,
            version: process.env.MC_VERSION
        });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.loadPlugin(pathfinder);
        bot.once('spawn', () => setTimeout(() => resolve(bot), 1200));
        bot.once('error', reject);
    });
}

async function prepareCommon(bot, fixture) {
    const center = fixture.center;
    await command(bot, `/gamemode creative ${bot.username}`, 400);
    await command(bot, `/tp ${bot.username} ${center.x} ${center.y + 12} ${center.z}`, 1200);
    await command(bot, `/fill ${center.x - 12} ${center.y - 12} ${center.z - 12} ${center.x + 12} ${center.y - 1} ${center.z + 12} stone`, 900);
    await command(bot, `/fill ${center.x - 12} ${center.y} ${center.z - 12} ${center.x + 12} ${center.y + 8} ${center.z + 12} air`, 900);
    await command(bot, '/kill @e[type=minecraft:item,distance=..30]', 300);
    await command(bot, '/time set day', 300);
    await command(bot, `/clear ${bot.username}`, 300);
}

async function prepareFixture(bot, fixture) {
    const { center } = fixture;
    if (FIXTURE === 'farmer') {
        await command(bot, `/fill ${center.x - 10} ${center.y - 1} ${center.z - 10} ${center.x + 10} ${center.y - 1} ${center.z + 10} dirt`, 500);
        await give(bot, 'water_bucket', 1);
        await give(bot, 'stone_hoe', 1);
        await give(bot, 'wheat_seeds', 16);
        return;
    }
    if (FIXTURE === 'rancher') {
        await give(bot, 'wheat', 8);
        await command(bot, `/summon cow ${center.x + 3} ${center.y} ${center.z}`, 250);
        await command(bot, `/summon cow ${center.x + 5} ${center.y} ${center.z}`, 500);
        return;
    }
    if (FIXTURE === 'fisher') {
        await give(bot, 'fishing_rod', 1);
        await command(bot, `/fill ${center.x + 2} ${center.y - 3} ${center.z - 4} ${center.x + 10} ${center.y - 1} ${center.z + 4} stone`, 500);
        await command(bot, `/fill ${center.x + 3} ${center.y - 2} ${center.z - 3} ${center.x + 9} ${center.y - 1} ${center.z + 3} water`, 900);
        return;
    }
    if (FIXTURE === 'miner') {
        for (const [item, count] of [
            ['stone_pickaxe', 1], ['stone_sword', 1], ['furnace', 1], ['coal', 8],
            ['torch', 16], ['cobblestone', 32], ['bread', 16]
        ]) await give(bot, item, count);
        await command(bot, `/setblock ${center.x + 14} ${center.y} ${center.z} iron_ore`, 600);
        return;
    }
    if (FIXTURE === 'shelter') {
        await give(bot, 'oak_planks', 48);
        await give(bot, 'cobblestone', 16);
        await give(bot, 'stone_pickaxe', 1);
        await give(bot, 'stone_axe', 1);
        await give(bot, 'stone_sword', 1);
        return;
    }
    if (FIXTURE === 'tools') {
        await command(bot, `/setblock ${center.x} ${center.y - 1} ${center.z} air`, 300);
        await command(bot, `/setblock ${center.x} ${center.y - 2} ${center.z} air`, 300);
        await command(bot, `/setblock ${center.x + 3} ${center.y} ${center.z} crafting_table`, 300);
        await give(bot, 'cobblestone', 16);
        await give(bot, 'dirt', 4);
        await give(bot, 'oak_planks', 12);
        await give(bot, 'stick', 5);
        return;
    }
    if (FIXTURE === 'combat') {
        await command(bot, '/difficulty easy', 300);
        await command(bot, '/kill @e[type=minecraft:husk,distance=..30]', 400);
        await give(bot, 'stone_sword', 1);
        await command(
            bot,
            `/summon husk ${center.x + 3} ${center.y} ${center.z} {PersistenceRequired:1b}`,
            700
        );
        return;
    }
    if (FIXTURE === 'bed') {
        await command(bot, '/kill @e[type=minecraft:sheep,distance=..30]', 400);
        await command(bot, `/setblock ${center.x + 1} ${center.y} ${center.z} crafting_table`, 400);
        await give(bot, 'oak_planks', 6);
        await give(bot, 'stone_sword', 1);
        for (let index = 0; index < 3; index++) {
            await command(
                bot,
                `/summon sheep ${center.x + 8 + index} ${center.y} ${center.z} {Color:0b,PersistenceRequired:1b}`,
                300
            );
        }
        return;
    }
    if (FIXTURE === 'stone') {
        await give(bot, 'wooden_pickaxe', 1);
        return;
    }
    if (FIXTURE === 'smelt') {
        await command(bot, `/setblock ${center.x + 2} ${center.y} ${center.z} furnace`, 500);
        await give(bot, 'birch_log', 2);
        await give(bot, 'wooden_pickaxe', 1);
        return;
    }
    if (FIXTURE === 'movement') {
        await command(bot, `/fill ${center.x} ${center.y} ${center.z - 1} ${center.x + 7} ${center.y + 2} ${center.z - 1} stone`, 400);
        await command(bot, `/fill ${center.x} ${center.y} ${center.z + 1} ${center.x + 7} ${center.y + 2} ${center.z + 1} stone`, 400);
        await command(bot, `/setblock ${center.x + 2} ${center.y} ${center.z} stone`, 400);
    }
}

function fixtureToolCall(id, bot) {
    if (id === 'shelter') {
        return { tool: 'build_shelter', args: {}, reason: 'Fixture: build a verified starter shelter' };
    }
    if (id === 'tools') {
        return { tool: 'craft_stone_tools', args: {}, reason: 'Fixture: escape a shallow shaft and craft stone tools' };
    }
    if (id === 'combat') {
        const target = Object.values(bot.entities || {})
            .find(entity => entity.name === 'husk' && entity.position?.distanceTo(bot.entity.position) <= 12);
        if (!target) throw new Error('Combat fixture husk was not visible');
        return { tool: 'fight_mob', args: { entityId: target.id }, reason: 'Fixture: defeat one melee hostile' };
    }
    if (id === 'bed') {
        return { tool: 'secure_bed', args: {}, reason: 'Fixture: collect wool and place a bed' };
    }
    if (id === 'stone') {
        return { tool: 'collect_stone', args: { count: 16 }, reason: 'Fixture: collect stone from empty surface' };
    }
    if (id === 'smelt') {
        return {
            tool: 'smelt_item',
            args: { input: 'birch_log', output: 'charcoal', count: 1 },
            reason: 'Fixture: smelt one log with a legacy wooden tool'
        };
    }
    if (id === 'movement') {
        const center = FIXTURES.movement.center;
        return {
            tool: 'move_near',
            args: { x: center.x + 6, y: center.y, z: center.z, range: 1 },
            reason: 'Fixture: walk smoothly over one full block in a narrow corridor'
        };
    }
    return null;
}

function professionStore(id) {
    return {
        getProfession: () => ({ id, status: 'active', assignedBy: 'fixture' }),
        setProfession: () => {},
        stopProfession: () => {}
    };
}

function observe(bot, profession) {
    const inventory = {};
    for (const item of bot.inventory.items()) inventory[item.name] = (inventory[item.name] || 0) + item.count;
    return {
        health: bot.health,
        food: bot.food,
        position: position(bot.entity.position),
        inventory,
        inventoryText: Object.entries(inventory).map(([name, count]) => `${name}:${count}`).join(', ') || 'empty',
        nearbyBlocks: [],
        nearbyMobs: [],
        base: memory.getBase(),
        farmReady: profession === 'farmer' ? false : undefined,
        hasMatureCrop: false,
        hasUsableChest: false,
        lastError: null
    };
}

async function give(bot, item, count) {
    return command(bot, `/give ${bot.username} ${item} ${count}`, 300);
}

async function command(bot, text, waitMs) {
    bot.chat(text);
    await movement.sleep(waitMs);
}

function position(value) {
    return { x: Math.floor(value.x), y: Math.floor(value.y), z: Math.floor(value.z) };
}

function trackMovement(bot) {
    const samples = [];
    let peakBlocksPerSecond = 0;
    let sprintTicks = 0;
    const sample = () => {
        const now = Date.now();
        const current = bot.entity?.position?.clone();
        if (!current) return;
        if (bot.controlState?.sprint) sprintTicks++;
        samples.push({ at: now, position: current });
        while (samples.length > 1 && now - samples[0].at > 500) samples.shift();
        const reference = samples.find(sample => now - sample.at >= 250);
        if (reference) {
            const elapsedSeconds = (now - reference.at) / 1000;
            const horizontal = Math.hypot(
                current.x - reference.position.x,
                current.z - reference.position.z
            );
            peakBlocksPerSecond = Math.max(peakBlocksPerSecond, horizontal / elapsedSeconds);
        }
    };
    bot.on('physicsTick', sample);
    return {
        stop() {
            bot.removeListener('physicsTick', sample);
            return {
                sprintTicks,
                peakBlocksPerSecond: Number(peakBlocksPerSecond.toFixed(2))
            };
        }
    };
}

async function runAdditionalMovementScenarios(bot, center) {
    await runDiagonalStepScenario(bot, center.offset(20, 0, 0));
    await runUnevenSlopeScenario(bot, center.offset(40, 0, 0));
    await runWallStopScenario(bot, center.offset(60, 0, 0));
}

async function runDiagonalStepScenario(bot, origin) {
    await resetMovementArea(bot, origin);
    await command(bot, `/setblock ${origin.x + 1} ${origin.y} ${origin.z + 1} stone`, 300);
    await command(bot, `/gamemode survival ${bot.username}`, 250);
    await command(bot, `/tp ${bot.username} ${origin.x} ${origin.y} ${origin.z}`, 700);
    const telemetry = trackMovement(bot);
    const moved = await movement.walkToward(bot, origin.offset(3, 1, 3), { durationMs: 2200 });
    const result = telemetry.stop();
    const position = bot.entity.position;
    const onStep = Math.abs(position.y - (origin.y + 1)) <= 0.12 &&
        Math.abs(position.x - (origin.x + 1.5)) <= 0.9 &&
        Math.abs(position.z - (origin.z + 1.5)) <= 0.9;
    assertMovementScenario('diagonal_step', moved && onStep, result, position);
}

async function runUnevenSlopeScenario(bot, origin) {
    await resetMovementArea(bot, origin);
    await command(bot, `/fill ${origin.x - 1} ${origin.y} ${origin.z - 1} ${origin.x + 8} ${origin.y + 2} ${origin.z - 1} stone`, 300);
    await command(bot, `/fill ${origin.x - 1} ${origin.y} ${origin.z + 1} ${origin.x + 8} ${origin.y + 2} ${origin.z + 1} stone`, 300);
    await command(bot, `/fill ${origin.x + 2} ${origin.y} ${origin.z} ${origin.x + 4} ${origin.y} ${origin.z} stone`, 300);
    await command(bot, `/gamemode survival ${bot.username}`, 250);
    await command(bot, `/tp ${bot.username} ${origin.x} ${origin.y} ${origin.z}`, 700);
    const telemetry = trackMovement(bot);
    let reached = false;
    for (let attempt = 0; attempt < 3; attempt++) {
        reached = await movement.moveTowardSafely(bot, origin.offset(7, 0, 0), 14) || reached;
        const remaining = Math.hypot(
            bot.entity.position.x - (origin.x + 7.5),
            bot.entity.position.z - (origin.z + 0.5)
        );
        if (remaining <= 2.25 && Math.abs(bot.entity.position.y - origin.y) <= 0.12) break;
    }
    const result = telemetry.stop();
    const distance = Math.hypot(
        bot.entity.position.x - (origin.x + 7.5),
        bot.entity.position.z - (origin.z + 0.5)
    );
    const descendedToGround = Math.abs(bot.entity.position.y - origin.y) <= 0.12;
    assertMovementScenario('uneven_slope', reached && distance <= 2.25 && descendedToGround, result, bot.entity.position);
}

async function runWallStopScenario(bot, origin) {
    await resetMovementArea(bot, origin);
    await command(bot, `/fill ${origin.x + 2} ${origin.y} ${origin.z - 1} ${origin.x + 2} ${origin.y + 1} ${origin.z + 1} stone`, 300);
    await command(bot, `/gamemode survival ${bot.username}`, 250);
    await command(bot, `/tp ${bot.username} ${origin.x} ${origin.y} ${origin.z}`, 700);
    const telemetry = trackMovement(bot);
    await movement.walkToward(bot, origin.offset(5, 0, 0), { durationMs: 1800 });
    const result = telemetry.stop();
    const stoppedBeforeWall = bot.entity.position.x < origin.x + 1.75;
    const grounded = Math.abs(bot.entity.position.y - origin.y) <= 0.12;
    assertMovementScenario('wall_stop', stoppedBeforeWall && grounded, result, bot.entity.position);
}

async function resetMovementArea(bot, origin) {
    await command(bot, `/gamemode creative ${bot.username}`, 250);
    await command(bot, `/fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 4} ${origin.x + 10} ${origin.y + 4} ${origin.z + 4} air`, 300);
    await command(bot, `/fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 4} ${origin.x + 10} ${origin.y - 1} ${origin.z + 4} stone`, 300);
}

function assertMovementScenario(name, ok, telemetry, position) {
    const result = {
        ok,
        sprintTicks: telemetry.sprintTicks,
        peakBlocksPerSecond: telemetry.peakBlocksPerSecond,
        position: position.toString()
    };
    console.log(`[MOVEMENT_SCENARIO] ${name} ${JSON.stringify(result)}`);
    if (!ok) throw new Error(`Movement scenario ${name} did not reach its physical acceptance state`);
    if (telemetry.sprintTicks > 0) throw new Error(`Movement scenario ${name} used sprint unexpectedly`);
    if (telemetry.peakBlocksPerSecond > 6.2) {
        throw new Error(`Movement scenario ${name} speed spiked to ${telemetry.peakBlocksPerSecond} blocks/s`);
    }
}

main().catch(error => {
    console.error('[FIXTURE_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
