const Module = require('module');

const ENABLED = process.env.ENABLE_EXPERIMENTAL_26_2 === 'true' ||
    process.env.MC_VERSION === '26.2';

const MAPPINGS_1_21_11_TO_26_1 = {
    items: { at: [230], to: [231] },
    blocks: { at: [158, 423], to: [159, 425] },
    blockstates: { at: [1381, 2122, 10441], to: [1581, 2323, 10643] }
};

const MAPPINGS_26_1_TO_26_2 = {
    entities: { at: [130], to: [131] },
    items: {
        at: [26, 92, 95, 98, 102, 106, 110, 114, 118, 122, 126, 130, 1025, 1167, 1313, 1421],
        to: [53, 126, 119, 129, 137, 145, 153, 122, 133, 141, 149, 157, 1053, 1196, 1343, 1452]
    },
    blocks: {
        at: [998, 1011, 1013, 1014, 1015, 1016, 1017, 1018, 1019, 1020, 1021, 1022, 1023, 1024, 1025, 1026, 1027, 1028, 1029, 1030, 1031, 1032, 1033, 1034, 1035, 1036, 1037, 1038, 1039, 1040, 1041, 1042, 1043, 1044, 1045, 1046, 1047, 1048, 1049, 1051, 1052, 1053, 1055, 1056, 1057, 1059, 1060, 1061, 1063, 1064, 1065, 1105, 1106, 1107],
        to: [1025, 1042, 1047, 1046, 1045, 1044, 1055, 1054, 1053, 1052, 1059, 1058, 1057, 1056, 1063, 1062, 1061, 1060, 1071, 1070, 1069, 1068, 1038, 1040, 1039, 1041, 1051, 1050, 1049, 1048, 1067, 1066, 1065, 1064, 1075, 1074, 1073, 1072, 1076, 1079, 1078, 1080, 1083, 1082, 1084, 1087, 1086, 1088, 1091, 1090, 1092, 1133, 1132, 1135]
    },
    blockstates: {
        at: [24687, 25313, 25315, 25316, 25317, 25318, 25319, 25320, 25321, 25322, 25323, 25324, 25325, 25326, 25327, 25407, 25487, 25567, 25647, 25653, 25659, 25665, 25671, 25672, 25673, 25674, 25675, 25676, 25677, 25678, 25679, 25759, 25839, 25919, 25999, 26005, 26011, 26017, 26023, 26151, 26215, 26279, 26407, 26471, 26535, 26663, 26727, 26791, 26919, 26983, 27047, 27735, 27755, 27756],
        to: [27160, 27790, 27795, 27794, 27793, 27792, 27803, 27802, 27801, 27800, 27807, 27806, 27805, 27804, 28048, 27968, 27888, 27808, 28466, 28460, 28454, 28448, 27786, 27788, 27787, 27789, 27799, 27798, 27797, 27796, 28368, 28288, 28208, 28128, 28490, 28484, 28478, 28472, 28496, 28688, 28624, 28752, 28944, 28880, 29008, 29200, 29136, 29264, 29456, 29392, 29520, 30209, 30208, 30249]
    }
};

