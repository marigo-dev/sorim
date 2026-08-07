const assert = require('node:assert/strict');

process.env.MC_VERSION = '26.2';
process.env.ENABLE_EXPERIMENTAL_26_2 = 'true';

const { SLOT_COMPONENTS_26_2 } = require('../protocol26Shim');
const minecraftData = require('minecraft-data');
const minecraftProtocol = require('minecraft-protocol');

const data = minecraftData('26.2');
const componentMappings = data.protocol.types.SlotComponentType[1].mappings;

assert.equal(data.version.version, 776);
assert.equal(data.version.dataVersion, 4903);
assert.equal(data.entitiesByName.zombie.id, 151);
assert.equal(data.entities[151].name, 'zombie');
assert.equal(Object.keys(componentMappings).length, 111);
assert.equal(componentMappings['41'], 'additional_trade_cost');
assert.equal(componentMappings['42'], 'stored_enchantments');
assert.equal(componentMappings['43'], 'dye');
assert.equal(componentMappings['78'], 'sulfur_cube_content');
assert.equal(componentMappings['110'], 'shulker/color');
assert.deepEqual(Object.values(componentMappings), SLOT_COMPONENTS_26_2);

const serializer = minecraftProtocol.createSerializer({
    state: 'play',
    isServer: true,
    version: '26.2'
});
const deserializer = minecraftProtocol.createDeserializer({
    state: 'play',
    isServer: false,
    version: '26.2',
    noErrorLogging: true
});

const packet = {
    name: 'set_player_inventory',
    params: {
        slotId: 9,
        contents: {
            itemCount: 1,
            itemId: data.itemsByName.stone_pickaxe.id,
            addedComponentCount: 3,
            removedComponentCount: 0,
            components: [
                { type: 'damage', data: 5 },
                { type: 'additional_trade_cost', data: 2 },
                { type: 'dye', data: 3 }
            ],
            removeComponents: []
        }
    }
};

const encoded = serializer.createPacketBuffer(packet);
const decoded = deserializer.proto.parsePacketBuffer('packet', encoded);

assert.equal(encoded[0], 108);
assert.equal(decoded.metadata.size, encoded.length);
assert.deepEqual(decoded.data, packet);

console.log('26.2 protocol shim inventory codec passed.');
