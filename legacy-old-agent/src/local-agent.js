const axios = require('axios');

class LocalAgent {
    constructor(config) {
        this.config = config;
    }

    async selectGoal(observation, memory, candidates) {
        const prompt = `
Sen Minecraft icinde kendi hedeflerini secen yerel bir ajansin.
Dusuk seviyeli hareket komutu verme. Bir sonraki anlamli ve ulasilabilir hedefi sec.

Kullanabilecegin hedef turleri:
{"type":"acquire_item","item":"minecraft_item_name","count":1,"reason":"kisa neden"}
{"type":"explore","reason":"kisa neden"}

Ilkeler:
- Oncelikle izin verilen aday hedeflerden birini sec.
- Aday listesinde acquire_item varsa explore secme.
- Ayni kaynagi amacsizca biriktirme.
- Mevcut envanterden biraz daha zor ama gercekci bir hedef sec.
- Arac gelisimini, acligi, guvenligi ve yeni kaynaklara erisimi dusun.
- Daha once tamamlanan hedefi gereksiz yere tekrarlama.
- Item adi Minecraft registry adiyla yazilmali.
- Yalnizca tek JSON nesnesi dondur.

Durum:
- Can: ${observation.health}/20
- Aclik: ${observation.food}/20
- Konum: ${JSON.stringify(observation.position)}
- Envanter: ${observation.inventory.text}
- Yakin bloklar: ${observation.nearbyBlocks.slice(0, 30).map(block => block.name).join(', ') || 'Yok'}
- Tehditler: ${observation.hostileMobs.map(mob => mob.name).join(', ') || 'Yok'}
- Tamamlanan hedefler: ${memory.completed.slice(-12).join(', ') || 'Yok'}
- Son basarisizliklar: ${memory.failures.slice(-8).join(', ') || 'Yok'}
- Izin verilen aday hedefler: ${JSON.stringify(candidates)}
`;

        const response = await axios.post(this.config.url, {
            model: this.config.model,
            prompt,
            stream: false,
            think: false,
            format: 'json',
            keep_alive: this.config.keepAlive,
            options: {
                temperature: 0,
                num_ctx: this.config.contextSize,
                num_predict: 100
            }
        }, {
            timeout: this.config.timeoutMs
        });

        const parsed = this.parseJsonObject(response.data.response);
        if (!parsed) {
            console.log(
                'Ollama JSON disi hedef cevabi verdi:',
                String(response.data.response || '').slice(0, 160)
            );
            return candidates[0] || null;
        }
        return parsed;
    }

    async chat(username, message, observation = null) {
        const context = observation
           ? `Canın ${observation.health}/20, açlığın ${observation.food}/20.`
            : '';
        const prompt = `Sen Marigo'sun. Minecraft'ta yaşayan, Türkçe konuşan, kısa (max 12 kelime), esprili yardımcısın. ${context} Oyuncu ${username}: "${message}". Sadece sohbet et.`;
        const response = await axios.post(this.config.url, {
            model: this.config.model,
            prompt,
            stream: false,
            think: false,
            keep_alive: this.config.keepAlive,
            options: {
                temperature: 0.7,
                num_ctx: this.config.contextSize,
                num_predict: 60
            }
        }, {
            timeout: 15000
        });

        return response.data.response.trim().replace(/\n/g, ' ').slice(0, 90);
    }

    parseJsonObject(text) {
        if (!text || typeof text!== 'string') return null;

        try {
            return JSON.parse(text);
        } catch {
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start === -1 || end <= start) return null;

            try {
                return JSON.parse(text.slice(start, end + 1));
            } catch {
                return null;
            }
        }
    }
}

module.exports = LocalAgent;
