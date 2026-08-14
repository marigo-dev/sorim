const fs = require('node:fs');
const path = require('node:path');

const MOVEMENT_CONTROLS = ['forward', 'back', 'left', 'right', 'jump'];

class StallDetector {
    constructor(options = {}) {
        this.stallMs = Number(options.stallMs || 1800);
        this.progressDistance = Number(options.progressDistance || 0.18);
        this.cooldownMs = Number(options.cooldownMs || 8000);
        this.anchor = null;
        this.anchorAt = 0;
        this.lastIncidentAt = 0;
    }

    update(sample) {
        if (!sample.commanded || !sample.position) {
            this.reset();
            return null;
        }
        if (!this.anchor) {
            this.anchor = point(sample.position);
            this.anchorAt = sample.at;
            return null;
        }
        const displacement = horizontal(this.anchor, sample.position);
        if (displacement >= this.progressDistance) {
            this.anchor = point(sample.position);
            this.anchorAt = sample.at;
            return null;
        }
        const stationaryMs = sample.at - this.anchorAt;
        if (stationaryMs < this.stallMs || (
            this.lastIncidentAt > 0 && sample.at - this.lastIncidentAt < this.cooldownMs
        )) {
            return null;
        }
        this.lastIncidentAt = sample.at;
        return { stationaryMs, displacement };
    }

    reset() {
        this.anchor = null;
        this.anchorAt = 0;
    }
}

class MovementWatchdog {
    constructor(bot, options = {}) {
        this.bot = bot;
        this.sampleMs = Number(options.sampleMs || 100);
        this.radius = Number(options.radius || 3);
        this.output = options.output || path.join(__dirname, '..', '..', 'artifacts', 'movement-incidents');
        this.detector = new StallDetector(options);
        this.lastSampleAt = 0;
        this.boundTick = () => this.tick();
        this.running = false;
    }

    start() {
        if (this.running) return;
        this.running = true;
        this.bot.on('physicsTick', this.boundTick);
    }

    stop() {
        if (!this.running) return;
        this.running = false;
        this.bot.removeListener('physicsTick', this.boundTick);
    }

    tick(now = Date.now()) {
        if (!this.bot.entity?.position || now - this.lastSampleAt < this.sampleMs) return null;
        this.lastSampleAt = now;
        const controls = activeControls(this.bot.controlState);
        const result = this.detector.update({
            at: now,
            position: this.bot.entity.position,
            commanded: controls.some(control => MOVEMENT_CONTROLS.includes(control))
        });
        if (!result) return null;
        const incident = this.capture(now, controls, result);
        this.write(incident);
        this.bot.emit('movementIncident', incident);
        if (typeof process.send === 'function') {
            try {
                process.send({ type: 'sorimMovementIncident', incident });
            } catch {
                // The parent watchdog may have already closed its IPC channel.
            }
        }
        console.log(`[MOVE_INCIDENT] ${incident.id} stationary=${result.stationaryMs}ms`);
        return incident;
    }

    capture(now, controls, result) {
        const position = this.bot.entity.position;
        const origin = position.floored();
        return {
            schemaVersion: 1,
            id: `movement-${new Date(now).toISOString().replaceAll(':', '-')}`,
            at: new Date(now).toISOString(),
            bot: this.bot.username,
            position: point(position),
            origin: point(origin),
            velocity: point(this.bot.entity.velocity),
            yaw: round(this.bot.entity.yaw),
            pitch: round(this.bot.entity.pitch),
            onGround: Boolean(this.bot.entity.onGround),
            controls,
            stationaryMs: result.stationaryMs,
            displacement: round(result.displacement),
            intent: normalizeIntent(this.bot.sorimMovementIntent),
            pathfinderGoal: describeGoal(this.bot.pathfinder?.goal),
            blocks: snapshotBlocks(this.bot, origin, this.radius)
        };
    }

    write(incident) {
        fs.mkdirSync(this.output, { recursive: true });
        const content = `${JSON.stringify(incident, null, 2)}\n`;
        fs.writeFileSync(path.join(this.output, `${incident.id}.json`), content);
        fs.writeFileSync(path.join(this.output, 'latest.json'), content);
    }
}

function snapshotBlocks(bot, origin, radius = 3) {
    const blocks = [];
    for (let y = -2; y <= 3; y++) {
        for (let x = -radius; x <= radius; x++) {
            for (let z = -radius; z <= radius; z++) {
                const block = bot.blockAt(origin.offset(x, y, z));
                if (!block || ['air', 'cave_air', 'void_air'].includes(block.name)) continue;
                blocks.push({
                    offset: { x, y, z },
                    name: block.name,
                    boundingBox: block.boundingBox,
                    shapes: Array.isArray(block.shapes) ? block.shapes : []
                });
            }
        }
    }
    return blocks;
}

function activeControls(state = {}) {
    return ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
        .filter(control => state[control]);
}

function normalizeIntent(intent) {
    if (!intent || Date.now() - Number(intent.at || 0) > 30000) return null;
    return {
        kind: String(intent.kind || 'move'),
        target: intent.target ? point(intent.target) : null,
        at: Number(intent.at || 0)
    };
}

function describeGoal(goal) {
    if (!goal) return null;
    return {
        type: goal.constructor?.name || 'Goal',
        x: finite(goal.x),
        y: finite(goal.y),
        z: finite(goal.z),
        range: finite(goal.range)
    };
}

function finite(value) {
    return Number.isFinite(value) ? Number(value) : null;
}

function point(value) {
    return value ? { x: round(value.x), y: round(value.y), z: round(value.z) } : null;
}

function round(value) {
    return Number(Number(value || 0).toFixed(3));
}

function horizontal(left, right) {
    return Math.hypot(Number(right.x) - Number(left.x), Number(right.z) - Number(left.z));
}

module.exports = {
    MovementWatchdog,
    StallDetector,
    snapshotBlocks
};
