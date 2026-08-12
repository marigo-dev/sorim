const fs = require('node:fs');
const path = require('node:path');

const SAVE_DELAY_MS = 500;
const MAX_EPISODES = 160;
const MAX_CONVERSATION = 24;
const MAX_COMMITMENTS = 80;

let file = null;
let timer = null;
let state = defaults();

function initialize(botName = 'marigo', options = {}) {
    flushTimer();
    const safeName = String(botName).replace(/[^a-zA-Z0-9_-]/g, '_') || 'marigo';
    const directory = options.directory || path.join(__dirname, '..', 'data', 'agent-memory');
    file = path.join(directory, `${safeName}.json`);
    state = defaults();
    if (!fs.existsSync(file)) return;
    try {
        state = normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
        console.log(`[AGENT_MEMORY] loaded ${file}`);
    } catch (error) {
        console.log(`[AGENT_MEMORY] ignored unreadable state: ${error.message}`);
    }
}

function getState() {
    return clone(state);
}

function getProfession() {
    return clone(state.profession);
}

function getDirective() {
    return clone(state.directive);
}

function setDirective(directive) {
    state.directive = directive?.type ? {
        type: String(directive.type),
        username: directive.username || null,
        anchor: directive.anchor ? position(directive.anchor) : null,
        range: Math.max(1, Math.min(12, Number(directive.range || 3))),
        assignedBy: directive.assignedBy || directive.username || null,
        assignedAt: Number(directive.assignedAt || Date.now())
    } : null;
    addEpisode(
        state.directive ? 'directive_started' : 'directive_stopped',
        state.directive ? `Persistent ${state.directive.type} directive started.` : 'Persistent player directive stopped.',
        0.75,
        state.directive || {}
    );
    scheduleSave();
    return clone(state.directive);
}

function getCustomProfessions() {
    return clone(state.customProfessions);
}

function saveCustomProfession(profile) {
    if (!profile?.id) return null;
    state.customProfessions[profile.id] = clone(profile);
    addEpisode('profession_created', `Learned custom profession ${profile.id}.`, 0.85, {
        displayName: profile.displayName || profile.id
    });
    scheduleSave();
    return clone(profile);
}

function setProfession(id, assignedBy) {
    state.profession = {
        id,
        status: 'active',
        assignedBy: assignedBy || null,
        assignedAt: Date.now()
    };
    addEpisode('profession_assigned', `Profession changed to ${id}.`, 0.8, { assignedBy });
    scheduleSave();
}

function stopProfession() {
    if (!state.profession) return;
    addEpisode('profession_stopped', `Profession ${state.profession.id} stopped.`, 0.7);
    state.profession = null;
    scheduleSave();
}

function pauseProfession(paused = true) {
    if (!state.profession) return;
    state.profession.status = paused ? 'paused' : 'active';
    scheduleSave();
}

function rememberPlayer(username, patch = {}) {
    if (!username) return;
    const current = state.players[username] || {
        username,
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
        preferences: [],
        relationshipSummary: ''
    };
    state.players[username] = {
        ...current,
        ...plainObject(patch),
        username,
        lastSeenAt: Date.now()
    };
    scheduleSave();
}

function getPlayer(username) {
    const player = state.players[username] || null;
    if (!player) return null;
    return clone({ ...player, conversationSummary: state.conversationSummaries[username] || null });
}

function addConversation(username, role, text) {
    if (!text) return;
    state.conversation.push({ username, role, text: String(text).slice(0, 500), timestamp: Date.now() });
    state.conversation = state.conversation.slice(-MAX_CONVERSATION);
    refreshConversationSummary(username);
    scheduleSave();
}

function getConversation(username, limit = 8) {
    return state.conversation
        .filter(entry => !username || entry.username === username)
        .slice(-limit)
        .map(entry => ({ ...entry }));
}

function addEpisode(type, summary, importance = 0.5, details = {}) {
    if (!summary) return;
    state.episodes.push({
        type,
        summary: String(summary).slice(0, 500),
        importance: Math.max(0, Math.min(1, Number(importance) || 0)),
        timestamp: Date.now(),
        details: plainObject(details)
    });
    state.episodes = state.episodes
        .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
        .slice(0, MAX_EPISODES)
        .sort((a, b) => a.timestamp - b.timestamp);
    scheduleSave();
}

function getRelevantEpisodes(limit = 8) {
    return [...state.episodes]
        .sort((a, b) => b.importance - a.importance || b.timestamp - a.timestamp)
        .slice(0, limit)
        .map(entry => ({ ...entry }));
}

function addCommitment(commitment) {
    if (!commitment?.id) return null;
    const existing = state.commitments.find(entry => entry.id === commitment.id);
    const value = {
        id: String(commitment.id),
        player: commitment.player || null,
        summary: String(commitment.summary || commitment.id).slice(0, 300),
        status: commitment.status || existing?.status || 'active',
        createdAt: existing?.createdAt || Date.now(),
        updatedAt: Date.now(),
        details: plainObject(commitment.details)
    };
    if (existing) Object.assign(existing, value);
    else state.commitments.push(value);
    state.commitments = state.commitments.slice(-MAX_COMMITMENTS);
    scheduleSave();
    return clone(value);
}