// Protocol order from the vanilla 26.2 data-component registry report.
// Slot component ids are registry ids, so every insertion must be represented
// here or all following component payloads are decoded with the wrong codec.
const SLOT_COMPONENTS_26_2 = [
    'custom_data',
    'max_stack_size',
    'max_damage',
    'damage',
    'unbreakable',
    'use_effects',
    'custom_name',
    'minimum_attack_charge',
    'damage_type',
    'item_name',
    'item_model',
    'lore',
    'rarity',
    'enchantments',
    'can_place_on',
    'can_break',
    'attribute_modifiers',
    'custom_model_data',
    'tooltip_display',
    'repair_cost',
    'creative_slot_lock',
    'enchantment_glint_override',
    'intangible_projectile',
    'food',
    'consumable',
    'use_remainder',
    'use_cooldown',
    'damage_resistant',
    'tool',
    'weapon',
    'attack_range',
    'enchantable',
    'equippable',
    'repairable',
    'glider',
    'tooltip_style',
    'death_protection',
    'blocks_attacks',
    'piercing_weapon',
    'kinetic_weapon',
    'swing_animation',
    'additional_trade_cost',
    'stored_enchantments',
    'dye',
    'dyed_color',
    'map_color',
    'map_id',
    'map_decorations',
    'map_post_processing',
    'charged_projectiles',
    'bundle_contents',
    'potion_contents',
    'potion_duration_scale',
    'suspicious_stew_effects',
    'writable_book_content',
    'written_book_content',
    'trim',
    'debug_stick_state',
    'entity_data',
    'bucket_entity_data',
    'block_entity_data',
    'instrument',
    'provides_trim_material',
    'ominous_bottle_amplifier',
    'jukebox_playable',
    'provides_banner_patterns',
    'recipes',
    'lodestone_tracker',
    'firework_explosion',
    'fireworks',
    'profile',
    'note_block_sound',
    'banner_patterns',
    'base_color',
    'pot_decorations',
    'container',
    'block_state',
    'bees',
    'sulfur_cube_content',
    'lock',
    'container_loot',
    'break_sound',
    'villager/variant',
    'wolf/variant',
    'wolf/sound_variant',
    'wolf/collar',
    'fox/variant',
    'salmon/size',
    'parrot/variant',
    'tropical_fish/pattern',
    'tropical_fish/base_color',
    'tropical_fish/pattern_color',
    'mooshroom/variant',
    'rabbit/variant',
    'pig/variant',
    'pig/sound_variant',
    'cow/variant',
    'cow/sound_variant',
    'chicken/variant',
    'chicken/sound_variant',
    'zombie_nautilus/variant',
    'frog/variant',
    'horse/variant',
    'painting/variant',
    'llama/variant',
    'axolotl/variant',
    'cat/variant',
    'cat/sound_variant',
    'cat/collar',
    'sheep/color',
    'shulker/color'
];

if (ENABLED) {
    install26_2Shim();
}

function install26_2Shim() {
    const originalLoad = Module._load;
    let patchedMinecraftData = null;

    Module._load = function patchedLoad(request, parent, isMain) {
        if (request === 'minecraft-data') {
            if (!patchedMinecraftData) {
                const originalMinecraftData = originalLoad.apply(this, arguments);
                patchedMinecraftData = createMinecraftDataShim(originalMinecraftData);
            }
            return patchedMinecraftData;
        }

        if (request === './version' && parent?.filename) {
            const filename = parent.filename.replace(/\\/g, '/');
            if (filename.endsWith('/node_modules/mineflayer/lib/loader.js')) {
                return createMineflayerVersionShim(originalLoad.apply(this, arguments));
            }
            if (filename.includes('/node_modules/minecraft-protocol/src/')) {
                return createProtocolVersionShim(originalLoad.apply(this, arguments));
            }
        }

        if (request === './plugins/time' && parent?.filename) {
            const filename = parent.filename.replace(/\\/g, '/');
            if (filename.endsWith('/node_modules/mineflayer/lib/loader.js')) {
                return createMineflayerTimePluginShim();
            }
        }

        if (request.endsWith('PaletteChunkSection') && parent?.filename) {
            const filename = parent.filename.replace(/\\/g, '/');
            if (filename.includes('/node_modules/prismarine-chunk/src/pc/')) {
                return createChunkSection26_2Shim(originalLoad.apply(this, arguments));
            }
        }

        return originalLoad.apply(this, arguments);
    };
}

function createMinecraftDataShim(originalMinecraftData) {
    function minecraftData(version) {
        if (version === '26.2') {
            return make26_2Data(originalMinecraftData('1.21.11'));
        }
        return originalMinecraftData(version);
    }

    copyProperties(originalMinecraftData, minecraftData);
    add26_2VersionMetadata(minecraftData);
    return minecraftData;
}

