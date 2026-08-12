function detectClarificationNeed(message, username, originalMessage = message) {
    const text = fold(message);
    if (/\b(savas|saldir|oldur|fight|attack|kill)\b/.test(text)) {
        return {
            type: 'clarify',
            kind: 'combat_target',
            username,
            originalMessage,
            reply: 'Kime veya hangi yaratiga saldirmami istiyorsun?'
        };
    }
    if (/\b(topla|collect|gather)\b/.test(text) && hasAmbiguousObject(text)) {
        return {
            type: 'clarify',
            kind: 'resource_target',
            username,
            originalMessage,
            reply: 'Hangi kaynagi ve ne kadar toplamami istiyorsun?'
        };
    }
    if (/\b(yap|kur|build|insa)\b/.test(text) && hasAmbiguousObject(text)) {
        return {
            type: 'clarify',
            kind: 'build_target',
            username,
            originalMessage,
            reply: 'Tam olarak ne yapmami veya kurmami istiyorsun?'
        };
    }
    return null;
}

function resolveClarificationMessage(clarification, reply, botName = 'marigo') {
    const answer = fold(reply)
        .replace(new RegExp(escapeRegExp(fold(botName)), 'g'), '')
        .replace(/\bmarigo\b/g, '')
        .trim();
    if (isCancellation(answer)) return answer;
    if (clarification?.kind === 'combat_target') return `${answer} oldur`;
    if (clarification?.kind === 'resource_target') return `${answer} topla`;
    if (clarification?.kind === 'build_target') return `${answer} yap`;
    return `${clarification?.originalMessage || ''}; cevap: ${answer}`;
}

function hasAmbiguousObject(text) {
    return /\b(bir sey|birsey|sunu|onu|bunu|something|anything|it)\b/.test(text);
}

function isCancellation(text) {
    return /^(dur|bekle|stop|wait|iptal|cancel|hayir|bos ver|never mind)$/.test(text.trim());
}

function fold(value) {
    return String(value || '').toLocaleLowerCase('tr-TR')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/ı/g, 'i');
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { detectClarificationNeed, resolveClarificationMessage, isCancellation };
