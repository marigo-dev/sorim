class Blackboard {
    constructor(initial = {}) {
        this.data = {
            observation: null,
            worldState: null,
            activeTool: null,
            immediateCommand: null,
            safetyCall: null,
            autonomous: false,
            owner: null,
            lastError: null,
            ...initial
        };
    }

    update(patch) {
        Object.assign(this.data, patch || {});
        return this.snapshot();
    }

    set(key, value) {
        this.data[key] = value;
        return value;
    }

    get(key) {
        return this.data[key];
    }

    snapshot() {
        return { ...this.data };
    }
}

module.exports = Blackboard;