function make26_2Data(base) {
    if (!base) return null;
    const data = {};
    copyProperties(base, data);
    apply26_2RegistryMappings(base, data);
    data.protocol = patch26_2Protocol(base.protocol);

    const version = {};
    copyProperties(base.version, version);
    version.minecraftVersion = '26.2';
    version.majorVersion = '1.21';
    version.version = 776;
    version.dataVersion = 4903;
    version.releaseType = 'release';
    data.version = version;
    return data;
}

function apply26_2RegistryMappings(base, data) {
    remapEntities(base, data);
    remapItems(base, data);
    remapBlocks(base, data);
    remapRecipes(base, data);
}

function remapEntities(base, data) {
    const entities = {};
    const entitiesByName = {};

    for (const entity of Object.values(base.entities || {})) {
        if (!entity || typeof entity.id !== 'number') continue;
        const mappedId = mapEntityId(entity.id);
        const mappedEntity = { ...entity, id: mappedId, internalId: mappedId };
        entities[mappedId] = mappedEntity;
        entitiesByName[mappedEntity.name] = mappedEntity;
    }

    data.entities = entities;
    data.entitiesByName = entitiesByName;

    const mobs = {};
    for (const entity of Object.values(base.mobs || {})) {
        if (!entity || typeof entity.id !== 'number') continue;
        const mappedId = mapEntityId(entity.id);
        mobs[mappedId] = { ...entity, id: mappedId, internalId: mappedId };
    }
    data.mobs = mobs;
}

function remapItems(base, data) {
    const items = {};
    const itemsByName = {};

    for (const item of Object.values(base.items || {})) {
        if (!item || typeof item.id !== 'number') continue;
        const mappedId = mapItemId(item.id);
        const mappedItem = { ...item, id: mappedId };
        items[mappedId] = mappedItem;
        itemsByName[mappedItem.name] = mappedItem;
    }

    data.items = items;
    data.itemsByName = itemsByName;
}

function remapBlocks(base, data) {
    const blocks = {};
    const blocksByName = {};
    const blocksByStateId = {};

    for (const block of Object.values(base.blocks || {})) {
        if (!block || typeof block.id !== 'number') continue;
        const mappedBlock = {
            ...block,
            id: mapBlockId(block.id),
            defaultState: mapBlockStateId(block.defaultState),
            minStateId: mapBlockStateId(block.minStateId),
            maxStateId: mapBlockStateId(block.maxStateId),
            drops: Array.isArray(block.drops) ? block.drops.map(mapItemId) : block.drops
        };

        blocks[mappedBlock.id] = mappedBlock;
        blocksByName[mappedBlock.name] = mappedBlock;

        for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) {
            blocksByStateId[mapBlockStateId(stateId)] = mappedBlock;
        }
    }

    data.blocks = blocks;
    data.blocksByName = blocksByName;
    data.blocksByStateId = blocksByStateId;
}

function remapRecipes(base, data) {
    const recipes = {};
    for (const [oldResultId, entries] of Object.entries(base.recipes || {})) {
        if (!Array.isArray(entries)) continue;
        recipes[mapItemId(Number(oldResultId))] = entries.map(remapRecipe);
    }
    data.recipes = recipes;
}

function remapRecipe(recipe) {
    const mapped = { ...recipe };
    if (Array.isArray(recipe.ingredients)) {
        mapped.ingredients = recipe.ingredients.map(mapRecipeIngredient);
    }
    if (Array.isArray(recipe.inShape)) {
        mapped.inShape = recipe.inShape.map(row => row.map(mapRecipeIngredient));
    }
    if (Array.isArray(recipe.outShape)) {
        mapped.outShape = recipe.outShape.map(row => row.map(mapRecipeIngredient));
    }
    if (recipe.result) {
        mapped.result = {
            ...recipe.result,
            id: mapItemId(recipe.result.id)
        };
    }
    return mapped;
}

function mapRecipeIngredient(ingredient) {
    if (typeof ingredient === 'number') return mapItemId(ingredient);
    if (ingredient && typeof ingredient === 'object' && typeof ingredient.id === 'number') {
        return { ...ingredient, id: mapItemId(ingredient.id) };
    }
    return ingredient;
}

