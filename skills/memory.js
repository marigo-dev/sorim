let base = null;
let surfaceExit = null;
const placedBlocks = new Set();

function setBase(position) {
    base = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
    console.log(`[MEMORY] base=${base.x},${base.y},${base.z}`);
}

function getBase() {
    return base;
}

function hasBase() {
    return Boolean(base);
}

function setSurfaceExit(position) {
    surfaceExit = {
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z)
    };
    console.log(`[MEMORY] surfaceExit=${surfaceExit.x},${surfaceExit.y},${surfaceExit.z}`);
}

function getSurfaceExit() {
    return surfaceExit;
}

function rememberPlacedBlock(name) {
    placedBlocks.add(name);
}

function hasPlacedBlock(name) {
    return placedBlocks.has(name);
}

module.exports = {
    setBase,
    getBase,
    hasBase,
    setSurfaceExit,
    getSurfaceExit,
    rememberPlacedBlock,
    hasPlacedBlock
};
