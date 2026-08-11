const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const axios = require('axios');

const MODEL = process.env.OLLAMA_MODEL || 'qwen3.5:9b';
const URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434/api/chat';
const CONTEXTS = String(process.env.BENCHMARK_CONTEXTS || '4096,8192')
    .split(',')
    .map(Number)
    .filter(Number.isFinite);
const SAMPLES = Math.max(1, Number(process.env.BENCHMARK_SAMPLES || 2));
const OUTPUT = process.env.BENCHMARK_OUTPUT || path.join(
    __dirname,
    '..',
    'docs',
    'benchmarks',
    'ollama-context.json'
);

const toolDefinition = {
    type: 'function',
    function: {
        name: 'mine_block',
        description: 'Mine a block by name.',
        parameters: {
            type: 'object',
            properties: { target: { type: 'string' } },
            required: ['target']
        }
    }
};

const workloads = [
    {
        id: 'chat',
        request: {
            messages: [
                { role: 'system', content: 'You are Mico, a concise friendly Minecraft citizen. Return JSON with only a reply field.' },
                { role: 'user', content: 'Merhaba Mico, bugün nasılsın?' }
            ],
            format: {
                type: 'object',
                properties: { reply: { type: 'string' } },
                required: ['reply']
            },
            options: { temperature: 0.2, num_predict: 80 }
        },
        quality(response) {
            const value = parseJson(response.data?.message?.content);
            return Boolean(value?.reply && value.reply.length <= 220);
        }
    },
    {
        id: 'intent',
        request: {
            messages: [{
                role: 'user',
                content: [
                    'Return JSON only. Convert this Minecraft request into ordered steps:',
                    '"16 odun topla, base kur, eve dön ve sandığa bırak".',
                    'Allowed tools: mine_block(target), ensure_base(), return_base(), organize_storage().',
                    'Schema: {"intent":"create_goal","steps":[{"tool":"...","args":{}}]}'
                ].join('\n')
            }],
            format: {
                type: 'object',
                properties: {
                    intent: { type: 'string' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: { tool: { type: 'string' }, args: { type: 'object' } },
                            required: ['tool']
                        }
                    }
                },
                required: ['intent', 'steps']
            },
            options: { temperature: 0.1, num_predict: 260 }
        },
        quality(response) {
            const value = parseJson(response.data?.message?.content);
            const names = value?.steps?.map(step => step.tool) || [];
            return value?.intent === 'create_goal' &&
                names.includes('mine_block') && names.includes('ensure_base') &&
                names.includes('return_base') && names.includes('organize_storage') &&
                names.indexOf('mine_block') < names.indexOf('ensure_base');
        }
    },
    {
        id: 'tool_call',
        request: {
            messages: [
                { role: 'system', content: 'Control a Minecraft body using exactly one supplied tool.' },
                { role: 'user', content: 'Collect a natural tree log now.' }
            ],
            tools: [toolDefinition],
            options: { temperature: 0.1, num_predict: 100 }
        },
        quality(response) {
            const call = response.data?.message?.tool_calls?.[0]?.function;
            const target = call?.arguments?.target;
            return call?.name === 'mine_block' &&
                (target === 'any_log' || String(target || '').endsWith('_log'));
        }
    }
];

async function main() {
    const report = {
        generatedAt: new Date().toISOString(),
        model: MODEL,
        url: URL,
        samplesPerWorkload: SAMPLES,
        host: hostMetrics(),
        contexts: []
    };

    for (const contextSize of CONTEXTS) {
        stopModel();
        await sleep(1200);
        const warmupMs = await invoke({
            messages: [{ role: 'user', content: 'Reply with JSON: {"ready":true}' }],
            format: {
                type: 'object',
                properties: { ready: { type: 'boolean' } },
                required: ['ready']
            },
            options: { temperature: 0, num_predict: 20 }
        }, contextSize).then(result => result.elapsedMs);

        const contextResult = { contextSize, warmupMs, workloads: [] };
        for (const workload of workloads) {
            const samples = [];
            for (let index = 0; index < SAMPLES; index++) {
                const result = await invoke(workload.request, contextSize);
                samples.push({
                    elapsedMs: result.elapsedMs,
                    qualityPass: workload.quality(result.response),
                    evalTokens: result.response.data?.eval_count || null,
                    evalDurationNs: result.response.data?.eval_duration || null
                });
            }
            contextResult.workloads.push({
                id: workload.id,
                averageMs: rounded(samples.reduce((sum, sample) => sum + sample.elapsedMs, 0) / samples.length),
                qualityPassRate: rounded(samples.filter(sample => sample.qualityPass).length / samples.length),
                samples
            });
        }
        contextResult.placement = placementMetrics();
        report.contexts.push(contextResult);
        console.log(`[BENCHMARK] context=${contextSize} ${JSON.stringify(contextResult)}`);
    }

    fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
    fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[BENCHMARK] report=${OUTPUT}`);
}

async function invoke(request, contextSize) {
    const startedAt = process.hrtime.bigint();
    const response = await axios.post(URL, {
        model: MODEL,
        stream: false,
        think: false,
        keep_alive: '30m',
        ...request,
        options: { ...request.options, num_ctx: contextSize }
    }, { timeout: Number(process.env.BENCHMARK_TIMEOUT_MS || 120000) });
    const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return { elapsedMs: rounded(elapsedMs), response };
}

function placementMetrics() {
    return {
        ollamaPs: command('ollama', ['ps']),
        gpu: command('nvidia-smi', [
            '--query-gpu=name,memory.total,memory.used,memory.free,utilization.gpu',
            '--format=csv,noheader,nounits'
        ])
    };
}

function hostMetrics() {
    return {
        gpu: command('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'])
    };
}

function stopModel() {
    command('ollama', ['stop', MODEL]);
}

function command(program, args) {
    try {
        return execFileSync(program, args, { encoding: 'utf8', timeout: 15000 }).trim();
    } catch (error) {
        return `unavailable: ${error.message}`;
    }
}

function parseJson(value) {
    try {
        return JSON.parse(String(value || '').trim());
    } catch {
        return null;
    }
}

function rounded(value) {
    return Number(Number(value).toFixed(2));
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
    console.error('[BENCHMARK_ERROR]', error.response?.data || error.message);
    process.exitCode = 1;
});