function mapItemId(id) {
    return mapRange(mapRange(id, MAPPINGS_1_21_11_TO_26_1.items), MAPPINGS_26_1_TO_26_2.items);
}

function mapEntityId(id) {
    return mapRange(id, MAPPINGS_26_1_TO_26_2.entities);
}

function mapBlockId(id) {
    return mapRange(mapRange(id, MAPPINGS_1_21_11_TO_26_1.blocks), MAPPINGS_26_1_TO_26_2.blocks);
}

function mapBlockStateId(id) {
    return mapRange(mapRange(id, MAPPINGS_1_21_11_TO_26_1.blockstates), MAPPINGS_26_1_TO_26_2.blockstates);
}

function mapRange(id, mapping) {
    let mapped = id;
    for (let i = 0; i < mapping.at.length; i += 1) {
        if (id >= mapping.at[i]) mapped = id + mapping.to[i] - mapping.at[i];
        else break;
    }
    return mapped;
}

function patch26_2Protocol(baseProtocol) {
    const protocol = JSON.parse(JSON.stringify(baseProtocol));
    patchSlotComponents(protocol);
    patchLoginSuccess(protocol);
    patchPlayClientbound(protocol);
    patchPlayServerbound(protocol);
    return protocol;
}

function patchSlotComponents(protocol) {
    const componentMapper = protocol.types?.SlotComponentType?.[1]?.mappings;
    const componentFields = protocol.types?.SlotComponent?.[1]?.[1]?.type?.[1]?.fields;
    if (!componentMapper || !componentFields) {
        throw new Error('Unexpected minecraft-data slot component layout');
    }

    protocol.types.SlotComponentType[1].mappings = Object.fromEntries(
        SLOT_COMPONENTS_26_2.map((name, id) => [String(id), name])
    );

    componentFields.additional_trade_cost = 'varint';
    componentFields.dye = 'varint';
    componentFields.sulfur_cube_content = 'ItemStackTemplate26_2';

    // Vanilla holders use a single positive registry varint. Direct custom
    // registry entries are not yet decoded, but consuming the common form
    // keeps ordinary inventory packets aligned.
    componentFields['wolf/sound_variant'] = 'varint';
    componentFields['pig/sound_variant'] = 'varint';
    componentFields['cow/sound_variant'] = 'varint';
    componentFields['chicken/sound_variant'] = 'varint';
    componentFields['cat/sound_variant'] = 'varint';

    protocol.types.ItemStackTemplate26_2 = [
        'container',
        [
            { name: 'itemId', type: 'varint' },
            { name: 'itemCount', type: 'varint' },
            { name: 'addedComponentCount', type: 'varint' },
            { name: 'removedComponentCount', type: 'varint' },
            {
                name: 'components',
                type: ['array', { count: 'addedComponentCount', type: 'SlotComponent' }]
            },
            {
                name: 'removeComponents',
                type: [
                    'array',
                    {
                        count: 'removedComponentCount',
                        type: ['container', [{ name: 'type', type: 'SlotComponentType' }]]
                    }
                ]
            }
        ]
    ];
}

function patchLoginSuccess(protocol) {
    const fields = protocol.login?.toClient?.types?.packet_success?.[1];
    if (!Array.isArray(fields) || fields.some(field => field.name === 'sessionId')) return;
    fields.push({ name: 'sessionId', type: 'UUID' });
}

