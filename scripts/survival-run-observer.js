process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();
const {
    install26_2PacketFallbacks,
    install26_2VelocityShim
} = require('../src/protocol26Shim');

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const mineflayer = require('mineflayer');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25566);
const VERSION = process.env.MC_VERSION;
const TARGET = process.env.MC_USERNAME || 'marigo';
const OBSERVER = process.env.SURVIVAL_OBSERVER_NAME || 'Bot_Mico';
const MAX_MS = Number(process.env.SURVIVAL_RUN_MAX_MS || 4 * 60 * 60 * 1000);
const FRESH_RUN = process.env.SURVIVAL_FRESH_RUN === 'true';
const WORLD_NAME = process.env.SURVIVAL_WORLD_NAME || 'unknown';
const OUTPUT = process.env.SURVIVAL_RUN_REPORT_DIR ||
    path.join(__dirname, '..', 'artifacts', 'survival-run');
const RUN_MEMORY = process.env.SURVIVAL_RUN_MEMORY_DIR ||
    path.join(OUTPUT, `memory-${new Date().toISOString().replaceAll(':', '-')}`);
const LEVELS = [
    'L1_COLLECT_WOOD', 'L2_CRAFT_PLANKS', 'L3_CRAFT_TABLE',
    'L4_CRAFT_WOODEN_PICKAXE', 'L5_COLLECT_STONE', 'L6_CRAFT_STONE_TOOLS',
    'L7_BUILD_SAFE_SHELTER', 'L8_SURVIVAL_MANAGER', 'L9_FOOD_LOOP',
    'L10_STORAGE_AND_BASE_MEMORY', 'L17_ESTABLISH_WHEAT_FARM',
    'L11_SECURE_BED', 'L12_PREPARE_MINING_KIT',
    'L13_SAFE_IRON_MINE', 'L14_COLLECT_RAW_IRON', 'L15_SMELT_IRON',
    'L16_CRAFT_IRON_KIT',
    'L18_COLLECT_ARMOR_IRON', 'L19_SMELT_ARMOR_IRON',
    'L20_CRAFT_IRON_ARMOR', 'L21_STABLE_SURVIVAL'
];

let observer = null;
let child = null;
let shuttingDown = false;
let latestTelemetry = null;
let latestObserved = null;
let moveWindow = [];
let airborneStartedAt = null;
let lastStuckAt = 0;
let currentLevel = null;
let actionWindow = [];
let previousHealth = null;

const report = {
    runId: new Date().toISOString().replaceAll(':', '-'),
    startedAt: new Date().toISOString(),
    naturalWorld: true,
    freshRun: FRESH_RUN,
    environment: {
        host: HOST,
        port: PORT,
        version: VERSION,
        difficulty: 'easy',
        worldName: WORLD_NAME
    },
    status: 'starting',
    target: TARGET,
    observer: OBSERVER,
    milestones: [],
    incidents: [],
    samples: [],
    latest: null
};

