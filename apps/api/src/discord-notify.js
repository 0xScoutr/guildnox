import { jobPool, pool } from "./db.js";
import { isOfficer } from "./guilds.js";

/**
 * Aviso de atividade num canal do Discord, por webhook, um por guilda.
 *
 * Os oficiais colam o webhook do canal e escolhem quem marcar (o cargo do clã,
 * @everyone, @here ou ninguém). Os horários vêm de activity-notify.js:
 * - "soon" e "open" marcam o cargo escolhido;
 * - "reminder" (10 min depois de abrir) e "reopen" marcam só quem ainda não fez check-in.
 */

const WEBHOOK_RE = /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/(\d{17,20})\/([\w-]{40,100})$/;
const ROLE_RE = /^\d{17,20}$/;
const MAX_USER_MENTIONS = 80;
// O Discord recusa mensagem com mais de 2000 caracteres; acima disso marca o cargo.
const MAX_CONTENT = 1900;
const TIMEOUT_MS = 10_000;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function siteUrl() {
  const origin = (process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("https://"));
  return (origin || "https://guildnox.app").replace(/\/$/, "");
}

export async function migrateDiscordNotify() {
  await pool.query(`
    ALTER TABLE guilds
      ADD COLUMN IF NOT EXISTS discord_webhook_url TEXT,
      ADD COLUMN IF NOT EXISTS discord_mention TEXT,
      ADD COLUMN IF NOT EXISTS discord_voice_channel_id TEXT
  `);
}

export function isDiscordWebhook(value) {
  return typeof value === "string" && WEBHOOK_RE.test(value.trim());
}

/** "everyone", "here", "role:<id>" ou null. Aceita "@everyone", "<@&id>" ou só o id. */
export function normalizeMention(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (!text || text === "none" || text === "ninguem" || text === "ninguém") return null;
  if (text === "everyone" || text === "@everyone") return "everyone";
  if (text === "here" || text === "@here") return "here";
  const role = text.replace(/^role:/, "").replace(/^<@&(\d+)>$/, "$1");
  if (ROLE_RE.test(role)) return `role:${role}`;
  throw fail(400, "Para marcar um cargo, cole o ID do cargo (ative o Modo desenvolvedor no Discord, clique com o botão direito no cargo e copie o ID).");
}

function mentionText(mention) {
  if (mention === "everyone") return "@everyone ";
  if (mention === "here") return "@here ";
  if (mention?.startsWith("role:")) return `<@&${mention.slice(5)}> `;
  return "";
}

function allowedMentions(mention, users = []) {
  return {
    parse: mention === "everyone" || mention === "here" ? ["everyone"] : [],
    roles: mention?.startsWith("role:") ? [mention.slice(5)] : [],
    users,
  };
}