function patchPlayClientbound(protocol) {
    const loginFields = protocol.play.toClient.types.packet_login?.[1];
    if (Array.isArray(loginFields) && !loginFields.some(field => field.name === 'serverAuthoritativeBlockBreaking')) {
        loginFields.push({ name: 'serverAuthoritativeBlockBreaking', type: 'bool' });
    }

    protocol.play.toClient.types.packet_declare_recipes = rawPacket();
    protocol.play.toClient.types.packet_recipe_book_add = rawPacket();
    protocol.play.toClient.types.packet_recipe_book_remove = rawPacket();
    protocol.play.toClient.types.packet_recipe_book_settings = rawPacket();
    protocol.play.toClient.types.packet_advancements = rawPacket();
    protocol.play.toClient.types.packet_explosion = rawPacket();
    protocol.play.toClient.types.packet_world_particles = rawPacket();
    protocol.play.toClient.types.packet_entity_metadata = [
        'container',
        [
            { name: 'entityId', type: 'varint' },
            { name: 'data', type: 'restBuffer' }
        ]
    ];

    protocol.play.toClient.types.packet_update_time = [
        'container',
        [
            { name: 'age', type: 'i64' },
            {
                name: 'clocks',
                type: [
                    'array',
                    {
                        countType: 'varint',
                        type: [
                            'container',
                            [
                                { name: 'clockId', type: 'varint' },
                                { name: 'time', type: 'varlong' },
                                { name: 'partialTick', type: 'f32' },
                                { name: 'tickRate', type: 'f32' }
                            ]
                        ]
                    }
                ]
            }
        ]
    ];

    const names = [
        'bundle_delimiter',
        'spawn_entity',
        'animation',
        'statistics',
        'acknowledge_player_digging',
        'block_break_animation',
        'tile_entity_data',
        'block_action',
        'block_change',
        'boss_bar',
        'difficulty',
        'chunk_batch_finished',
        'chunk_batch_start',
        'chunk_biomes',
        'clear_titles',
        'tab_complete',
        'declare_commands',
        'close_window',
        'window_items',
        'craft_progress_bar',
        'set_slot',
        'cookie_request',
        'set_cooldown',
        'chat_suggestions',
        'custom_payload',
        'damage_event',
        'debug_block_value',
        'debug_chunk_value',
        'debug_entity_value',
        'debug_event',
        'debug_sample',
        'hide_message',
        'kick_disconnect',
        'profileless_chat',
        'entity_status',
        'sync_entity_position',
        'explosion',
        'unload_chunk',
        'game_state_change',
        'game_rule_values',
        'game_test_highlight_pos',
        'open_horse_window',
        'hurt_animation',
        'initialize_world_border',
        'keep_alive',
        'map_chunk',
        'world_event',
        'world_particles',
        'update_light',
        'login',
        'low_disk_space_warning',
        'map',
        'trade_list',
        'rel_entity_move',
        'entity_move_look',
        'move_minecart',
        'entity_look',
        'vehicle_move',
        'open_book',
        'open_window',
        'open_sign_entity',
        'ping',
        'ping_response',
        'craft_recipe_response',
        'abilities',
        'player_chat',
        'end_combat_event',
        'enter_combat_event',
        'death_combat_event',
        'player_remove',
        'player_info',
        'face_player',
        'position',
        'player_rotation',
        'recipe_book_add',
        'recipe_book_remove',
        'recipe_book_settings',
        'entity_destroy',
        'remove_entity_effect',
        'reset_score',
        'remove_resource_pack',
        'add_resource_pack',
        'respawn',
        'entity_head_rotation',
        'multi_block_change',
        'select_advancement_tab',
        'server_data',
        'action_bar',
        'world_border_center',
        'world_border_lerp_size',
        'world_border_size',
        'world_border_warning_delay',
        'world_border_warning_reach',
        'camera',
        'update_view_position',
        'update_view_distance',
        'set_cursor_item',
        'spawn_position',
        'scoreboard_display_objective',
        'entity_metadata',
        'attach_entity',
        'entity_velocity',
        'entity_equipment',
        'experience',
        'update_health',
        'held_item_slot',
        'scoreboard_objective',
        'set_passengers',
        'set_player_inventory',
        'teams',
        'scoreboard_score',
        'simulation_distance',
        'set_title_subtitle',
        'update_time',
        'set_title_text',
        'set_title_time',
        'entity_sound_effect',
        'sound_effect',
        'start_configuration',
        'stop_sound',
        'store_cookie',
        'system_chat',
        'playerlist_header',
        'nbt_query_response',
        'collect',
        'entity_teleport',
        'test_instance_block_status',
        'set_ticking_state',
        'step_tick',
        'transfer',
        'advancements',
        'entity_update_attributes',
        'entity_effect',
        'declare_recipes',
        'tags',
        'set_projectile_power',
        'custom_report_details',
        'server_links',
        'tracked_waypoint',
        'clear_dialog',
        'show_dialog'
    ];

    protocol.play.toClient.types.packet_game_rule_values = 'void';
    protocol.play.toClient.types.packet_low_disk_space_warning = 'void';
    setPacketMappings(protocol.play.toClient.types.packet, names);
}

