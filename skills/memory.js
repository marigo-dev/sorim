let base = null;

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

module.exports = {
    setBase,
    getBase,
    hasBase
};