async function main() {
    fs.mkdirSync(OUTPUT, { recursive: true });
    observer = await createObserver();
    child = fork(path.join(__dirname, '..', 'src', 'bot.js'), [], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            MC_HOST: HOST,
            MC_PORT: String(PORT),
            MC_VERSION: VERSION,
            MC_USERNAME: TARGET,
            AUTONOMOUS_ON_START: FRESH_RUN ? 'false' : 'true',
            WORLD_MEMORY_DIR: path.join(RUN_MEMORY, 'world'),
            AGENT_MEMORY_DIR: path.join(RUN_MEMORY, 'agent'),
            USE_LLM_PLANNER: process.env.USE_LLM_PLANNER || 'true',
            LOG_LEVEL: process.env.LOG_LEVEL || 'debug',
            STOP_AT_LEVEL: process.env.STOP_AT_LEVEL || 'L21_STABLE_SURVIVAL'
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    pipeChildOutput(child.stdout, process.stdout);
    pipeChildOutput(child.stderr, process.stderr);
    child.on('message', onChildMessage);
    child.once('exit', (code, signal) => finish(code === 0 ? 'completed' : 'bot_exited', { code, signal }));

    await waitForPlayer(observer, TARGET, 30000);
    observer.chat(`/gamemode spectator ${OBSERVER}`);
    await sleep(500);
    if (FRESH_RUN) await prepareFreshTarget();
    observer.chat(`/tp ${OBSERVER} ${TARGET}`);
    await sleep(1000);
    report.status = 'running';
    recordIncident('observer_ready', 'Spectator attached to the natural survival run');
    writeCurrentReport();

    const sampler = setInterval(sampleObservedPosition, 250);
    const writer = setInterval(writeCurrentReport, 5000);
    sampler.unref();
    writer.unref();
    setTimeout(() => finish('timeout', { maxMs: MAX_MS }), MAX_MS).unref();
}

async function prepareFreshTarget() {
    observer.chat('/difficulty easy');
    await sleep(200);
    observer.chat('/time set day');
    await sleep(200);
    observer.chat('/weather clear');
    await sleep(200);
    observer.chat(`/gamemode survival ${TARGET}`);
    await sleep(200);
    observer.chat(`/clear ${TARGET}`);
    await sleep(500);
    observer.chat(`/effect clear ${TARGET}`);
    await sleep(500);

    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
        if (latestTelemetry && Object.keys(latestTelemetry.inventory || {}).length === 0) break;
        await sleep(200);
    }
    if (!latestTelemetry) throw new Error('Fresh run did not receive target telemetry');
    if (Object.keys(latestTelemetry.inventory || {}).length > 0) {
        throw new Error(`Fresh run inventory was not empty: ${JSON.stringify(latestTelemetry.inventory)}`);
    }
    await setAutonomous(true);
    report.preflight = {
        inventoryEmpty: true,
        position: latestTelemetry.position,
        memoryDirectory: RUN_MEMORY,
        worldName: WORLD_NAME,
        startedAutonomyAt: new Date().toISOString()
    };
    recordIncident('fresh_preflight', 'Empty inventory and isolated memory verified before autonomy start');
}

function setAutonomous(enabled) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            child.off('message', onAck);
            reject(new Error('Bot did not acknowledge autonomous control'));
        }, 5000);
        const onAck = message => {
            if (message?.type !== 'sorimControlAck' || message.command !== 'setAutonomous') return;
            if (message.enabled !== enabled) return;
            clearTimeout(timeout);
            child.off('message', onAck);
            resolve();
        };
        child.on('message', onAck);
        child.send({ type: 'sorimControl', command: 'setAutonomous', enabled, source: 'survival-observer' });
    });
}

function onChildMessage(message) {
    if (message?.type !== 'sorimTelemetry' || !message.sample) return;
    latestTelemetry = message.sample;
    updateMilestones(message.sample);
    detectStuck(message.sample);
    report.latest = combinedSample(message.sample);
    if (
        report.samples.length === 0 ||
        message.sample.at - report.samples.at(-1).at >= 5000
    ) {
        report.samples.push(report.latest);
    }
}

function sampleObservedPosition() {
    const entity = observer?.players?.[TARGET]?.entity;
    if (!entity?.position) {
        latestObserved = null;
        return;
    }
    latestObserved = point(entity.position);
}

function updateMilestones(sample) {
    if (!sample.level || sample.level === 'BOOT' || sample.level === currentLevel) return;
    const now = sample.at;
    const nextIndex = LEVELS.indexOf(sample.level);
    const previousIndex = LEVELS.indexOf(currentLevel);
    if (currentLevel && nextIndex > previousIndex) {
        for (let index = previousIndex; index < nextIndex; index++) {
            const milestone = report.milestones.find(item => item.level === LEVELS[index]);
            if (milestone && !milestone.completedAt) {
                milestone.completedAt = new Date(now).toISOString();
                milestone.durationMs = now - milestone.startedEpochMs;
                delete milestone.startedEpochMs;
                console.log(`[RUN_MILESTONE] ${milestone.level} completed in ${formatDuration(milestone.durationMs)}`);
            }
        }
    }
    if (!report.milestones.some(item => item.level === sample.level)) {
        report.milestones.push({
            level: sample.level,
            startedAt: new Date(now).toISOString(),
            startedEpochMs: now,
            runElapsedMs: now - Date.parse(report.startedAt)
        });
    }
    currentLevel = sample.level;
}

