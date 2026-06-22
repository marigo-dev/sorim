const { Vec3 } = require('vec3');

const mine = require('./skills/mine');
const craft = require('./skills/craft');
const movement = require('./skills/movement');
const stone = require('./skills/stone');
const tools = require('./skills/tools');
const shelter = require('./skills/shelter');
const survival = require('./skills/survival');
const food = require('./skills/food');
const storage = require('./skills/storage');

const TOOL_DEFINITIONS = [
    {
        name: 'explore',
        description: 'Move around to search for a target category such as wood, food, stone, or safe terrain.',
        args: { target: 'string optional' },
        actions: ['explore']
    },
    {
        name: 'mine_block',
        description: 'Mine a reachable block by name. Use any_log when any reachable tree log is acceptable.',
        args: { target: 'string required' },
        actions: ['mine']
    },
    {
        name: 'craft_item',
        description: 'Craft an item from inventory or a nearby crafting table.',
        args: { item: 'string required', count: 'number optional' },
        actions: ['craft']
    },
    {
        name: 'place_block',
        description: 'Place a block from inventory near the bot.',
        args: { item: 'string required' },
        actions: ['place']
    },
    {
        name: 'collect_stone',
        description: 'Dig a safe staircase, collect cobblestone, and return upward.',
        args: { count: 'number optional' },
        actions: ['collect_stone']
    },
    {
        name: 'craft_stone_tools',
        description: 'Craft stone pickaxe, stone axe, and stone sword.',
        args: {},
        actions: ['craft_stone_tools']
    },
    {
        name: 'build_shelter',
        description: 'Build a small enclosed starter shelter and register it as the base.',
        args: {},
        actions: ['build_shelter']
    },
    {
        name: 'eat_food',
        description: 'Eat the best available food from inventory.',
        args: {},
        actions: ['eat_food']
    },
    {
        name: 'find_food',
        description: 'Search for nearby food sources such as animals or crops.',
        args: {},
        actions: ['find_food']
    },
    {
        name: 'fight_mob',
        description: 'Fight a hostile mob by entity id. Usually selected by the safety supervisor.',
        args: { entityId: 'number optional' },
        actions: ['fight_mob']
    },
    {
        name: 'escape_pit',
        description: 'Get out of a pit or cramped hole.',
        args: {},
        actions: ['escape_pit']
    },
    {
        name: 'return_base',
        description: 'Return to the remembered base location.',
        args: {},
        actions: ['return_base']
    },
    {
        name: 'wait_safe',
        description: 'Stop moving and wait safely for a short time.',
        args: { ms: 'number optional' },
        actions: ['wait_safe', 'idle']
    },
    {
        name: 'sleep_bed',
        description: 'Sleep in a nearby bed.',
        args: {},
        actions: ['sleep_bed']
    },
    {
        name: 'organize_storage',
        description: 'Place/open a chest near base and deposit excess inventory.',
        args: {},
        actions: ['organize_storage']
    },
    {
        name: 'move_near',
        description: 'Move near explicit coordinates. Use sparingly; higher level tools are safer.',
        args: { x: 'number required', y: 'number required', z: 'number required', range: 'number optional' },
        actions: ['move_near']
    }
];

const TOOLS_BY_NAME = Object.fromEntries(TOOL_DEFINITIONS.map(tool => [tool.name, tool]));

function toolsForLevel(level) {
    if (!level?.allowedActions) return TOOL_DEFINITIONS;
    const allowed = new Set(level.allowedActions);
    return TOOL_DEFINITIONS.filter(tool =>
        tool.actions.some(action => allowed.has(action)) ||
        ['wait_safe', 'return_base', 'escape_pit', 'fight_mob', 'eat_food'].includes(tool.name)
    );
}

function normalizeToolCall(input) {
    if (!input || typeof input !== 'object') return null;

    if (typeof input.tool === 'string') {
        return {
            tool: input.tool,
            args: sanitizeArgs(input.args || {}),
            reason: typeof input.reason === 'string' ? input.reason : ''
        };
    }

    return actionToToolCall(input);
}

