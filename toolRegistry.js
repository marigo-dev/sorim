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
const mining = require('./skills/mining');
const memory = require('./skills/memory');
const smelting = require('./skills/smelting');
const iron = require('./skills/iron');
const build = require('./skills/build');
const sharedStorage = require('./skills/sharedStorage');
const colonyBuild = require('./skills/colonyBuild');

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
        name: 'prepare_mining_kit',
        description: 'Prepare furnace, fuel, torches, food readiness, and support blocks before iron mining.',
        args: {},
        actions: ['prepare_mining_kit']
    },
    {
        name: 'mine_iron',
        description: 'Open a safe stair mine, place torches, mine iron ore, and return toward base.',
        args: { count: 'number optional' },
        actions: ['mine_iron']
    },
    {
        name: 'smelt_item',
        description: 'Smelt an input item into an output item using furnace and fuel.',
        args: { input: 'string required', output: 'string required', count: 'number optional' },
        actions: ['smelt_item']
    },
    {
        name: 'craft_iron_kit',
        description: 'Craft iron pickaxe, sword, axe, and shield while preserving the reserve.',
        args: {},
        actions: ['craft_iron_kit']
    },
    {
        name: 'craft_iron_armor',
        description: 'Craft and equip full iron armor while preserving 8 iron ingots.',
        args: {},
        actions: ['craft_iron_armor']
    },
    {
        name: 'build_blueprint',
        description: 'Creative-mode build tool. Builds one named blueprint from the local catalog.',
        args: { name: 'string required', x: 'number optional', y: 'number optional', z: 'number optional' },
        actions: ['build_blueprint']
    },
    {
        name: 'build_showcase',
        description: 'Creative-mode build tool. Builds every local catalog blueprint in a spaced showcase grid.',
        args: { x: 'number optional', y: 'number optional', z: 'number optional' },
        actions: ['build_showcase']
    },
    {
        name: 'ensure_shared_storage',
        description: 'Survival-mode colony tool. Ensure the shared storage chest exists at the registered colony storage position.',
        args: { x: 'number optional', y: 'number optional', z: 'number optional' },
        actions: ['ensure_shared_storage']
    },
    {
        name: 'deposit_shared_storage',
        description: 'Survival-mode colony tool. Deposit an inventory item into shared storage.',
        args: { item: 'string required', count: 'number optional' },
        actions: ['deposit_shared_storage']
    },
    {
        name: 'withdraw_shared_storage',
        description: 'Survival-mode colony tool. Withdraw an item from shared storage.',
        args: { item: 'string required', count: 'number required' },
        actions: ['withdraw_shared_storage']
    },
    {
        name: 'count_shared_storage',
        description: 'Survival-mode colony tool. Count items currently inside shared storage.',
        args: {},
        actions: ['count_shared_storage']
    },
    {
        name: 'build_colony_marker',
        description: 'Survival-mode colony tool. Spend shared resources on a small base/foundation marker.',
        args: { material: 'string optional' },
        actions: ['build_colony_marker']
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
        prepare_mining_kit: 'prepare_mining_kit',
        mine_iron: 'mine_iron',
        smelt_item: 'smelt_item',
        craft_iron_kit: 'craft_iron_kit',
        craft_iron_armor: 'craft_iron_armor',
        build_blueprint: 'build_blueprint',
        build_showcase: 'build_showcase',
        ensure_shared_storage: 'ensure_shared_storage',
        deposit_shared_storage: 'deposit_shared_storage',
        withdraw_shared_storage: 'withdraw_shared_storage',
        count_shared_storage: 'count_shared_storage',
        build_colony_marker: 'build_colony_marker',
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

    if (call.tool === 'prepare_mining_kit') {
        await mining.prepareMiningKit(bot);
        return;
    }

    if (call.tool === 'mine_iron') {
        await mining.mineIron(bot, Number(args.count || 16));
        return;
    }

    if (call.tool === 'smelt_item') {
        if (memory.getMineRoute().length > 0) {
            await mining.returnToSurface(bot);
            return;
        }
        await smelting.smeltItem(
            bot,
            requireString(args.input, 'input'),
            requireString(args.output, 'output'),
            Number(args.count || 1)
        );
        return;
    }

    if (call.tool === 'craft_iron_kit') {
        if (memory.getMineRoute().length > 0) {
            await mining.returnToSurface(bot);
            return;
        }
        await iron.craftIronKit(bot);
        return;
    }

    if (call.tool === 'craft_iron_armor') {
        if (memory.getMineRoute().length > 0) {
            await mining.returnToSurface(bot);
            return;
        }
        await iron.craftIronArmor(bot);
        return;
    }

    if (call.tool === 'build_blueprint') {
        await build.buildBlueprint(bot, requireString(args.name, 'name'), optionalPosition(args));
        return;
    }

    if (call.tool === 'build_showcase') {
        await build.buildShowcase(bot, optionalPosition(args));
        return;
    }

    if (call.tool === 'ensure_shared_storage') {
        await sharedStorage.ensureSharedStorage(bot, optionalPosition(args));
        return;
    }

    if (call.tool === 'deposit_shared_storage') {
        await sharedStorage.depositToSharedStorage(
            bot,
            requireString(args.item, 'item'),
            args.count ? Number(args.count) : null
        );
        return;
    }

    if (call.tool === 'withdraw_shared_storage') {
        await sharedStorage.withdrawFromSharedStorage(
            bot,
            requireString(args.item, 'item'),
            Number(args.count || 1)
        );
        return;
    }

    if (call.tool === 'count_shared_storage') {
        const counts = await sharedStorage.countSharedStorage(bot);
        console.log(`[SHARED] inventory=${JSON.stringify(counts)}`);
        return;
    }

    if (call.tool === 'build_colony_marker') {
        await colonyBuild.buildColonyMarker(bot, args.material || 'cobblestone');
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

function optionalPosition(args) {
    if ([args.x, args.y, args.z].every(value => typeof value === 'number' && Number.isFinite(value))) {
        return { x: args.x, y: args.y, z: args.z };
    }
    return null;
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
