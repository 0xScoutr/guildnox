import { Readable } from "node:stream";
import { jobPool, pool } from "./db.js";
import { isOfficer } from "./guilds.js";

/**
 * Bot que entra no canal de voz da guilda e avisa o boss falando.
 *
 * Usa os mesmos horários dos outros avisos (activity-notify.js): 5 min antes,
 * na abertura, 10 min depois e na reabertura. A fala vem de um serviço de voz
 * (Google Text-to-Speech por padrão, ou OpenAI). O bot só entra se tiver gente
 * no canal, fala e sai.
 *
 * Liga com DISCORD_BOT_TOKEN e a chave do serviço de voz. Sem isso, nada muda.
 * Cada guilda escolhe o canal de voz em Gerenciar guildas > Discord.
 */

const ROLE_OR_CHANNEL_RE = /^\d{17,20}$/;
const TTS_TIMEOUT_MS = 15_000;
const READY_TIMEOUT_MS = 20_000;
const PLAY_TIMEOUT_MS = 60_000;
const CACHE_MAX = 20;
const TEST_COOLDOWN_MS = 15_000;
const OUT_RATE = 48_000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function ttsProvider() {
  return (process.env.TTS_PROVIDER || "google").trim().toLowerCase();
}

function ttsConfigured() {
  if (ttsProvider() === "openai") return Boolean(process.env.OPENAI_API_KEY);
  return Boolean(process.env.GOOGLE_TTS_API_KEY);
}

let client = null;
let ready = false;
let voiceLib = null;
let discordLib = null;
let loginAttempts = 0;
let reloginTimer = null;

export function voiceEnabled() {
  return ready && ttsConfigured();
}

/** Estado para a tela de oficiais (sem segredo nenhum). */
export function voiceStatus() {
  return {
    bot: Boolean(process.env.DISCORD_BOT_TOKEN),
    online: ready,
    tts: ttsConfigured(),
  };
}

function scheduleRelogin(reason) {
  const delay = Math.min(10 * 60_000, 30_000 * 2 ** loginAttempts);
  loginAttempts += 1;
  console.error(`bot de voz: desconectado (${reason}); tentando de novo em ${Math.round(delay / 1000)} s`);
  clearTimeout(reloginTimer);
  reloginTimer = setTimeout(async () => {
    // Cliente novo: depois de um fechamento definitivo o gerenciador de conexão do
    // discord.js fica marcado como destruído e um novo login nele nunca fica pronto.
    const old = client;
    client = buildClient();
    try { await old?.destroy(); } catch { /* já estava fechado */ }
    connect();
  }, delay);
}

async function connect() {
  try {
    await client.login(process.env.DISCORD_BOT_TOKEN);
  } catch (error) {
    ready = false;
    if (error?.code === "TokenInvalid") {
      console.error("bot de voz: o Discord recusou o token; confira DISCORD_BOT_TOKEN.");
      return;
    }
    scheduleRelogin(error.message);
  }
}

export async function startVoiceBot() {
  if (!process.env.DISCORD_BOT_TOKEN) {
    console.log("bot de voz desligado: defina DISCORD_BOT_TOKEN para ligar.");
    return;
  }
  if (!ttsConfigured()) {
    console.log("bot de voz desligado: falta a chave do serviço de voz (GOOGLE_TTS_API_KEY ou OPENAI_API_KEY).");
    return;
  }
  try {
    discordLib = await import("discord.js");
    voiceLib = await import("@discordjs/voice");
  } catch (error) {
    console.error(`bot de voz: não deu para carregar as bibliotecas: ${error.message}`);
    return;
  }
  client = buildClient();
  connect();
}

function buildClient() {
  const { Client, GatewayIntentBits } = discordLib;
  const next = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  next.on("clientReady", () => {
    if (next !== client) return;
    ready = true;
    loginAttempts = 0;
    console.log(`bot de voz online como ${next.user?.tag}`);
  });
  next.on("error", (error) => console.error(`bot de voz: ${error.message}`));
  next.on("shardResume", () => { if (next === client) ready = true; });
  // Na 14.x este evento só sai quando o Discord fecha de vez (não reconecta sozinho).
  next.on("shardDisconnect", (event) => {
    if (next !== client) return;
    ready = false;
    if (event?.code === 4004) {
      console.error("bot de voz: o Discord recusou o token; confira DISCORD_BOT_TOKEN.");
      return;
    }
    scheduleRelogin(`código ${event?.code ?? "?"}`);
  });
  return next;
}

