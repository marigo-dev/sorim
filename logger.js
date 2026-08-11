const LEVELS = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4
};

const DEFAULT_LEVEL = 'info';
const levelName = (process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
const activeLevel = LEVELS[levelName] ?? LEVELS[DEFAULT_LEVEL];

const DEBUG_PREFIXES = [
    '[LOOP]',
    '[AI_LOOP]',
    '[AI_REJECTED]',
    '[SURVIVAL_LOOP]',
    '[MOVE]',
    '[PHYSICS]',
    '[MINE]',
    '[TREE]',
    '[STONE]',
    '[CRAFT]',
    '[PLACE]',
    '[TOOLS]',
    '[SHELTER]',
    '[SMELT]',
    '[BUILD]',
    '[COLONY]',
    '[SHARED]',
    '[STORAGE]',
    '[FOOD]',
    '[HOMESTEAD]',
    '[MEMORY]'
];

const WARN_PREFIXES = [
    '[STEP_ERROR]',
    '[LLM]',
    '[KICKED]',
    '[BOT_ERROR]',
    '[DEATH]'
];

const ERROR_PREFIXES = [
    '[FATAL]',
    '[COLONY_FATAL]'
];

function installConsoleFilter() {
    const originalLog = console.log.bind(console);

    console.log = (...args) => {
        const first = String(args[0] ?? '');
        const messageLevel = classify(first);
        if (activeLevel >= messageLevel) {
            originalLog(...args);
        }
    };
}

function classify(message) {
    if (ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) {
        return LEVELS.error;
    }
    if (WARN_PREFIXES.some(prefix => message.startsWith(prefix))) {
        return LEVELS.warn;
    }
    if (DEBUG_PREFIXES.some(prefix => message.startsWith(prefix))) {
        return LEVELS.debug;
    }
    return LEVELS.info;
}

module.exports = {
    installConsoleFilter
};