function validateToolCall(call, availableTools) {
    if (!call || typeof call.tool !== 'string') return null;
    const allowedNames = new Set(availableTools.map(tool => tool.name));
    if (!allowedNames.has(call.tool)) return null;
    if (!TOOLS_BY_NAME[call.tool]) return null;
    return {
        tool: call.tool,
        args: sanitizeArgs(call.args || {}),
        reason: call.reason || ''
    };
}

function actionToToolCall(action) {
    if (!action || typeof action !== 'object') return null;
    const args = { ...action };
    delete args.action;
    delete args.reason;

    const map = {
        explore: 'explore',
        mine: 'mine_block',
        craft: 'craft_item',
        place: 'place_block',
        collect_stone: 'collect_stone',
        craft_stone_tools: 'craft_stone_tools',
        build_shelter: 'build_shelter',
        eat_food: 'eat_food',
        find_food: 'find_food',
        fight_mob: 'fight_mob',
        escape_pit: 'escape_pit',
        return_base: 'return_base',
        wait_safe: 'wait_safe',
        sleep_bed: 'sleep_bed',
        organize_storage: 'organize_storage',
        move_near: 'move_near',
        idle: 'wait_safe'
    };

    const tool = map[action.action];
    if (!tool) return null;

    if (tool === 'mine_block' && action.target) args.target = action.target;
    if (tool === 'craft_item' && action.item) args.item = action.item;
    if (tool === 'place_block' && action.item) args.item = action.item;
    if (tool === 'wait_safe' && !args.ms) args.ms = action.ms || 1000;

    return {
        tool,
        args: sanitizeArgs(args),
        reason: action.reason || ''
    };
}

function fallbackToolCall(skillTree, observation, level) {
    return normalizeToolCall(skillTree.fallbackAction(observation, level));
}

async function executeToolCall(bot, call) {
    const args = call?.args || {};

    if (!call || call.tool === 'wait_safe') {
        await sleep(args.ms || 1000);
        return;
    }

    if (call.tool === 'explore') {
        await movement.explore(bot, { target: args.target || 'around' });
        return;
    }

    if (call.tool === 'mine_block') {
        await mine.mineBlock(bot, { target: requireString(args.target, 'target') });
        return;
    }

    if (call.tool === 'craft_item') {
        await craft.craftItem(bot, requireString(args.item, 'item'), Number(args.count || 1));
        return;
    }

    if (call.tool === 'place_block') {
        await craft.placeBlock(bot, requireString(args.item, 'item'));
        return;
    }

    if (call.tool === 'move_near') {
        await movement.moveNear(
            bot,
            new Vec3(Number(args.x), Number(args.y), Number(args.z)),
            Number(args.range || 2)
        );
        return;
    }

    if (call.tool === 'collect_stone') {
        await stone.collectStone(bot, Number(args.count || 16));
        return;
    }

    if (call.tool === 'craft_stone_tools') {
        await tools.craftStoneTools(bot);
        return;
    }

    if (call.tool === 'build_shelter') {
        await shelter.buildSafeShelter(bot);
        return;
    }

    if (call.tool === 'eat_food') {
        await food.eatBestFood(bot);
        return;
    }

    if (call.tool === 'find_food') {
        await food.findFood(bot);
        return;
    }

    if (call.tool === 'fight_mob') {
        await survival.fightMob(bot, args.entityId);
        return;
    }

    if (call.tool === 'escape_pit') {
        await survival.escapePit(bot);
        return;
    }

    if (call.tool === 'return_base') {
        await survival.returnBase(bot);
        return;
    }

    if (call.tool === 'sleep_bed') {
        await survival.sleepInBed(bot);
        return;
    }

    if (call.tool === 'organize_storage') {
        await storage.organizeStorage(bot);
        return;
    }

    throw new Error(`Unknown tool: ${call.tool}`);
}

function sanitizeArgs(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
    return Object.fromEntries(
        Object.entries(args).filter(([, value]) =>
            ['string', 'number', 'boolean'].includes(typeof value) && value !== ''
        )
    );
}

function requireString(value, name) {
    if (typeof value !== 'string' || value.length === 0) {
        throw new Error(`Tool argument "${name}" is required`);
    }
    return value;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = {
    TOOL_DEFINITIONS,
    toolsForLevel,
    normalizeToolCall,
    validateToolCall,
    actionToToolCall,
    fallbackToolCall,
    executeToolCall
};
