const Status = require('./status');

class Node {
    constructor(name) {
        this.name = name || this.constructor.name;
    }
}

class PrioritySelector extends Node {
    constructor(name, children = []) {
        super(name);
        this.children = children;
    }

    async tick(context) {
        let last = null;
        for (const child of this.children) {
            const childResult = await child.tick(context);
            last = childResult;
            if (childResult.status !== Status.FAILURE) return childResult;
        }
        return result(Status.FAILURE, this.name);
    }
}

class Sequence extends Node {
    constructor(name, children = []) {
        super(name);
        this.children = children;
        this.cursor = 0;
    }

    async tick(context) {
        while (this.cursor < this.children.length) {
            const childResult = await this.children[this.cursor].tick(context);
            if (childResult.status === Status.RUNNING) return childResult;
            if (childResult.status === Status.FAILURE) {
                this.cursor = 0;
                return childResult;
            }
            this.cursor++;
        }
        this.cursor = 0;
        return result(Status.SUCCESS, this.name);
    }
}

class Condition extends Node {
    constructor(name, predicate) {
        super(name);
        this.predicate = predicate;
    }

    async tick(context) {
        return result(await this.predicate(context) ? Status.SUCCESS : Status.FAILURE, this.name);
    }
}

class Action extends Node {
    constructor(name, operation) {
        super(name);
        this.operation = operation;
    }

    async tick(context) {
        const value = await this.operation(context);
        if (!value) return result(Status.FAILURE, this.name);
        if (typeof value === 'string') return result(value, this.name);
        if (value.status) return { node: this.name, ...value };
        return result(Status.SUCCESS, this.name, value);
    }
}

class Cooldown extends Node {
    constructor(name, child, durationMs) {
        super(name);
        this.child = child;
        this.durationMs = Number(durationMs || 1000);
        this.nextAt = 0;
    }

    async tick(context) {
        if (Date.now() < this.nextAt) return result(Status.FAILURE, this.name);
        const childResult = await this.child.tick(context);
        if (childResult.status !== Status.FAILURE) this.nextAt = Date.now() + this.durationMs;
        return childResult;
    }
}

function result(status, node, value = null) {
    return { status, node, value };
}

module.exports = { Node, PrioritySelector, Sequence, Condition, Action, Cooldown, result };
