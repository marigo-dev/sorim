process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const {
    install26_2PacketFallbacks,
    install26_2VelocityShim
} = require('../src/protocol26Shim');

const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const path = require('node:path');
const movement = require('../src/skills/movement');
const { MovementTelemetry, writeReport } = require('../src/diagnostics/movementTelemetry');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const CENTER = new Vec3(3800, 70, 3200);
const OUTPUT = process.env.MOVEMENT_REPORT_DIR || path.join(__dirname, '..', 'artifacts', 'movement');

async function main() {
    const actor = await createBot('Bot_Mico', true);
    const telemetry = new MovementTelemetry(actor, null, { sampleMs: 100 });
    try {
        movement.configure(actor);
        await command(actor, `/gamemode survival ${actor.username}`, 200);
        await command(actor, `/tp ${actor.username} ${CENTER.x + 0.5} ${CENTER.y} ${CENTER.z + 0.5}`, 500);

        await flatWalk(actor, telemetry, CENTER);
        await diagonalStep(actor, telemetry, CENTER.offset(24, 0, 0));
        await shallowPitExit(actor, telemetry, CENTER.offset(36, 0, 0));
        await unevenSlope(actor, telemetry, CENTER.offset(48, 0, 0));
        await wallStop(actor, telemetry, CENTER.offset(72, 0, 0));

        const report = telemetry.report({ host: HOST, port: PORT, version: VERSION });
        const files = writeReport(report, OUTPUT);
        for (const scenario of report.scenarios) {
            console.log(`[MOVEMENT_BENCHMARK] ${scenario.name} ${JSON.stringify({
                passed: scenario.passed,
                measured: scenario.measured,
                measuredSource: scenario.measuredSource,
                stuckMs: scenario.commandedStationaryMs,
                airborneStationaryMs: scenario.airborneStationaryMs,
                divergence: scenario.maximumDivergence,
                divergenceMs: scenario.divergenceMs,
                failures: scenario.failures
            })}`);
        }
        console.log(`[MOVEMENT_REPORT] ${JSON.stringify({ passed: report.passed, ...files })}`);
        if (!report.passed) process.exitCode = 1;
    } finally {
        movement.stop(actor);
        actor.end();
        await movement.sleep(500);
    }
}

async function flatWalk(bot, telemetry, origin) {
    await resetArea(bot, origin);
    await placeActor(bot, origin);
    telemetry.startScenario('flat_walk');
    let accepted = true;
    let reason = null;
    try {
        await movement.moveNear(bot, origin.offset(6, 0, 0), 0.6, 12000);
    } catch (caught) {
        accepted = false;
        reason = caught.message;
    }
    await movement.sleep(350);
    telemetry.stopScenario({ minimumDisplacement: 3.5, maximumSpeed: 6.2, accepted, reason });
}

async function diagonalStep(bot, telemetry, origin) {
    await resetArea(bot, origin);
    await command(bot, `/setblock ${origin.x + 1} ${origin.y} ${origin.z + 1} stone`, 300);
    await placeActor(bot, origin);
    telemetry.startScenario('diagonal_step');
    let error = null;
    try {
        await movement.moveBlock(bot, origin.offset(1, 1, 1), 12000);
    } catch (caught) {
        error = caught;
    }
    const position = bot.entity.position;
    const accepted = !error && position.y >= origin.y + 0.8;
    await movement.sleep(350);
    telemetry.stopScenario({
        minimumDisplacement: 0.6,
        accepted,
        reason: error?.message || 'did not climb diagonal step'
    });
}

async function shallowPitExit(bot, telemetry, origin) {
    await resetArea(bot, origin);
    await command(bot, `/setblock ${origin.x} ${origin.y - 1} ${origin.z} air`, 250);
    await command(bot, `/setblock ${origin.x} ${origin.y - 2} ${origin.z} stone`, 250);
    await command(bot, `/gamemode survival ${bot.username}`, 200);
    await command(bot, `/tp ${bot.username} ${origin.x + 0.5} ${origin.y - 1} ${origin.z + 0.5}`, 700);
    movement.stop(bot);
    telemetry.startScenario('shallow_pit_exit');
    let error = null;
    try {
        await movement.moveNear(bot, origin.offset(3, 0, 0), 1, 12000);
    } catch (caught) {
        error = caught;
    }
    const accepted = !error && bot.entity.position.y >= origin.y - 0.15;
    await movement.sleep(350);
    telemetry.stopScenario({
        minimumDisplacement: 0.6,
        accepted,
        reason: error?.message || 'did not climb out of one-block pit'
    });
}

async function unevenSlope(bot, telemetry, origin) {
    await resetArea(bot, origin);
    await command(bot, `/fill ${origin.x + 2} ${origin.y} ${origin.z} ${origin.x + 4} ${origin.y} ${origin.z} stone`, 300);
    await placeActor(bot, origin);
    telemetry.startScenario('uneven_slope');
    let error = null;
    try {
        await movement.moveNear(bot, origin.offset(7, 0, 0), 1, 15000);
    } catch (caught) {
        error = caught;
    }
    const accepted = !error && horizontal(bot.entity.position, origin.offset(7.5, 0, 0.5)) <= 2.25;
    await movement.sleep(350);
    telemetry.stopScenario({
        minimumDisplacement: 4,
        maximumStuckMs: 1200,
        accepted,
        reason: error?.message || 'did not cross uneven slope'
    });
}

async function wallStop(bot, telemetry, origin) {
    await resetArea(bot, origin);
    await command(bot, `/fill ${origin.x + 2} ${origin.y} ${origin.z - 1} ${origin.x + 2} ${origin.y + 1} ${origin.z + 1} stone`, 300);
    await placeActor(bot, origin);
    telemetry.startScenario('wall_stop');
    await movement.walkToward(bot, origin.offset(5, 0, 0), { durationMs: 1800 });
    const accepted = bot.entity.position.x < origin.x + 1.75 && bot.entity.position.y < origin.y + 0.2;
    await movement.sleep(350);
    telemetry.stopScenario({
        minimumDisplacement: 0.3,
        maximumDisplacement: 2,
        maximumStuckMs: 1500,
        accepted,
        reason: 'walked into or climbed a two-block wall'
    });
}

async function resetArea(bot, origin) {
    await command(bot, `/gamemode creative ${bot.username}`, 200);
    await command(bot, `/fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 4} ${origin.x + 12} ${origin.y + 5} ${origin.z + 4} air`, 300);
    await command(bot, `/fill ${origin.x - 3} ${origin.y - 1} ${origin.z - 4} ${origin.x + 12} ${origin.y - 1} ${origin.z + 4} stone`, 300);
}

async function placeActor(bot, origin) {
    await command(bot, `/gamemode survival ${bot.username}`, 200);
    await command(bot, `/tp ${bot.username} ${origin.x + 0.5} ${origin.y} ${origin.z + 0.5}`, 700);
    movement.stop(bot);
}

function createBot(username, withPathfinder) {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        if (withPathfinder) bot.loadPlugin(pathfinder);
        bot.once('spawn', () => setTimeout(() => resolve(bot), 1000));
        bot.once('error', reject);
    });
}

async function command(bot, text, waitMs) {
    bot.chat(text);
    await movement.sleep(waitMs);
}

function horizontal(left, right) {
    return Math.hypot(left.x - right.x, left.z - right.z);
}

main().catch(error => {
    console.error('[MOVEMENT_BENCHMARK_FATAL]', error.stack || error.message);
    process.exitCode = 1;
});
