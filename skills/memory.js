const fs = require('node:fs');
const path = require('node:path');

const SAVE_DELAY_MS = 200;

let base = null;
let surfaceExit = null;
let placedBlocks = new Set();
let memoryFile = null;
let saveTimer = null;

function initialize(botName = 'marigo', options = {}) {
    cancelScheduledSave();
    base = null;
    surfaceExit = null;
    placedBlocks = new Set();

    const directory = options.directory || path.join(__dirname, '..', 'data', 'memory');
    const safeName = String(botName).replace(/[^a-zA-Z0-9_-]/g, '_') || 'marigo';
    memoryFile = path.join(directory, `${safeName}.json`);

    if (!fs.existsSync(memoryFile)) return;

    try {
        const saved = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
        base = normalizePosition(saved.base);
        surfaceExit = normalizePosition(saved.surfaceExit);
        placedBlocks = new Set(
            Array.isArray(saved.placedBlocks)
                ? saved.placedBlocks.filter(name => typeof name === 'string')
                : []
        );
        console.log(`[MEMORY] loaded ${memoryFile}`);
    } catch (error) {
        console.log(`[MEMORY] ignored unreadable state: ${error.message}`);
    }
}

function setBase(position) {
    const next = normalizePosition(position);
    if (!next || samePosition(base, next)) return;
    base = next;
    console.log(`[MEMORY] base=${base.x},${base.y},${base.z}`);
    scheduleSave();
}

function getBase() {
    return base ? { ...base } : null;
}

function hasBase() {
    return Boolean(base);
}

function setSurfaceExit(position) {
    const next = normalizePosition(position);
    if (!next || samePosition(surfaceExit, next)) return;
    surfaceExit = next;
    console.log(`[MEMORY] surfaceExit=${surfaceExit.x},${surfaceExit.y},${surfaceExit.z}`);
    scheduleSave();
}

function getSurfaceExit() {
    return surfaceExit ? { ...surfaceExit } : null;
}

function clearSurfaceExit() {
    if (!surfaceExit) return;
    surfaceExit = null;
    scheduleSave();
}

function rememberPlacedBlock(name) {
    if (!name || placedBlocks.has(name)) return;
    placedBlocks.add(name);
    scheduleSave();
}

function hasPlacedBlock(name) {
    return placedBlocks.has(name);
}

function scheduleSave() {
    if (!memoryFile || saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        flush();
    }, SAVE_DELAY_MS);
    saveTimer.unref?.();
}

function flush() {
    cancelScheduledSave();
    if (!memoryFile) return;

    const directory = path.dirname(memoryFile);
    const temporaryFile = `${memoryFile}.tmp`;
    const payload = JSON.stringify({
        version: 1,
        base,
        surfaceExit,
        placedBlocks: [...placedBlocks].sort()
    }, null, 2);

    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(temporaryFile, payload, 'utf8');
    fs.renameSync(temporaryFile, memoryFile);
}

function cancelScheduledSave() {
    if (!saveTimer) return;
    clearTimeout(saveTimer);
    saveTimer = null;
}

function normalizePosition(position) {
    if (!position) return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return {
        x: Math.floor(x),
        y: Math.floor(y),
        z: Math.floor(z)
    };
}

function samePosition(left, right) {
    return Boolean(left && right) &&
        left.x === right.x &&
        left.y === right.y &&
        left.z === right.z;
}

module.exports = {
    initialize,
    flush,
    setBase,
    getBase,
    hasBase,
    setSurfaceExit,
    getSurfaceExit,
    clearSurfaceExit,
    rememberPlacedBlock,
    hasPlacedBlock
};