function detectStuck(sample) {
    const moving = sample.controls.some(control =>
        ['forward', 'back', 'left', 'right', 'jump'].includes(control)
    );
    if (!moving || !latestObserved) {
        moveWindow = [];
    } else {
        moveWindow.push({ at: sample.at, position: latestObserved, level: sample.level, controls: sample.controls });
        while (moveWindow.length && sample.at - moveWindow[0].at > 6000) moveWindow.shift();
        if (moveWindow.length > 1 && sample.at - moveWindow[0].at >= 4500) {
            const displacement = horizontal(moveWindow[0].position, moveWindow.at(-1).position);
            if (displacement < 0.15 && sample.at - lastStuckAt > 10000) {
                lastStuckAt = sample.at;
                recordIncident('stuck', `Movement controls active with ${displacement.toFixed(2)} block progress`, {
                    level: sample.level,
                    position: latestObserved,
                    controls: sample.controls,
                    activeTool: sample.activeTool
                });
            }
        }
    }

    if (!sample.onGround && moving) {
        airborneStartedAt ||= sample.at;
        if (sample.at - airborneStartedAt >= 2000 && sample.at - lastStuckAt > 10000) {
            lastStuckAt = sample.at;
            recordIncident('airborne_stall', 'Bot remained airborne while movement controls were active', {
                level: sample.level,
                position: latestObserved || sample.position,
                durationMs: sample.at - airborneStartedAt
            });
        }
    } else {
        airborneStartedAt = null;
    }

    const movementTools = new Set([
        'move_near', 'explore', 'return_base', 'escape_pit'
    ]);
    if (movementTools.has(sample.activeTool) && latestObserved) {
        actionWindow.push({ at: sample.at, position: latestObserved, tool: sample.activeTool });
        while (actionWindow.length && sample.at - actionWindow[0].at > 25000) actionWindow.shift();
        if (actionWindow.length > 1 && sample.at - actionWindow[0].at >= 20000) {
            const displacement = horizontal(actionWindow[0].position, actionWindow.at(-1).position);
            if (displacement < 0.4 && sample.at - lastStuckAt > 15000) {
                lastStuckAt = sample.at;
                recordIncident('action_stall', `${sample.activeTool} made ${displacement.toFixed(2)} block progress in 20s`, {
                    level: sample.level,
                    position: latestObserved,
                    activeTool: sample.activeTool
                });
            }
        }
    } else {
        actionWindow = [];
    }

    if (previousHealth !== null && sample.health < previousHealth - 0.25) {
        recordIncident('damage', `Health ${previousHealth.toFixed(2)} -> ${sample.health.toFixed(2)}`, {
            level: sample.level,
            position: latestObserved || sample.position,
            activeTool: sample.activeTool
        });
    }
    previousHealth = sample.health;
}

function pipeChildOutput(stream, destination) {
    let pending = '';
    stream.on('data', chunk => {
        const text = chunk.toString();
        destination.write(text);
        pending += text;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() || '';
        for (const line of lines) inspectLogLine(line);
    });
}

function inspectLogLine(line) {
    const patterns = [
        ['step_error', '[STEP_ERROR]'],
        ['no_path', 'No path to the goal'],
        ['movement_timeout', 'timed out'],
        ['movement_stall', 'reason=stalled'],
        ['forced_move', '[PHYSICS] forced move'],
        ['death', '[DEATH]'],
        ['fatal', '[FATAL]']
    ];
    for (const [type, marker] of patterns) {
        if (line.toLowerCase().includes(marker.toLowerCase())) {
            recordIncident(type, line.slice(0, 500), {
                level: latestTelemetry?.level,
                position: latestObserved || latestTelemetry?.position
            });
            break;
        }
    }
}

