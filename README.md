# MarigoBot

Mineflayer tabanli, skill-tree/state-machine mantigiyla ilerleyen otonom Minecraft botu.

## Kurulum

```bash
npm install
```

## Calistirma

```bash
npm start
```

Varsayilan ayarlar:

- `MC_HOST=localhost`
- `MC_PORT=25565`
- `MC_VERSION=1.21`
- `MC_USERNAME=marigo`
- `USE_LLM=true`
- `OLLAMA_MODEL=qwen3:4b`

LLM kullanmadan deterministik skill tree ile test etmek icin:

```bash
USE_LLM=false npm start
```

Windows PowerShell:

```powershell
$env:USE_LLM='false'; npm start
```

## Log Seviyesi

Varsayilan log seviyesi `info` olarak ayarlandi. Bu seviyede sadece onemli olaylar ve hatalar gorunur.

Ayrintili kazma, craft, hareket ve state loglari icin:

```bash
LOG_LEVEL=debug npm start
```

PowerShell:

```powershell
$env:LOG_LEVEL='debug'; npm start
```

## Test

```bash
npm test
```

## Notlar

- `mc-server/`, `data/`, `node_modules/` ve test loglari GitHub'a dahil edilmez.
- Eski deneysel ajan kodu `legacy-old-agent/` altinda tutulabilir.
