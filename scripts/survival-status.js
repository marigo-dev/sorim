const fs = require('node:fs');
const path = require('node:path');

const rootReportDir = path.join(__dirname, '..', 'artifacts', 'survival-run');
const reportDir = process.env.SURVIVAL_RUN_REPORT_DIR || rootReportDir;
const reportPath = findReport(path.join(reportDir, 'current.json'));

if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(`No run report found under: ${reportDir}`);
    process.exitCode = 1;
    return;
}

const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
const runtime = report.runtime || {};
const reportAgeMs = Date.now() - fs.statSync(reportPath).mtimeMs;
const reportState = reportAgeMs > 15000
    ? `${report.status} (stale report, age=${formatDuration(reportAgeMs)})`
    : report.status;
const age = runtime.telemetryAgeMs == null ? 'unknown' : `${Math.round(runtime.telemetryAgeMs / 1000)}s`;
const position = runtime.position
    ? `${runtime.position.x},${runtime.position.y},${runtime.position.z}`
    : 'unknown';

console.log(`Run: ${reportState} | target=${report.target} | updated=${report.updatedAt || 'unknown'}`);
console.log(`Bot: ${runtime.botConnected ? 'connected' : 'disconnected/stale'} | telemetryAge=${age}`);
console.log(`Level: ${runtime.level || 'unknown'} | action=${runtime.currentAction || 'none'} | duration=${formatDuration(runtime.actionDurationMs)}`);
console.log(`Reason: ${runtime.actionReason || 'n/a'}`);
console.log(`Position: ${position} | health=${runtime.health ?? 'n/a'} | food=${runtime.food ?? 'n/a'}`);
console.log(`Idle: ${runtime.idle ? 'yes' : 'no'} | incidents=${report.incidents?.length || 0}`);

const recent = (report.incidents || []).slice(-5);
if (recent.length) {
    console.log('Recent incidents:');
    for (const incident of recent) console.log(`- ${incident.at} ${incident.type}: ${incident.message}`);
}

function formatDuration(ms) {
    const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function findReport(candidate) {
    if (fs.existsSync(candidate)) return candidate;
    if (!fs.existsSync(rootReportDir)) return null;
    const candidates = fs.readdirSync(rootReportDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(rootReportDir, entry.name, 'report', 'current.json'))
        .filter(file => fs.existsSync(file))
        .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
    return candidates[0] || null;
}
