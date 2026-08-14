const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');

process.env.MC_VERSION = '26.2';
process.env.ENABLE_EXPERIMENTAL_26_2 = 'true';

const {
    createLpVec3262Codec,
    SLOT_COMPONENTS_26_2,
    createMineflayerTimePluginShim,
    install26_2PacketFallbacks,
    install26_2VelocityShim
} = require('../src/protocol26Shim');
const minecraftData = require('minecraft-data');
const minecraftProtocol = require('minecraft-protocol');

const data = minecraftData('26.2');
assert.strictEqual(
    data.itemsArray.find(item => item.id === data.itemsByName.birch_log.id)?.name,
    'birch_log',
    '26.2 itemsArray must use the same remapped ids as itemsByName'
);
const componentMappings = data.protocol.types.SlotComponentType[1].mappings;

assert.equal(data.version.version, 776);
assert.equal(data.version.dataVersion, 4903);
assert.equal(data.supportFeature('attackUsesOwnPacket'), true);
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

const serverboundSerializer = minecraftProtocol.createSerializer({
    state: 'play',
    isServer: false,
    version: '26.2'
});
const serverboundDeserializer = minecraftProtocol.createDeserializer({
    state: 'play',
    isServer: true,
    version: '26.2',
    noErrorLogging: true
});
const attackPacket = serverboundSerializer.createPacketBuffer({
    name: 'attack',
    params: { entityId: 42 }
});
const decodedAttack = serverboundDeserializer.proto.parsePacketBuffer('packet', attackPacket);
assert.equal(attackPacket[0], 1);
assert.deepEqual(decodedAttack.data, {
    name: 'attack',
    params: { entityId: 42 }
});

console.log('26.2 protocol shim inventory codec passed.');

const fakeClient = new EventEmitter();
const fakeBot = { _client: fakeClient, emit() {} };
createMineflayerTimePluginShim()(fakeBot);
fakeClient.emit('update_time', {
    age: 100n,
    clocks: [{ clockId: 0, time: 37000, partialTick: 0, tickRate: 1 }]
});
assert.equal(fakeBot.time.timeOfDay, 13000);
assert.equal(fakeBot.time.isDay, false);
fakeClient.emit('update_time', { age: 101n, clocks: [] });
assert.equal(fakeBot.time.timeOfDay, 13001);
assert.equal(fakeBot.time.age, 101);

console.log('26.2 incremental world clock handling passed.');

const [readLpVec3, writeLpVec3] = createLpVec3262Codec();
const lpBuffer = Buffer.alloc(16);
const lpEnd = writeLpVec3({ x: 0.42, y: 0.4, z: -0.18 }, lpBuffer, 0);
assert.equal(
    lpBuffer.subarray(0, lpEnd).toString('hex'),
    '01d768f56662',
    'LpVec3 high 32 bits must use the big-endian order used by the 26.2 server'
);
const decodedLp = readLpVec3(lpBuffer, 0).value;
assert.ok(Math.abs(decodedLp.x - 0.42) < 0.0001);
assert.ok(Math.abs(decodedLp.y - 0.4) < 0.0001);
assert.ok(Math.abs(decodedLp.z + 0.18) < 0.0001);

console.log('26.2 big-endian lpVec3 codec passed.');

const velocityClient = new EventEmitter();
const velocityBot = new EventEmitter();
velocityBot.version = '26.2';
velocityBot._client = velocityClient;
velocityBot.entity = { id: 17, velocity: new Vec3(0, 0, 0) };
velocityBot.entities = { 17: velocityBot.entity };
velocityClient.on('entity_velocity', velocityPacket => {
    velocityBot.entity.velocity.set(
        velocityPacket.velocity.x / 8000,
        velocityPacket.velocity.y / 8000,
        velocityPacket.velocity.z / 8000
    );
});
let restoredVelocity = null;
velocityBot.on('sorimVelocity', event => { restoredVelocity = event.velocity; });
assert.equal(install26_2VelocityShim(velocityBot), true);
velocityClient.emit('entity_velocity', {
    entityId: 17,
    velocity: { x: 0.42, y: 0.4, z: -0.18 }
});
assert.deepEqual(velocityBot.entity.velocity, new Vec3(0.42, 0.4, -0.18));
assert.deepEqual(restoredVelocity, { x: 0.42, y: 0.4, z: -0.18 });
assert.equal(install26_2VelocityShim(velocityBot), false, 'velocity shim must only install once');

console.log('26.2 lpVec3 knockback scaling passed.');

const fallbackClient = new EventEmitter();
let writtenMovement = null;
const writes = [];
fallbackClient.write = (name, packet) => {
    writes.push({ name, packet });
    writtenMovement = { name, packet };
};
const fallbackBot = new EventEmitter();
Object.assign(fallbackBot, {
    version: '26.2',
    entity: { isCollidedHorizontally: true },
    controlState: {
        forward: false, back: false, left: false, right: false,
        jump: false, sneak: false, sprint: false
    },
    setControlState(control, state) { this.controlState[control] = state; },
    clearControlStates() {
        for (const key of Object.keys(this.controlState)) this.controlState[key] = false;
    },
    _client: fallbackClient
});
let metadata = null;
fallbackClient.on('entity_metadata', packet => { metadata = packet.metadata; });
assert.equal(install26_2PacketFallbacks(fallbackBot), true);
fallbackBot.emit('spawn');
assert.deepEqual(writes.at(-1), { name: 'player_loaded', packet: {} });
fallbackClient.write('position', {
    x: 1,
    y: 2,
    z: 3,
    flags: { onGround: false, hasHorizontalCollision: undefined }
});
assert.deepEqual(writtenMovement, {
    name: 'position',
    packet: {
        x: 1,
        y: 2,
        z: 3,
        flags: { onGround: false, hasHorizontalCollision: true }
    }
});
fallbackBot.setControlState('forward', true);
fallbackBot.setControlState('jump', true);
assert.deepEqual(writes.at(-1), {
    name: 'player_input',
    packet: {
        inputs: {
            forward: true,
            backward: false,
            left: false,
            right: false,
            jump: true,
            shift: false,
            sprint: false
        }
    }
});
fallbackClient.write('block_place', { hand: 0, sequence: 0 });
fallbackClient.write('block_place', { hand: 0, sequence: 0 });
assert.equal(writes.at(-2).packet.sequence, 0);
assert.equal(writes.at(-1).packet.sequence, 1);
fallbackClient.emit('entity_metadata', { entityId: 3, metadata: { unsupported: true } });
assert.deepEqual(metadata, []);
assert.equal(
    fallbackClient.emit('world_particles', { particle: { type: 'unknown' } }),
    false
);
assert.equal(install26_2PacketFallbacks(fallbackBot), false);

console.log('26.2 shared packet fallbacks passed.');