// ---------- Fala ----------

/** WAV PCM 16 bits (o LINEAR16 do Google vem com cabeçalho WAV). */
export function parseWav(buffer) {
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("áudio do serviço de voz não é WAV");
  }
  let offset = 12;
  let format = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bits: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (!format || format.audioFormat !== 1 || format.bits !== 16) {
        throw new Error("WAV fora do formato PCM 16 bits");
      }
      const end = Math.min(buffer.length, start + size);
      return { pcm: buffer.subarray(start, end), sampleRate: format.sampleRate, channels: format.channels };
    }
    offset = start + size + (size % 2);
  }
  throw new Error("WAV sem dados de áudio");
}

/**
 * Converte PCM 16 bits (mono ou estéreo, qualquer taxa) para o que o Discord
 * toca: 48 kHz, estéreo. Põe 250 ms de silêncio no começo para a conexão
 * firmar antes da primeira palavra.
 */
export function toDiscordPcm(pcm, sampleRate, channels = 1) {
  const frames = Math.floor(pcm.length / (2 * channels));
  const mono = new Float64Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += pcm.readInt16LE((i * channels + c) * 2);
    mono[i] = sum / channels;
  }
  const outFrames = Math.floor((frames * OUT_RATE) / sampleRate);
  const lead = Math.round(OUT_RATE * 0.25);
  const out = Buffer.alloc((lead + outFrames) * 4);
  const ratio = sampleRate / OUT_RATE;
  for (let i = 0; i < outFrames; i += 1) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(frames - 1, i0 + 1);
    const frac = pos - i0;
    const value = Math.max(-32768, Math.min(32767, Math.round(mono[i0] * (1 - frac) + mono[i1] * frac)));
    const at = (lead + i) * 4;
    out.writeInt16LE(value, at);
    out.writeInt16LE(value, at + 2);
  }
  return out;
}

