const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SOURCE_DIRS = ['src', 'scripts'];

function javascriptFiles(directory) {
    return fs.readdirSync(directory, { withFileTypes: true })
        .flatMap(entry => {
            const target = path.join(directory, entry.name);
            if (entry.isDirectory()) return javascriptFiles(target);
            return entry.isFile() && entry.name.endsWith('.js') ? [target] : [];
        });
}

const files = SOURCE_DIRS
    .flatMap(directory => javascriptFiles(path.join(ROOT, directory)))
    .sort();

for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
        encoding: 'utf8'
    });
    if (result.status !== 0) {
        process.stderr.write(result.stderr || result.stdout);
        process.exit(result.status || 1);
    }
}

console.log(`Syntax check passed for ${files.length} JavaScript files.`);
