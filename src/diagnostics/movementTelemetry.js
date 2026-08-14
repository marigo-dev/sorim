const fs = require('node:fs');
const path = require('node:path');

class MovementTelemetry {
    constructor(actor, observer, options = {}) {
        this.actor = actor;
        this.observer = observer;
        this.sampleMs = options.sampleMs || 100;
        this.scenarios = [];
        this.active = null;
        this.timer = null;
    }

    startScenario(name) {
        if (this.active) throw new Error(`Movement scenario ${this.active.name} is still active`);
        this.active = { name, startedAt: Date.now(), samples: [] };
        this.sample();
        this.timer = setInterval(() => this.sample(), this.sampleMs);
    }

    sample() {
        if (!this.active || !this.actor.entity?.position) return;
        const observed = this.observer?.players?.[this.actor.username]?.entity;
        this.active.samples.push({
            at: Date.now(),
            self: vector(this.actor.entity.position),
            observed: observed?.position ? vector(observed.position) : null,
            velocity: vector(this.actor.entity.velocity),
            onGround: Boolean(this.actor.entity.onGround),
            controls: activeControls(this.actor.controlState)
        });
    }

    stopScenario(expectation = {}) {
        if (!this.active) throw new Error('No movement scenario is active');
        clearInterval(this.timer);
        this.timer = null;
        this.sample();
        const scenario = analyzeScenario(this.active, expectation);
        this.scenarios.push(scenario);
        this.active = null;
        return scenario;
    }

    report(environment = {}) {
        return {
            generatedAt: new Date().toISOString(),
            environment,
            passed: this.scenarios.every(scenario => scenario.passed),
            scenarios: this.scenarios
        };
    }
}

function analyzeScenario(raw, expectation = {}) {
    const selfSamples = raw.samples.filter(sample => sample.self);
    const observedSamples = raw.samples.filter(sample => sample.observed);
    const selfMotion = motionStats(selfSamples.map(sample => ({ at: sample.at, position: sample.self })));
    const observedMotion = motionStats(observedSamples.map(sample => ({ at: sample.at, position: sample.observed })));
    const measuredMotion = observedSamples.length > 0 ? observedMotion : selfMotion;
    const measuredSource = observedSamples.length > 0 ? 'observer' : 'self';
    const maximumDivergence = raw.samples.reduce((maximum, sample) => {
        if (!sample.self || !sample.observed) return maximum;
        return Math.max(maximum, distance3d(sample.self, sample.observed));
    }, 0);
    const maximumDivergenceAllowed = expectation.maximumDivergence ?? 0.75;
    const divergenceMs = longestPredicateWindow(
        raw.samples,
        sample => Boolean(sample.self && sample.observed) &&
            distance3d(sample.self, sample.observed) > maximumDivergenceAllowed
    );
    const commandedSamples = raw.samples.filter(sample =>
        sample.controls.some(control => ['forward', 'back', 'left', 'right', 'jump'].includes(control))
    );
    const stuckMs = longestStationaryWindow(commandedSamples, 0.12);
    const airborneStationaryMs = longestStationaryWindow(
        raw.samples.filter(sample => !sample.onGround),
        0.08
    );
    const observerCoverage = raw.samples.length
        ? observedSamples.length / raw.samples.length
        : 0;
    const failures = [];
    const minimumDisplacement = expectation.minimumDisplacement ?? 0;
    const maximumDisplacement = expectation.maximumDisplacement ?? Infinity;
    const maximumSpeed = expectation.maximumSpeed ?? 6.2;
    const maximumStuckMs = expectation.maximumStuckMs ?? 900;
    const maximumAirborneStationaryMs = expectation.maximumAirborneStationaryMs ?? 700;
    const maximumDivergenceMs = expectation.maximumDivergenceMs ?? 500;
    const minimumObserverCoverage = expectation.minimumObserverCoverage ?? 0;

    if (measuredMotion.displacement < minimumDisplacement) {
        failures.push(`${measuredSource} displacement ${measuredMotion.displacement} < ${minimumDisplacement}`);
    }
    if (measuredMotion.displacement > maximumDisplacement) {
        failures.push(`${measuredSource} displacement ${measuredMotion.displacement} > ${maximumDisplacement}`);
    }
    if (measuredMotion.peakSpeed > maximumSpeed) {
        failures.push(`${measuredSource} speed ${measuredMotion.peakSpeed} > ${maximumSpeed}`);
    }
    if (stuckMs > maximumStuckMs) failures.push(`commanded but stationary for ${stuckMs}ms`);
    if (airborneStationaryMs > maximumAirborneStationaryMs) {
        failures.push(`airborne and stationary for ${airborneStationaryMs}ms`);
    }
    if (divergenceMs > maximumDivergenceMs) {
        failures.push(
            `self/observer divergence exceeded ${maximumDivergenceAllowed} for ${divergenceMs}ms`
        );
    }
    if (observerCoverage < minimumObserverCoverage) {
        failures.push(`observer coverage ${round(observerCoverage * 100)}% < ${minimumObserverCoverage * 100}%`);
    }
    if (expectation.accepted === false) failures.push(expectation.reason || 'scenario acceptance failed');

    return {
        name: raw.name,
        passed: failures.length === 0,
        failures,
        durationMs: selfMotion.durationMs,
        samples: raw.samples.length,
        observerCoverage: round(observerCoverage),
        self: selfMotion,
        observed: observedMotion,
        measured: measuredMotion,
        measuredSource,
        maximumDivergence: round(maximumDivergence),
        divergenceMs,
        commandedStationaryMs: stuckMs,
        airborneStationaryMs,
        final: raw.samples.at(-1) || null,
        trajectory: raw.samples.map(sample => ({
            elapsedMs: sample.at - raw.startedAt,
            self: sample.self,
            observed: sample.observed,
            onGround: sample.onGround,
            controls: sample.controls
        }))
    };
}