function escapeMarkdown(text) {
  return String(text || "").replace(/([\\*_~`|>[\]()])/g, "\\$1").replace(/@/g, "@\u200b");
}

function unix(date) {
  return Math.floor(new Date(date).getTime() / 1000);
}

/** Para oficiais: diz se a guilda tem webhook (nunca devolve o endereço, que é segredo). */
export async function discordStatusByGuild() {
  const { rows } = await pool.query("SELECT id, discord_webhook_url, discord_mention, discord_voice_channel_id FROM guilds");
  return new Map(rows.map((row) => [Number(row.id), {
    configured: Boolean(row.discord_webhook_url),
    mention: row.discord_mention || null,
    voiceChannelId: row.discord_voice_channel_id || null,
  }]));
}

async function postWebhook(url, payload) {
  const body = JSON.stringify({
    username: "NOX",
    avatar_url: `${siteUrl()}/icons/icon-192.png`,
    ...payload,
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.status === 429 && attempt === 0) {
      const data = await response.json().catch(() => ({}));
      const wait = Math.min(5, Math.max(0.5, Number(data.retry_after) || 1));
      await new Promise((resolve) => setTimeout(resolve, wait * 1000));
      continue;
    }
    if (!response.ok) {
      const error = new Error(`Discord respondeu ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return true;
  }
  throw new Error("Discord limitou os envios; tente de novo em alguns segundos.");
}

async function loadGuildConfig(guildId, db = jobPool) {
  const { rows } = await db.query(
    "SELECT discord_webhook_url, discord_mention FROM guilds WHERE id = $1",
    [guildId],
  );
  const row = rows[0];
  if (!row?.discord_webhook_url || !isDiscordWebhook(row.discord_webhook_url)) return null;
  return { url: row.discord_webhook_url, mention: row.discord_mention || null };
}

/** Quem é da guilda e ainda não fez check-in (o check-in do piloto conta para o dono). */
async function pendingDiscordIds(guildId, activityId) {
  const { rows } = await jobPool.query(
    `
    SELECT m.discord_id
    FROM members m
    WHERE m.guild_id = $1
      AND NOT EXISTS (
        SELECT 1 FROM activity_participants ap
        WHERE ap.activity_id = $2 AND ap.member_discord_id = m.discord_id
      )
    ORDER BY m.discord_id
    `,
    [guildId, activityId],
  );
  return rows.map((row) => row.discord_id).filter((id) => ROLE_RE.test(id));
}

export async function sendActivityDiscord(kind, activity) {
  if (activity?.guild_id == null) return { sent: 0 };
  const config = await loadGuildConfig(activity.guild_id);
  if (!config) return { sent: 0 };

  const name = `**${escapeMarkdown(String(activity.name || "Atividade").trim())}**`;
  const link = `<${siteUrl()}/#/atividades>`;
  const starts = unix(activity.starts_at);
  const ends = unix(activity.expires_at);
  const mention = mentionText(config.mention);
  let payload;

  if (kind === "soon") {
    payload = {
      content: `${mention}⏰ ${name} começa <t:${starts}:R> (<t:${starts}:t>). Prepare o check-in: ${link}`,
      allowed_mentions: allowedMentions(config.mention),
    };
  } else if (kind === "open") {
    payload = {
      content: `${mention}🩸 ${name} abriu! Faça o check-in: ${link} · fecha <t:${ends}:R>`,
      allowed_mentions: allowedMentions(config.mention),
    };
  } else if (kind === "reminder" || kind === "reopen") {
    const pending = await pendingDiscordIds(activity.guild_id, activity.id);
    if (!pending.length) return { sent: 0 };
    const head = kind === "reopen" ? `🔁 ${name} reabriu e fecha <t:${ends}:R>` : `⚠️ ${name} fecha <t:${ends}:R>`;
    const who = pending.length === 1 ? "1 pessoa ainda não fez" : `${pending.length} pessoas ainda não fizeram`;
    const personal = `${head} e ${who} check-in: ${pending.map((id) => `<@${id}>`).join(" ")}\n${link}`;
    if (pending.length <= MAX_USER_MENTIONS && personal.length <= MAX_CONTENT) {
      payload = { content: personal, allowed_mentions: allowedMentions(null, pending) };
    } else {
      payload = {
        content: `${mention}${head} e ${who} check-in: ${link}`,
        allowed_mentions: allowedMentions(config.mention),
      };
    }
  } else {
    return { sent: 0 };
  }

  try {
    await postWebhook(config.url, payload);
  } catch (error) {
    // Sem resposta a tempo, o Discord pode ter postado mesmo assim: não lança, para o
    // agendador não tentar de novo e duplicar a mensagem no canal.
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      console.error(`aviso discord ${kind} #${activity.id}: sem resposta a tempo, sem nova tentativa`);
      return { sent: 0, failed: 1 };
    }
    throw error;
  }
  return { sent: 1 };
}

async function loadOfficerGuild(actor, guildId) {
  if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin configura o aviso no Discord.");
  const { rows } = await pool.query("SELECT id FROM guilds WHERE id = $1", [guildId]);
  if (!rows[0]) throw fail(404, "Guilda não encontrada.");
}

/** body: { webhookUrl?: string | null, mention?: string | null }. Webhook vazio desliga. */
export async function setGuildDiscord(actor, guildId, body = {}) {
  await loadOfficerGuild(actor, guildId);
  const sets = [];
  const values = [];
  if ("webhookUrl" in body) {
    const url = body.webhookUrl == null ? "" : String(body.webhookUrl).trim();
    if (url && !isDiscordWebhook(url)) {
      throw fail(400, "Cole o endereço do webhook do canal (Editar canal > Integrações > Webhooks > Copiar URL).");
    }
    values.push(url || null);
    sets.push(`discord_webhook_url = $${values.length}`);
  }
  if ("mention" in body) {
    values.push(normalizeMention(body.mention));
    sets.push(`discord_mention = $${values.length}`);
  }
  if ("voiceChannelId" in body) {
    const channelId = body.voiceChannelId == null ? "" : String(body.voiceChannelId).trim();
    if (channelId && !ROLE_RE.test(channelId)) {
      throw fail(400, "Cole o ID do canal de voz (clique com o botão direito no canal > Copiar ID do canal).");
    }
    values.push(channelId || null);
    sets.push(`discord_voice_channel_id = $${values.length}`);
  }
  if (!sets.length) throw fail(400, "Nada para salvar.");
  values.push(guildId);
  await pool.query(`UPDATE guilds SET ${sets.join(", ")} WHERE id = $${values.length}`, values);
  return (await discordStatusByGuild()).get(Number(guildId)) || { configured: false, mention: null, voiceChannelId: null };
}

const lastTestAt = new Map();

export async function testGuildDiscord(actor, guildId) {
  await loadOfficerGuild(actor, guildId);
  const config = await loadGuildConfig(guildId, pool);
  if (!config) throw fail(400, "Salve o webhook antes de testar.");
  const now = Date.now();
  if (now - (lastTestAt.get(Number(guildId)) || 0) < 15_000) {
    throw fail(429, "Espere alguns segundos antes de testar de novo.");
  }
  lastTestAt.set(Number(guildId), now);
  const who = mentionText(config.mention).trim();
  try {
    await postWebhook(config.url, {
      content: `✅ Teste do Guildnox: os avisos de boss vão chegar neste canal${who ? ` marcando ${who.replace("@", "@\u200b")}` : ""}.`,
      allowed_mentions: allowedMentions(null),
    });
  } catch (error) {
    if (error.status === 404 || error.status === 401) throw fail(400, "O Discord não achou esse webhook. Ele pode ter sido apagado: crie outro e cole de novo.");
    throw fail(502, "O Discord não respondeu. Tente de novo em instantes.");
  }
  return { ok: true };
}