function patchPlayServerbound(protocol) {
    const names = [
        'teleport_confirm',
        'attack',
        'query_block_nbt',
        'select_bundle_item',
        'set_difficulty',
        'change_gamemode',
        'message_acknowledgement',
        'chat_command',
        'chat_command_signed',
        'chat_message',
        'chat_session_update',
        'chunk_batch_received',
        'client_command',
        'tick_end',
        'settings',
        'tab_complete',
        'configuration_acknowledged',
        'enchant_item',
        'window_click',
        'close_window',
        'set_slot_state',
        'cookie_response',
        'custom_payload',
        'debug_subscription_request',
        'edit_book',
        'query_entity_nbt',
        'use_entity',
        'generate_structure',
        'keep_alive',
        'lock_difficulty',
        'position',
        'position_look',
        'look',
        'flying',
        'vehicle_move',
        'steer_boat',
        'pick_item_from_block',
        'pick_item_from_entity',
        'ping_request',
        'craft_recipe_request',
        'abilities',
        'block_dig',
        'entity_action',
        'player_input',
        'player_loaded',
        'pong',
        'recipe_book',
        'displayed_recipe',
        'name_item',
        'resource_pack_receive',
        'advancement_tab',
        'select_trade',
        'set_beacon_effect',
        'held_item_slot',
        'update_command_block',
        'update_command_block_minecart',
        'set_creative_slot',
        'set_game_rule',
        'update_jigsaw_block',
        'update_structure_block',
        'set_test_block',
        'update_sign',
        'spectate',
        'arm_animation',
        'teleport_to_entity',
        'test_instance_block_action',
        'block_place',
        'use_item',
        'custom_click_action'
    ];

    protocol.play.toServer.types.packet_attack = [
        'container',
        [{ name: 'entityId', type: 'varint' }]
    ];
    protocol.play.toServer.types.packet_set_game_rule = 'void';
    protocol.play.toServer.types.packet_teleport_to_entity =
        protocol.play.toServer.types.packet_spectate || rawPacket();
    setPacketMappings(protocol.play.toServer.types.packet, names);
}

function rawPacket() {
    return ['container', [{ name: 'data', type: 'restBuffer' }]];
}

function setPacketMappings(packetType, names) {
    const packetFields = packetType?.[1]?.[0]?.type?.[1];
    const switchFields = packetType?.[1]?.[1]?.type?.[1]?.fields;
    if (!packetFields?.mappings || !switchFields) {
        throw new Error('Unexpected minecraft-data protocol packet layout');
    }

    const mappings = {};
    for (let id = 0; id < names.length; id += 1) {
        mappings[`0x${id.toString(16).padStart(2, '0')}`] = names[id];
        switchFields[names[id]] = switchFields[names[id]] || `packet_${names[id]}`;
    }
    packetFields.mappings = mappings;
}

