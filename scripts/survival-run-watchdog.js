process.env.MC_VERSION = process.env.MC_VERSION || '26.2';

require('../src/logger').installConsoleFilter();

const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');

const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = Number(process.env.MC_PORT || 25565);
const VERSION = process.env.MC_VERSION;
const TARGET = process.env.MC_USERNAME || 'marigo';
const MAX_MS = Number(process.env.SURVIVAL_RUN_MAX_MS || 4 * 60 * 60 * 1000);
const OUTPUT = process.env.SURVIVAL_RUN_REPORT_DIR ||
    path.join(__dirname, '..', 'artifacts', 'survival-run');
const INCIDENT_DIR = process.env.MOVEMENT_INCIDENT_DIR ||
    path.join(__dirname, '..', 'artifacts', 'movement-incidents');

let child = null;
let shuttingDown = false;
let currentLevel = null;
let previousHealth = null;
let actionWindow = [];
let lastActionStallAt = 0;

const report = {
    runId: new Date().toISOString().replaceAll(':', '-'),
    startedAt: new Date().toISOString(),
    environment: { host: HOST, port: PORT, version: VERSION, world: 'natural-run' },
    status: 'starting',
    target: TARGET,
    milestones: [],
    incidents: [],
    samples: [],
    latest: null
};

function main() {
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.mkdirSync(INCIDENT_DIR, { recursive: true });
    child = fork(path.join(__dirname, '..', 'src', 'bot.js'), [], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            MC_HOST: HOST,
            MC_PORT: String(PORT),
            MC_VERSION: VERSION,
            MC_USERNAME: TARGET,
            AUTONOMOUS_ON_START: process.env.AUTONOMOUS_ON_START || 'true',
            RESET_DIRECTIVE_ON_START: process.env.RESET_DIRECTIVE_ON_START || 'true',
            MOVEMENT_WATCHDOG: 'true',
            MOVEMENT_INCIDENT_DIR: INCIDENT_DIR,
            LOG_LEVEL: process.env.LOG_LEVEL || 'info'
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    child.stdout.pipe(process.stdout);
    child.stderr.pipe(process.stderr);
    child.on('message', onMessage);
    child.once('exit', (code, signal) => finish(code === 0 ? 'completed' : 'bot_exited', { code, signal }));
    report.status = 'running';
    writeReport();
    setInterval(writeReport, 5000).unref();
    setTimeout(() => finish('timeout', { maxMs: MAX_MS }), MAX_MS).unref();
}

function onMessage(message) {
    if (message?.type === 'sorimMovementIncident') {
        const incident = message.incident || {};
        recordIncident('movement_stall', 'Marigo was commanded to move but made no progress', {
            id: incident.id,
            position: incident.position,
            controls: incident.controls,
            stationaryMs: incident.stationaryMs,
            intent: incident.intent,
            pathfinderGoal: incident.pathfinderGoal
        });
        return;
    }
    if (message?.type !== 'sorimTelemetry' || !message.sample) return;
    const sample = message.sample;
    report.latest = sample;
    report.samples.push(sample);
    if (report.samples.length > 1200) report.samples.splice(0, report.samples.length - 1200);
    updateMilestones(sample);
    detectActionStall(sample);
    detectDamage(sample);
}

function updateMilestones(sample) {
    if (!sample.level || sample.level === currentLevel) return;
    const now = sample.at || Date.now();
    const previous = report.milestones.at(-1);
    if (previous && !previous.completedAt) {
        previous.completedAt = new Date(now).toISOString();
        previous.durationMs = now - previous.startedEpochMs;
        delete previous.startedEpochMs;
    }
    report.milestones.push({
        level: sample.level,
        startedAt: new Date(now).toISOString(),
        startedEpochMs: now,
        runElapsedMs: now - Date.parse(report.startedAt)
    });
    currentLevel = sample.level;
}

function detectActionStall(sample) {
    const movementTools = new Set(['move_near', 'explore', 'return_base', 'escape_pit', 'follow_player']);
    if (!movementTools.has(sample.activeTool) || !sample.position) {
        actionWindow = [];
        return;
    }
    actionWindow.push({ at: sample.at, position: sample.position, tool: sample.activeTool });
    while (actionWindow.length && sample.at - actionWindow[0].at > 20000) actionWindow.shift();
    if (actionWindow.length < 2 || sample.at - actionWindow[0].at < 15000) return;
    const progress = horizontal(actionWindow[0].position, actionWindow.at(-1).position);
    if (progress >= 0.5 || sample.at - lastActionStallAt < 15000) return;
    lastActionStallAt = sample.at;
    recordIncident('action_stall', `${sample.activeTool} moved ${progress.toFixed(2)} blocks in 15s`, {
        level: sample.level,
        position: sample.position,
        activeTool: sample.activeTool
    });
}

function detectDamage(sample) {
    if (previousHealth !== null && sample.health < previousHealth - 0.25) {
        recordIncident('damage', `Health ${previousHealth.toFixed(1)} -> ${sample.health.toFixed(1)}`, {
            level: sample.level,
            position: sample.position,
            activeTool: sample.activeTool
        });
    }
    previousHealth = sample.health;
}

function recordIncident(type, message, details = {}) {
    const incident = { at: new Date().toISOString(), type, message, ...details };
    report.incidents.push(incident);
    console.log(`[RUN_INCIDENT] ${JSON.stringify(incident)}`);
    writeReport();
}

function writeReport() {
    fs.mkdirSync(OUTPUT, { recursive: true });
    fs.writeFileSync(path.join(OUTPUT, 'current.json'), `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(path.join(OUTPUT, 'current.md'), markdownReport());
}

function markdownReport() {
    return [
        '# Sorim Survival Watchdog',
        '',
        `Status: **${report.status}**`,
        `Started: ${report.startedAt}`,
        `Target: ${report.target}`,
        `Server: ${HOST}:${PORT}`,
        '',
        '## Milestones',
        ...report.milestones.map(item => `- ${item.level}: ${item.durationMs ?? 'active'} ms`),
        '',
        '## Incidents',
        ...report.incidents.map(item => `- ${item.at} ${item.type}: ${item.message}`),
        ''
    ].join('\n');
}

function finish(status, details = {}) {
    if (shuttingDown) return;
    shuttingDown = true;
    report.status = status;
    report.finishedAt = new Date().toISOString();
    report.finish = details;
    writeReport();
    if (child?.connected) child.send({ type: 'sorimControl', command: 'setAutonomous', enabled: false });
    setTimeout(() => child?.kill('SIGINT'), 500).unref();
}

function horizontal(left, right) {
    return Math.hypot(right.x - left.x, right.z - left.z);
}

process.once('SIGINT', () => finish('interrupted'));
process.once('SIGTERM', () => finish('terminated'));
main();
