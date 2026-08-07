const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marigo-memory-'));
const modulePath = require.resolve('../skills/memory');

try {
    let memory = require(modulePath);
    memory.initialize('test-bot', { directory });
    memory.setBase({ x: 10.9, y: 64.2, z: -4.1 });
    memory.setSurfaceExit({ x: 3, y: 71, z: 8 });
    memory.setMineRoute([
        { x: 3, y: 71, z: 8 },
        { x: 4, y: 70, z: 8 },
        { x: 4, y: 70, z: 8 }
    ]);
    memory.appendMineRoute({ x: 5, y: 69, z: 8 });
    memory.rememberPlacedBlock('crafting_table');
    memory.setProgress('maxIronPotential', 17);
    memory.flush();

    delete require.cache[modulePath];
    memory = require(modulePath);
    memory.initialize('test-bot', { directory });

    assert.deepEqual(memory.getBase(), { x: 10, y: 64, z: -5 });
    assert.deepEqual(memory.getSurfaceExit(), { x: 3, y: 71, z: 8 });
    assert.deepEqual(memory.getMineRoute(), [
        { x: 3, y: 71, z: 8 },
        { x: 4, y: 70, z: 8 },
        { x: 5, y: 69, z: 8 }
    ]);
    assert.equal(memory.hasPlacedBlock('crafting_table'), true);
    assert.equal(memory.hasPlacedBlock('furnace'), false);
    assert.equal(memory.getProgress('maxIronPotential'), 17);
    memory.clearSurfaceExit();
    memory.clearMineRoute();
    memory.flush();
    assert.equal(memory.getSurfaceExit(), null);
    assert.deepEqual(memory.getMineRoute(), []);
    console.log('Persistent bot memory passed.');
} finally {
    fs.rmSync(directory, { recursive: true, force: true });
}
