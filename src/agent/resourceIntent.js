const NUMBER_WORDS = new Map([
    ['bir', 1], ['iki', 2], ['uc', 3], ['dort', 4], ['bes', 5],
    ['alti', 6], ['yedi', 7], ['sekiz', 8], ['dokuz', 9], ['on', 10],
    ['on alti', 16], ['yirmi', 20], ['otuz iki', 32],
    ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
    ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
    ['sixteen', 16], ['twenty', 20], ['thirty two', 32]
]);

function parseResourceIntent(message) {
    const text = fold(message);
    if (!/\b(topla|kes|kaz|collect|gather|chop|cut|mine)\b/.test(text)) return null;

    const count = extractCount(text);
    if (/\b(odun|agac|kutuk|wood|logs?|trees?)\b/.test(text)) {
        return { resource: 'wood', tool: 'mine_block', target: 'any_log', count: count || 1 };
    }
    if (/\b(tas|kaya|stone|cobblestone)\b/.test(text)) {
        return { resource: 'stone', tool: 'collect_stone', count: count || 16 };
    }
    return null;
}

function extractCount(text) {
    const numeric = text.match(/\b(\d{1,3})\b/);
    if (numeric) return clampCount(Number(numeric[1]));
    for (const [word, value] of [...NUMBER_WORDS.entries()].sort((a, b) => b[0].length - a[0].length)) {
        if (new RegExp(`\\b${word.replace(/ /g, '\\s+')}\\b`).test(text)) return value;
    }
    return null;
}

function clampCount(value) {
    return Math.max(1, Math.min(64, Math.floor(Number(value) || 1)));
}

function fold(value) {
    return String(value || '').toLocaleLowerCase('tr-TR')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i');
}

module.exports = { parseResourceIntent, extractCount, clampCount };
