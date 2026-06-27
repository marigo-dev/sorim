const fs = require('fs');
const path = require('path');

const MEMORY_DIR = path.join(__dirname, '..', 'memory');
const MEMORY_FILE = path.join(MEMORY_DIR, 'colony.json');

function load() {
    ensureDir();
    if (!fs.existsSync(MEMORY_FILE)) return defaultMemory();
    try {
        return {
            ...defaultMemory(),
            ...JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf8'))
        };
    } catch {
        return defaultMemory();
    }
}

function save(memory) {
    ensureDir();
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2));
}

function reset(settlementCenter) {
    const memory = defaultMemory();
    memory.settlementCenter = settlementCenter;
    memory.createdAt = new Date().toISOString();
    memory.updatedAt = memory.createdAt;
    save(memory);
    return memory;
}

function setBotBase(name, data) {
    const memory = load();
    memory.bots[name] = {
        ...(memory.bots[name] || {}),
        ...data,
        updatedAt: new Date().toISOString()
    };
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return memory;
}

function addMessage(message) {
    const memory = load();
    memory.messages.push({
        id: `${Date.now()}-${memory.messages.length + 1}`,
        at: new Date().toISOString(),
        ...message
    });
    memory.messages = memory.messages.slice(-80);
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return memory;
}

function addRequest(request) {
    const memory = load();
    const existing = memory.requests.find(entry =>
        entry.status !== 'complete' &&
        entry.item === request.item &&
        entry.requester === request.requester
    );
    const now = new Date().toISOString();

    if (existing) {
        Object.assign(existing, request, {
            status: existing.status || 'open',
            updatedAt: now
        });
    } else {
        memory.requests.push({
            id: request.id || `${Date.now()}-${memory.requests.length + 1}`,
            status: 'open',
            createdAt: now,
            updatedAt: now,
            ...request
        });
    }

    memory.updatedAt = now;
    save(memory);
    return memory;
}

function claimRequest(id, botName) {
    const memory = load();
    const request = memory.requests.find(entry => entry.id === id);
    if (request && request.status !== 'complete') {
        request.status = 'claimed';
        request.claimedBy = botName;
        request.updatedAt = new Date().toISOString();
    }
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return request || null;
}

function completeRequest(id, botName, delivered = null) {
    const memory = load();
    const request = memory.requests.find(entry => entry.id === id);
    if (request) {
        request.status = 'complete';
        request.completedBy = botName;
        request.delivered = delivered;
        request.completedAt = new Date().toISOString();
        request.updatedAt = request.completedAt;
    }
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return request || null;
}

function activeRequests() {
    return load().requests.filter(request => request.status !== 'complete');
}

function addProject(project) {
    const memory = load();
    const existing = memory.projects.find(entry => entry.id === project.id);
    if (existing) Object.assign(existing, project, { updatedAt: new Date().toISOString() });
    else {
        memory.projects.push({
            status: 'planned',
            createdAt: new Date().toISOString(),
            ...project
        });
    }
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return memory;
}

function completeProject(id) {
    const memory = load();
    const project = memory.projects.find(entry => entry.id === id);
    if (project) {
        project.status = 'complete';
        project.completedAt = new Date().toISOString();
        project.updatedAt = project.completedAt;
    }
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return memory;
}

function setSharedStorage(data) {
    const memory = load();
    memory.sharedStorage = {
        ...memory.sharedStorage,
        ...data,
        updatedAt: new Date().toISOString()
    };
    memory.updatedAt = new Date().toISOString();
    save(memory);
    return memory;
}

function defaultMemory() {
    return {
        createdAt: null,
        updatedAt: null,
        settlementCenter: null,
        sharedStorage: null,
        bots: {},
        messages: [],
        projects: [],
        requests: []
    };
}

function ensureDir() {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

module.exports = {
    load,
    save,
    reset,
    setBotBase,
    addMessage,
    addRequest,
    claimRequest,
    completeRequest,
    activeRequests,
    addProject,
    completeProject,
    setSharedStorage
};
