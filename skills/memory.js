const fs = require('node:fs');
const path = require('node:path');

const SAVE_DELAY_MS = 200;

let base = null;
let surfaceExit = null;
let mineRoute = [];
let placedBlocks = new Set();
let progression = {};
let memoryFile = null;
let saveTimer = null;

function initialize(botName = 'marigo', options = {}) {
    cancelScheduledSave();
    base = null;
    surfaceExit = null;
    mineRoute = [];
    placedBlocks = new Set();
    progression = {};

    const directory = options.directory || path.join(__dirname, '..', 'data', 'memory');
    const safeName = String(botName).replace(/[^a-zA-Z0-9_-]/g, '_') || 'marigo';
    memoryFile = path.join(directory, `${safeName}.json`);

    if (!fs.existsSync(memoryFile)) return;

    try {
        const saved = JSON.parse(fs.readFileSync(memoryFile, 'utf8'));
        base = normalizePosition(saved.base);
        surfaceExit = normalizePosition(saved.surfaceExit);
        mineRoute = normalizeRoute(saved.mineRoute);
        placedBlocks = new Set(
            Array.isArray(saved.placedBlocks)
                ? saved.placedBlocks.filter(name => typeof name === 'string')
                : []
        );
        progression = normalizeProgression(saved.progression);
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

function setMineRoute(positions) {
    const next = normalizeRoute(positions);
    if (sameRoute(mineRoute, next)) return;
    mineRoute = next;
    scheduleSave();
}

function appendMineRoute(position) {
    const next = normalizePosition(position);
    if (!next) return;
    const last = mineRoute[mineRoute.length - 1];
    if (samePosition(last, next)) return;
    mineRoute = [...mineRoute, next].slice(-256);
    scheduleSave();
}

function getMineRoute() {
    return mineRoute.map(position => ({ ...position }));
}

function clearMineRoute() {
    if (mineRoute.length === 0) return;
    mineRoute = [];
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

function setProgress(name, value) {
    if (typeof name !== 'string' || !Number.isFinite(value)) return;
    const normalized = Math.max(0, value);
    if (progression[name] === normalized) return;
    progression[name] = normalized;
    scheduleSave();
}

function getProgress(name) {
    const value = progression[name];
    return Number.isFinite(value) ? value : 0;
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
        version: 2,
        base,
        surfaceExit,
        mineRoute,
        placedBlocks: [...placedBlocks].sort(),
        progression
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

function normalizeRoute(positions) {
    if (!Array.isArray(positions)) return [];
    const route = [];
    for (const position of positions) {
        const normalized = normalizePosition(position);
        if (!normalized || samePosition(route[route.length - 1], normalized)) continue;
        route.push(normalized);
    }
    return route.slice(-256);
}

function sameRoute(left, right) {
    return left.length === right.length &&
        left.every((position, index) => samePosition(position, right[index]));
}

function normalizeProgression(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value)
            .filter(([name, amount]) => typeof name === 'string' && Number.isFinite(amount))
            .map(([name, amount]) => [name, Math.max(0, amount)])
    );
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
    setMineRoute,
    appendMineRoute,
    getMineRoute,
    clearMineRoute,
    rememberPlacedBlock,
    hasPlacedBlock,
    setProgress,
    getProgress
};
