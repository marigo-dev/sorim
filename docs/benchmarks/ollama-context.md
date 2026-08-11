# Ollama Context Benchmark

Test host: NVIDIA GeForce RTX 5060 with 8 GB VRAM  
Model: `qwen3.5:9b`  
Samples: three warm calls per workload

| Context | Chat | Intent | Tool call | Quality | Ollama placement |
| --- | ---: | ---: | ---: | --- | --- |
| 4096 | 770 ms | 1094 ms | 861 ms | 3/3 for every workload | 100% GPU, 5.5 GB |
| 8192 | 900 ms | 1372 ms | 962 ms | chat 3/3, intent 3/3, tool 1/3 | 12% CPU / 88% GPU, 6.3 GB |

For this hardware and the current compact prompts, `4096` is the default. It
keeps the model fully on the GPU, was faster in all three workloads, and did not
lose quality in this sample. The benchmark is deliberately small and should be
rerun when colony summaries or character memories make prompts substantially
larger.

Run it again with:

```powershell
$env:BENCHMARK_SAMPLES='3'
npm run benchmark:ollama
```

The machine-readable report is stored in `ollama-context.json` beside this file.