function motionStats(samples) {
    if (samples.length < 1) return { displacement: 0, distance: 0, peakSpeed: 0, durationMs: 0 };
    let distance = 0;
    let peakSpeed = 0;
    for (let index = 1; index < samples.length; index++) {
        const previous = samples[index - 1];
        const current = samples[index];
        const segment = horizontalDistance(previous.position, current.position);
        distance += segment;
        let referenceIndex = index - 1;
        while (referenceIndex > 0 && current.at - samples[referenceIndex].at < 250) {
            referenceIndex--;
        }
        const reference = samples[referenceIndex];
        const elapsed = (current.at - reference.at) / 1000;
        if (elapsed >= 0.25) {
            peakSpeed = Math.max(
                peakSpeed,
                horizontalDistance(reference.position, current.position) / elapsed
            );
        }
    }
    return {
        displacement: round(horizontalDistance(samples[0].position, samples.at(-1).position)),
        distance: round(distance),
        peakSpeed: round(peakSpeed),
        durationMs: samples.at(-1).at - samples[0].at
    };
}

function longestStationaryWindow(samples, radius) {
    let longest = 0;
    let start = 0;
    for (let end = 0; end < samples.length; end++) {
        while (
            start < end &&
            horizontalDistance(samples[start].self, samples[end].self) > radius
        ) start++;
        longest = Math.max(longest, samples[end].at - samples[start].at);
    }
    return longest;
}

function longestPredicateWindow(samples, predicate) {
    let longest = 0;
    let startedAt = null;
    for (const sample of samples) {
        if (predicate(sample)) {
            if (startedAt === null) startedAt = sample.at;
            longest = Math.max(longest, sample.at - startedAt);
        } else {
            startedAt = null;
        }
    }
    return longest;
}

function writeReport(report, directory) {
    fs.mkdirSync(directory, { recursive: true });
    const jsonPath = path.join(directory, 'latest.json');
    const markdownPath = path.join(directory, 'latest.md');
    const svgPath = path.join(directory, 'latest.svg');
    fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
    fs.writeFileSync(markdownPath, markdownReport(report));
    fs.writeFileSync(svgPath, svgReport(report));
    return { jsonPath, markdownPath, svgPath };
}

function markdownReport(report) {
    const rows = report.scenarios.map(scenario =>
        `| ${scenario.name} | ${scenario.passed ? 'PASS' : 'FAIL'} | ` +
        `${scenario.measured.displacement} | ${scenario.measured.peakSpeed} | ` +
        `${scenario.commandedStationaryMs} | ${scenario.maximumDivergence} | ` +
        `${scenario.failures.join('; ') || '-'} |`
    );
    return [
        '# Sorim Movement Benchmark',
        '',
        `Generated: ${report.generatedAt}`,
        '',
        `Overall: **${report.passed ? 'PASS' : 'FAIL'}**`,
        '',
        '![Movement trajectories](latest.svg)',
        '',
        '| Scenario | Result | Measured displacement | Peak blocks/s | Stuck ms | Divergence | Notes |',
        '| --- | --- | ---: | ---: | ---: | ---: | --- |',
        ...rows,
        ''
    ].join('\n');
}

function svgReport(report) {
    const width = 900;
    const rowHeight = 145;
    const height = Math.max(180, report.scenarios.length * rowHeight + 40);
    const rows = report.scenarios.map((scenario, index) => {
        const top = index * rowHeight + 30;
        const origin = scenario.trajectory.find(sample => sample.observed)?.observed ||
            scenario.trajectory[0]?.self || { x: 0, z: 0 };
        const scale = 42;
        const points = source => scenario.trajectory
            .map(sample => sample[source])
            .filter(Boolean)
            .map(point => `${80 + (point.x - origin.x) * scale},${top + 75 + (point.z - origin.z) * scale}`)
            .join(' ');
        return [
            `<text x="20" y="${top}" class="label">${escapeXml(scenario.name)}: ${scenario.passed ? 'PASS' : 'FAIL'}</text>`,
            `<line x1="80" y1="${top + 75}" x2="850" y2="${top + 75}" class="axis"/>`,
            `<polyline points="${points('self')}" class="self"/>`,
            `<polyline points="${points('observed')}" class="observed"/>`
        ].join('\n');
    }).join('\n');
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
        '<style>.bg{fill:#10151d}.axis{stroke:#334155;stroke-width:1}.self{fill:none;stroke:#38bdf8;stroke-width:3}.observed{fill:none;stroke:#fbbf24;stroke-width:2}.label,.legend{fill:#e2e8f0;font:15px sans-serif}</style>',
        `<rect class="bg" width="${width}" height="${height}"/>`,
        '<text x="650" y="20" class="legend">self: blue | observer: yellow</text>',
        rows,
        '</svg>',
        ''
    ].join('\n');
}

function escapeXml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function activeControls(state = {}) {
    return ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
        .filter(control => state[control]);
}

function vector(value) {
    if (!value) return { x: 0, y: 0, z: 0 };
    return { x: round(value.x), y: round(value.y), z: round(value.z) };
}

function horizontalDistance(left, right) {
    if (!left || !right) return 0;
    return Math.hypot(right.x - left.x, right.z - left.z);
}

function distance3d(left, right) {
    return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function round(value) {
    return Number((Number(value) || 0).toFixed(3));
}

module.exports = { MovementTelemetry, analyzeScenario, motionStats, writeReport };
