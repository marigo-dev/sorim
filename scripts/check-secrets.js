const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const trackedFiles = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8'
}).split('\0').filter(Boolean);

const forbiddenNames = [
    /(^|\/)\.env(?:\..+)?$/i,
    /(^|\/)(?:keys?|credentials?|secrets?|tokens?)\.json$/i,
    /\.(?:pem|p12|pfx|jks|keystore|key)$/i
];
const allowedNames = new Set(['.env.example']);
const secretPatterns = [
    { name: 'API key', pattern: /\bsk-[A-Za-z0-9_-]{24,}\b/g },
    { name: 'GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g },
    { name: 'AWS access key', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
    { name: 'private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g }
];
const findings = [];
let checkedFiles = 0;

for (const relativePath of trackedFiles) {
    const normalized = relativePath.replaceAll('\\', '/');
    if (!allowedNames.has(normalized) && forbiddenNames.some(pattern => pattern.test(normalized))) {
        findings.push(`${normalized}: sensitive filename is tracked`);
        continue;
    }

    const absolutePath = path.join(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    checkedFiles++;
    const buffer = fs.readFileSync(absolutePath);
    if (buffer.includes(0)) continue;
    const content = buffer.toString('utf8');
    for (const candidate of secretPatterns) {
        candidate.pattern.lastIndex = 0;
        const match = candidate.pattern.exec(content);
        if (!match) continue;
        const line = content.slice(0, match.index).split(/\r?\n/).length;
        findings.push(`${normalized}:${line}: possible ${candidate.name}`);
    }
}

if (findings.length > 0) {
    console.error('[SECRET_CHECK] Refusing to continue:');
    for (const finding of findings) console.error(`- ${finding}`);
    process.exit(1);
}

console.log(`[SECRET_CHECK] ${checkedFiles} tracked files are clean.`);