function add26_2VersionMetadata(minecraftData) {
    const metadata = {
        minecraftVersion: '26.2',
        version: 776,
        dataVersion: 4903,
        usesNetty: true,
        majorVersion: '26.2',
        releaseType: 'release'
    };

    minecraftData.versionsByMinecraftVersion = minecraftData.versionsByMinecraftVersion || {};
    minecraftData.versionsByMinecraftVersion.pc = {
        ...(minecraftData.versionsByMinecraftVersion.pc || {}),
        '26.2': metadata
    };

    minecraftData.versionsByProtocolVersion = minecraftData.versionsByProtocolVersion || {};
    minecraftData.versionsByProtocolVersion.pc = {
        ...(minecraftData.versionsByProtocolVersion.pc || {}),
        776: metadata
    };

    if (Array.isArray(minecraftData.versions?.pc) &&
        !minecraftData.versions.pc.some(version => version.minecraftVersion === '26.2')) {
        minecraftData.versions.pc.unshift(metadata);
    }
}

function createMineflayerVersionShim(originalVersionModule) {
    const testedVersions = append26_2(originalVersionModule.testedVersions || []);
    return {
        testedVersions,
        latestSupportedVersion: '26.2',
        oldestSupportedVersion: originalVersionModule.oldestSupportedVersion || testedVersions[0]
    };
}

function createProtocolVersionShim(originalVersionModule) {
    return {
        ...originalVersionModule,
        defaultVersion: originalVersionModule.defaultVersion === '1.21.11'
            ? '26.2'
            : originalVersionModule.defaultVersion,
        supportedVersions: append26_2(originalVersionModule.supportedVersions || [])
    };
}

function createMineflayerTimePluginShim() {
    return function inject(bot) {
        bot.time = {
            doDaylightCycle: null,
            bigTime: null,
            time: null,
            timeOfDay: null,
            day: null,
            isDay: null,
            moonPhase: null,
            bigAge: null,
            age: null
        };

        bot._client.on('update_time', (packet) => {
            const firstClock = Array.isArray(packet.clocks) ? packet.clocks[0] : null;
            const time = toBigInt(packet.time ?? firstClock?.time ?? 0);
            const age = toBigInt(packet.age ?? 0);
            const doDaylightCycle = packet.tickDayTime !== undefined
                ? !!packet.tickDayTime
                : (firstClock?.tickRate ?? 1) > 0;
            const finalTime = doDaylightCycle ? time : (time < 0n ? -time : time);

            bot.time.doDaylightCycle = doDaylightCycle;
            bot.time.bigTime = finalTime;
            bot.time.time = Number(finalTime);
            bot.time.timeOfDay = bot.time.time % 24000;
            bot.time.day = Math.floor(bot.time.time / 24000);
            bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000;
            bot.time.moonPhase = bot.time.day % 8;
            bot.time.bigAge = age;
            bot.time.age = Number(age);

            bot.emit('time');
        });
    };
}

function createChunkSection26_2Shim(OriginalChunkSection) {
    return class ChunkSection26_2 extends OriginalChunkSection {
        static read(smartBuffer, maxBitsPerBlock, noSizePrefix) {
            const solidBlockCount = smartBuffer.readInt16BE();
            smartBuffer.readInt16BE(); // 26.1+ fluid count, not used by prismarine-chunk yet.
            let firstRead = true;
            const reader = new Proxy(smartBuffer, {
                get(target, prop) {
                    if (prop === 'readInt16BE') {
                        return function readInt16BE() {
                            if (firstRead) {
                                firstRead = false;
                                return solidBlockCount;
                            }
                            return target.readInt16BE.call(target);
                        };
                    }

                    const value = target[prop];
                    return typeof value === 'function' ? value.bind(target) : value;
                }
            });

            return OriginalChunkSection.read(reader, maxBitsPerBlock, noSizePrefix);
        }
    };
}

function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(Math.trunc(value));
    if (Array.isArray(value)) {
        return BigInt.asIntN(64, (BigInt(value[0]) << 32n)) | BigInt(value[1]);
    }
    return BigInt(value || 0);
}

function append26_2(versions) {
    return versions.includes('26.2') ? versions : [...versions, '26.2'];
}

function copyProperties(source, target) {
    for (const key of Reflect.ownKeys(source)) {
        if (['length', 'name', 'prototype'].includes(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(source, key);
        if (descriptor) Object.defineProperty(target, key, descriptor);
    }
}

module.exports = {
    SLOT_COMPONENTS_26_2
};