function resolveCommitment(id, status, details = {}) {
    const commitment = state.commitments.find(entry => entry.id === id);
    if (!commitment) return null;
    commitment.status = status;
    commitment.updatedAt = Date.now();
    commitment.resolvedAt = Date.now();
    commitment.details = { ...plainObject(commitment.details), ...plainObject(details) };
    scheduleSave();
    return clone(commitment);
}

function getCommitments(username = null, status = null) {
    return state.commitments.filter(entry =>
        (!username || entry.player === username) && (!status || entry.status === status)
    ).map(clone);
}

function recordProactiveReport(key, cooldownMs = 30000) {
    const now = Date.now();
    const previous = Number(state.proactiveReports[key] || 0);
    if (now - previous < cooldownMs) return false;
    state.proactiveReports[key] = now;
    scheduleSave();
    return true;
}

function setTaskQueue(tasks) {
    state.taskQueue = Array.isArray(tasks) ? clone(tasks) : [];
    scheduleSave();
}

function getTaskQueue() {
    return clone(state.taskQueue);
}

function addProtectedZone(zone) {
    const normalized = normalizeZone(zone);
    if (!normalized) return null;
    const index = state.protectedZones.findIndex(entry => entry.id === normalized.id);
    if (index >= 0) state.protectedZones[index] = normalized;
    else state.protectedZones.push(normalized);
    scheduleSave();
    return clone(normalized);
}

function getProtectedZones() {
    return clone(state.protectedZones);
}

function removeProtectedZone(id) {
    const before = state.protectedZones.length;
    state.protectedZones = state.protectedZones.filter(zone => zone.id !== id);
    if (state.protectedZones.length !== before) scheduleSave();
}

function flush() {
    flushTimer();
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...state }, null, 2), 'utf8');
    fs.renameSync(temporary, file);
}

function scheduleSave() {
    if (!file || timer) return;
    timer = setTimeout(() => {
        timer = null;
        flush();
    }, SAVE_DELAY_MS);
    timer.unref?.();
}

function flushTimer() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
}

function defaults() {
    return {
        profession: null,
        directive: null,
        customProfessions: {},
        players: {},
        conversation: [],
        episodes: [],
        conversationSummaries: {},
        commitments: [],
        proactiveReports: {},
        taskQueue: [],
        protectedZones: []
    };
}

function normalize(saved) {
    const initial = defaults();
    return {
        ...initial,
        profession: saved?.profession?.id ? plainObject(saved.profession) : null,
        directive: saved?.directive?.type ? plainObject(saved.directive) : null,
        customProfessions: plainObject(saved?.customProfessions),
        players: plainObject(saved?.players),
        conversation: Array.isArray(saved?.conversation) ? saved.conversation.slice(-MAX_CONVERSATION) : [],
        episodes: Array.isArray(saved?.episodes) ? saved.episodes.slice(-MAX_EPISODES) : [],
        conversationSummaries: plainObject(saved?.conversationSummaries),
        commitments: Array.isArray(saved?.commitments) ? saved.commitments.slice(-MAX_COMMITMENTS) : [],
        proactiveReports: plainObject(saved?.proactiveReports),
        taskQueue: Array.isArray(saved?.taskQueue) ? saved.taskQueue : [],
        protectedZones: Array.isArray(saved?.protectedZones)
            ? saved.protectedZones.map(normalizeZone).filter(Boolean)
            : []
    };
}

function refreshConversationSummary(username) {
    if (!username) return;
    const entries = state.conversation.filter(entry => entry.username === username).slice(-8);
    if (entries.length < 4 || entries.length % 4 !== 0) return;
    const summary = entries.map(entry => `${entry.role}: ${entry.text}`).join(' | ').slice(-1200);
    state.conversationSummaries[username] = {
        summary,
        throughTimestamp: entries[entries.length - 1].timestamp,
        updatedAt: Date.now()
    };
}

function normalizeZone(zone) {
    if (!zone?.id || !zone?.bounds?.min || !zone?.bounds?.max) return null;
    const min = position(zone.bounds.min);
    const max = position(zone.bounds.max);
    if (!min || !max) return null;
    return {
        id: String(zone.id),
        type: String(zone.type || 'protected'),
        bounds: {
            min: { x: Math.min(min.x, max.x), y: Math.min(min.y, max.y), z: Math.min(min.z, max.z) },
            max: { x: Math.max(min.x, max.x), y: Math.max(min.y, max.y), z: Math.max(min.z, max.z) }
        },
        policies: { mining: false, treeCutting: false, terrainModification: 'repair_only', ...plainObject(zone.policies) }
    };
}

function position(value) {
    const numbers = [Number(value?.x), Number(value?.y), Number(value?.z)];
    if (!numbers.every(Number.isFinite)) return null;
    return { x: Math.floor(numbers[0]), y: Math.floor(numbers[1]), z: Math.floor(numbers[2]) };
}

function plainObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function clone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

module.exports = {
    initialize,
    flush,
    getState,
    getProfession,
    getDirective,
    setDirective,
    getCustomProfessions,
    saveCustomProfession,
    setProfession,
    stopProfession,
    pauseProfession,
    rememberPlayer,
    getPlayer,
    addConversation,
    getConversation,
    addEpisode,
    getRelevantEpisodes,
    addCommitment,
    resolveCommitment,
    getCommitments,
    recordProactiveReport,
    setTaskQueue,
    getTaskQueue,
    addProtectedZone,
    getProtectedZones,
    removeProtectedZone
};
