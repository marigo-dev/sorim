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
    latest: null,
    runtime: {
        botConnected: false,
        lastTelemetryAt: null,
        telemetryAgeMs: null,
        currentAction: null,
        actionReason: null,
        actionSince: null,
        actionDurationMs: 0,
        idle: false
    }
};
let lastActionSignature = null;
let lastReportWriteAt = 0;

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
    report.runtime.botConnected = false;
    writeReport();
    setInterval(() => {
        refreshRuntimeStatus();
        writeReport();
    }, 5000).unref();
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
    const now = Number(sample.at || Date.now());
    const actionSignature = `${sample.level || 'unknown'}|${sample.activeTool || 'none'}|${sample.behaviorSource || 'none'}`;
    if (actionSignature !== lastActionSignature) {
        lastActionSignature = actionSignature;
        report.runtime.actionSince = new Date(now).toISOString();
        report.runtime.actionDurationMs = 0;
    } else if (report.runtime.actionSince) {
        report.runtime.actionDurationMs = Math.max(0, now - Date.parse(report.runtime.actionSince));
    }
    report.runtime = {
        ...report.runtime,
        botConnected: true,
        lastTelemetryAt: new Date(now).toISOString(),
        telemetryAgeMs: 0,
        level: sample.level,
        currentAction: sample.activeTool || null,
        actionReason: sample.actionReason || null,
        behaviorSource: sample.behaviorSource || null,
        actionDurationMs: report.runtime.actionDurationMs,
        idle: ['wait_safe', 'idle'].includes(sample.activeTool),
        position: sample.position || null,
        health: sample.health,
        food: sample.food,
        inventory: sample.inventory || {}
    };
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
    const current = {
        ...report,
        updatedAt: new Date().toISOString(),
        runtime: {
            ...report.runtime,
            telemetryAgeMs: report.runtime.lastTelemetryAt
                ? Date.now() - Date.parse(report.runtime.lastTelemetryAt)
                : null
        }
    };
    fs.writeFileSync(path.join(OUTPUT, 'current.json'), `${JSON.stringify(current, null, 2)}\n`);
    fs.writeFileSync(path.join(OUTPUT, 'current.md'), markdownReport());
    lastReportWriteAt = Date.now();
}

function refreshRuntimeStatus() {
    const lastTelemetryAt = report.runtime.lastTelemetryAt;
    const age = lastTelemetryAt ? Date.now() - Date.parse(lastTelemetryAt) : null;
    report.runtime.telemetryAgeMs = age;
    if (age !== null && age > 10000) {
        report.runtime.botConnected = false;
        if (report.status === 'running') report.status = 'telemetry_stale';
    } else if (age !== null && report.status === 'telemetry_stale') {
        report.runtime.botConnected = true;
        report.status = 'running';
    }
}

function markdownReport() {
    return [
        '# Sorim Survival Watchdog',
        '',
        `Status: **${report.status}**`,
        `Started: ${report.startedAt}`,
        `Target: ${report.target}`,
        `Server: ${HOST}:${PORT}`,
        `Updated: ${new Date().toISOString()}`,
        '',
        '## Live State',
        `- Connection: ${report.runtime.botConnected ? 'connected' : 'waiting for telemetry'}`,
        `- Level: ${report.runtime.level || 'unknown'}`,
        `- Action: ${report.runtime.currentAction || 'none'}`,
        `- Reason: ${report.runtime.actionReason || 'n/a'}`,
        `- Action duration: ${formatDuration(report.runtime.actionDurationMs)}`,
        `- Idle/waiting: ${report.runtime.idle ? 'yes' : 'no'}`,
        `- Position: ${formatPoint(report.runtime.position)}`,
        `- Health/Food: ${report.runtime.health ?? 'n/a'} / ${report.runtime.food ?? 'n/a'}`,
        '',
        '## Milestones',
        ...report.milestones.map(item => `- ${item.level}: ${item.durationMs ?? 'active'} ms`),
        '',
        '## Incidents',
        `Total: ${report.incidents.length}`,
        ...report.incidents.slice(-20).map(item => `- ${item.at} ${item.type}: ${item.message}`),
        ''
    ].join('\n');
}

function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function formatPoint(point) {
    return point ? `${point.x},${point.y},${point.z}` : 'unknown';
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