async function synthesizeGoogle(text) {
  const voice = { languageCode: "pt-BR" };
  if (process.env.TTS_VOICE) voice.name = process.env.TTS_VOICE.trim();
  const response = await fetch("https://texttospeech.googleapis.com/v1/text:synthesize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_TTS_API_KEY,
    },
    body: JSON.stringify({
      input: { text },
      voice,
      audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: OUT_RATE },
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Google Text-to-Speech respondeu ${response.status}`);
  const data = await response.json();
  if (!data.audioContent) throw new Error("Google Text-to-Speech não devolveu áudio");
  const wav = parseWav(Buffer.from(data.audioContent, "base64"));
  return toDiscordPcm(wav.pcm, wav.sampleRate, wav.channels);
}

async function synthesizeOpenAI(text) {
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: process.env.TTS_VOICE || "onyx",
      input: text,
      instructions: "Fale em português do Brasil, com energia, como quem chama a guilda para um boss.",
      response_format: "pcm",
    }),
    redirect: "error",
    signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`OpenAI respondeu ${response.status}`);
  // "pcm" da OpenAI: 24 kHz, 16 bits, mono, sem cabeçalho.
  return toDiscordPcm(Buffer.from(await response.arrayBuffer()), 24_000, 1);
}

const cache = new Map();

/** Fala pronta para o Discord. Guarda as últimas frases (o nome do boss se repete). */
export async function synthesize(text) {
  const key = `${ttsProvider()}|${process.env.TTS_VOICE || ""}|${text}`;
  if (cache.has(key)) {
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const pcm = ttsProvider() === "openai" ? await synthesizeOpenAI(text) : await synthesizeGoogle(text);
  cache.set(key, pcm);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return pcm;
}

function minutes(n) {
  return n === 1 ? "1 minuto" : `${n} minutos`;
}

function minutesUntil(date) {
  return Math.max(1, Math.round((new Date(date).getTime() - Date.now()) / 60_000));
}

/** O que o bot fala em cada aviso. */
export function speechFor(kind, activity) {
  const boss = String(activity.name || "Atividade").trim();
  if (kind === "soon") return `Atenção, guilda! ${boss} começa em ${minutes(minutesUntil(activity.starts_at))}. Preparem o check-in.`;
  if (kind === "open") return `${boss} abriu! Façam o check-in no site.`;
  if (kind === "reminder") return `${boss} fecha em ${minutes(minutesUntil(activity.expires_at))}. Quem ainda não fez check-in, faz agora.`;
  if (kind === "reopen") return `${boss} reabriu e fecha em ${minutes(minutesUntil(activity.expires_at))}. Quem não fez check-in, aproveita.`;
  return null;
}

// ---------- Discord ----------

const STALE_MS = 2 * 60_000;
const FRAME_BYTES = 3840; // 20 ms de PCM 48 kHz estéreo 16 bits

// Fila por servidor do Discord: o bot só fica num canal por servidor. Falas que
// chegam juntas (vários bosses no mesmo horário) entram numa visita só ao canal.
const queues = new Map();

function* frames(pcm) {
  // Em pedaços de 20 ms: o codificador Opus trabalha aos poucos enquanto toca,
  // em vez de travar o processo codificando a fala inteira de uma vez.
  for (let i = 0; i < pcm.length; i += FRAME_BYTES) yield pcm.subarray(i, i + FRAME_BYTES);
}

function humanIds(channel) {
  return [...(channel.members?.values?.() || [])]
    .filter((member) => !member.user?.bot)
    .map((member) => member.id);
}

/**
 * Entra, fala cada áudio e sai. Devolve quantos tocaram até o fim. Só lança erro
 * se nada chegou a tocar; depois disso só registra, para ninguém tentar de novo
 * e o bot falar duas vezes.
 */
async function speakIn(channel, pcms) {
  const {
    AudioPlayerStatus, StreamType, VoiceConnectionStatus,
    createAudioPlayer, createAudioResource, entersState, joinVoiceChannel,
  } = voiceLib;
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  // Sem quem ouça, um erro de rede da voz vira exceção solta e derruba a API inteira.
  connection.on("error", (error) => console.error(`bot de voz: conexão: ${error.message}`));
  let player = null;
  let played = 0;
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, READY_TIMEOUT_MS);
    player = createAudioPlayer();
    player.on("error", (error) => console.error(`bot de voz: áudio: ${error.message}`));
    connection.subscribe(player);
    for (const pcm of pcms) {
      player.play(createAudioResource(Readable.from(frames(pcm)), { inputType: StreamType.Raw }));
      await entersState(player, AudioPlayerStatus.Playing, 5_000);
      await entersState(player, AudioPlayerStatus.Idle, PLAY_TIMEOUT_MS);
      played += 1;
    }
    return played;
  } catch (error) {
    if (!played) throw error;
    console.error(`bot de voz: a fala parou no meio em #${channel.name}: ${error.message}`);
    return played;
  } finally {
    try { player?.stop(true); } catch { /* já parado */ }
    try {
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
    } catch { /* o discord.js já destruiu (gateway caiu) */ }
  }
}

async function drain(serverId) {
  const queue = queues.get(serverId);
  if (!queue || queue.running) return;
  queue.running = true;
  try {
    while (queue.items.length) {
      const batch = queue.items.splice(0);
      const fresh = [];
      for (const item of batch) {
        if (Date.now() - item.createdAt > STALE_MS) item.resolve(false);
        else fresh.push(item);
      }
      const byChannel = new Map();
      for (const item of fresh) {
        if (!byChannel.has(item.channel.id)) byChannel.set(item.channel.id, []);
        byChannel.get(item.channel.id).push(item);
      }
      for (const items of byChannel.values()) {
        try {
          const played = await speakIn(items[0].channel, items.map((item) => item.pcm));
          items.forEach((item, index) => item.resolve(index < played));
        } catch (error) {
          items.forEach((item) => item.reject(error));
        }
      }
    }
  } finally {
    queue.running = false;
    if (!queue.items.length) queues.delete(serverId);
  }
}

function speak(channel, pcm) {
  return new Promise((resolve, reject) => {
    const serverId = channel.guild.id;
    if (!queues.has(serverId)) queues.set(serverId, { items: [], running: false });
    queues.get(serverId).items.push({ channel, pcm, createdAt: Date.now(), resolve, reject });
    drain(serverId);
  });
}

async function loadVoiceChannel(guildId, db) {
  const { rows } = await db.query("SELECT discord_voice_channel_id FROM guilds WHERE id = $1", [guildId]);
  const channelId = rows[0]?.discord_voice_channel_id;
  if (!channelId || !ROLE_OR_CHANNEL_RE.test(channelId)) return null;
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel || !channel.isVoiceBased?.() || !channel.guild) return null;
  return channel;
}