function recordIncident(type, message, details = {}) {
    const incident = { at: new Date().toISOString(), type, message, ...details };
    const previous = report.incidents.at(-1);
    const closePosition = previous?.position && incident.position
        ? horizontal(previous.position, incident.position) <= 1.5
        : true;
    if (
        previous?.type === type && previous?.level === incident.level && closePosition &&
        Date.parse(incident.at) - Date.parse(previous.lastAt || previous.at) <= 5000
    ) {
        previous.count = (previous.count || 1) + 1;
        previous.lastAt = incident.at;
        previous.message = message;
        writeCurrentReport();
        return;
    }
    report.incidents.push(incident);
    console.log(`[RUN_INCIDENT] ${JSON.stringify(incident)}`);
    writeCurrentReport();
}

function combinedSample(sample) {
    return {
        at: sample.at,
        level: sample.level,
        self: sample.position,
        observed: latestObserved,
        controls: sample.controls,
        onGround: sample.onGround,
        health: sample.health,
        food: sample.food,
        inventory: sample.inventory,
        activeTool: sample.activeTool
    };
}

function writeCurrentReport() {
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT, 'current.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(OUTPUT, 'current.md'), markdownReport());
}

function markdownReport() {
    const milestoneRows = report.milestones.map(item =>
        `| ${item.level} | ${item.completedAt ? 'complete' : 'active'} | ` +
        `${formatDuration(item.durationMs ?? (Date.now() - item.startedEpochMs))} |`
    );
    const incidents = report.incidents.map(item =>
        `- ${item.at} - **${item.type}**: ${item.message}`
    );
    return [
        '# Natural Survival Run', '',
        `Status: **${report.status}**`,
        `Started: ${report.startedAt}`,
        `World: ${WORLD_NAME}; fresh run: ${FRESH_RUN}`,
        `Target: ${TARGET}; observer: ${OBSERVER}`, '',
        '| Stage | State | Duration |',
        '| --- | --- | ---: |',
        ...milestoneRows,
        '', '## Incidents', '',
        ...(incidents.length ? incidents : ['- None']),
        ''
    ].join('\n');
}

async function finish(status, details = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    report.status = status;
    report.finishedAt = new Date().toISOString();
    report.finishDetails = details;
    writeCurrentReport();
    fs.copyFileSync(path.join(OUTPUT, 'current.json'), path.join(OUTPUT, `${report.runId}.json`));
    fs.copyFileSync(path.join(OUTPUT, 'current.md'), path.join(OUTPUT, `${report.runId}.md`));
    if (child?.connected) child.kill('SIGINT');
    observer?.end();
    setTimeout(() => process.exit(status === 'completed' ? 0 : 1), 500);
}

function createObserver() {
    return new Promise((resolve, reject) => {
        const bot = mineflayer.createBot({ host: HOST, port: PORT, username: OBSERVER, version: VERSION });
        install26_2PacketFallbacks(bot);
        install26_2VelocityShim(bot);
        bot.once('spawn', () => setTimeout(() => resolve(bot), 800));
        bot.once('error', reject);
    });
}

function waitForPlayer(bot, username, timeoutMs) {
    return new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
            if (bot.players[username]?.entity) return resolve();
            if (Date.now() >= deadline) return reject(new Error(`Observer could not see ${username}`));
            setTimeout(poll, 200);
        };
        poll();
    });
}

function point(value) {
    return value ? {
        x: Number(value.x.toFixed(3)),
        y: Number(value.y.toFixed(3)),
        z: Number(value.z.toFixed(3))
    } : null;
}

function horizontal(left, right) {
    return Math.hypot(right.x - left.x, right.z - left.z);
}

function formatDuration(ms) {
    if (!Number.isFinite(ms)) return '-';
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

process.on('SIGINT', () => finish('stopped', { signal: 'SIGINT' }));
process.on('SIGTERM', () => finish('stopped', { signal: 'SIGTERM' }));

main().catch(error => {
    console.error('[SURVIVAL_RUN_FATAL]', error.stack || error.message);
    finish('harness_error', { error: error.message });
});