/** Motivo para não entrar no canal, ou null se dá para falar lá. */
function channelProblem(channel) {
  if (channel.type === discordLib.ChannelType.GuildStageVoice) return "é um canal de palco (o bot entraria mudo)";
  if (!channel.joinable) return "o bot não tem permissão de Conectar ou o canal está cheio";
  if (channel.speakable === false) return "o bot não tem permissão de Falar";
  return null;
}

/** Quem é da guilda e ainda não fez check-in nesta atividade (o do piloto conta para o dono). */
async function pendingIds(guildId, activityId) {
  const { rows } = await jobPool.query(
    `
    SELECT m.discord_id FROM members m
    WHERE m.guild_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM activity_participants ap
        WHERE ap.activity_id = $2 AND ap.member_discord_id = m.discord_id
      )
    `,
    [guildId, activityId],
  );
  return new Set(rows.map((row) => row.discord_id));
}

const warned = new Set();

export async function sendActivityVoice(kind, activity) {
  if (!voiceEnabled() || activity?.guild_id == null) return { sent: 0 };
  const text = speechFor(kind, activity);
  if (!text) return { sent: 0 };
  const channel = await loadVoiceChannel(activity.guild_id, jobPool);
  if (!channel) return { sent: 0 };
  const problem = channelProblem(channel);
  if (problem) {
    // Avisa uma vez por canal no log, sem ficar tentando entrar a cada aviso.
    if (!warned.has(channel.id)) {
      warned.add(channel.id);
      console.error(`bot de voz: não dá para falar em #${channel.name}: ${problem}`);
    }
    return { sent: 0 };
  }
  warned.delete(channel.id);
  const humans = humanIds(channel);
  if (!humans.length) return { sent: 0 };
  // Lembrete e reabertura são para quem falta: se todo mundo da call já fez check-in, fica quieto.
  if (kind === "reminder" || kind === "reopen") {
    const pending = await pendingIds(activity.guild_id, activity.id);
    if (!humans.some((id) => pending.has(id))) return { sent: 0 };
  }
  const pcm = await synthesize(text);
  const done = await speak(channel, pcm);
  return done ? { sent: 1 } : { sent: 0, failed: 1 };
}

const lastTestAt = new Map();

/** Oficial testa a voz: o bot entra no canal configurado e fala uma frase. */
export async function testGuildVoice(actor, guildId) {
  if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin testa o bot de voz.");
  const status = voiceStatus();
  if (!status.bot || !status.tts) throw fail(400, "O bot de voz ainda não foi ligado no servidor (falta o token do bot ou a chave de voz).");
  if (!status.online) throw fail(503, "O bot de voz está desconectado agora. Ele tenta reconectar sozinho; se continuar, confira o log da API.");
  const channel = await loadVoiceChannel(guildId, pool);
  if (!channel) throw fail(400, "Salve o ID do canal de voz e confira se o bot foi convidado para o servidor.");
  const problem = channelProblem(channel);
  if (problem) throw fail(400, `Não dá para falar nesse canal: ${problem}.`);
  if (!humanIds(channel).length) throw fail(400, "Entre no canal de voz para ouvir o teste.");
  const now = Date.now();
  if (now - (lastTestAt.get(Number(guildId)) || 0) < TEST_COOLDOWN_MS) {
    throw fail(429, "Espere alguns segundos antes de testar de novo.");
  }
  lastTestAt.set(Number(guildId), now);
  let pcm;
  try {
    pcm = await synthesize("Teste do bot da guilda. Os avisos de boss vão chegar por aqui.");
  } catch (error) {
    console.error(`bot de voz: teste falhou na fala: ${error.message}`);
    throw fail(502, "O serviço de voz não respondeu. Confira a chave (e se o faturamento do projeto está ativo) e tente de novo.");
  }
  let done = false;
  try {
    done = await speak(channel, pcm);
  } catch (error) {
    console.error(`bot de voz: teste falhou ao entrar no canal: ${error.message}`);
    throw fail(502, "O bot não conseguiu entrar no canal. Confira se ele tem permissão de Conectar e Falar.");
  }
  if (!done) throw fail(502, "O bot entrou, mas a fala não terminou. Tente de novo.");
  return { ok: true };
}
