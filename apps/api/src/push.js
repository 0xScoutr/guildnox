import webpush from "web-push";
import { pool } from "./db.js";

/**
 * Notificação push (Web Push): avisa de atividade mesmo com o site fechado.
 *
 * Aqui ficam as inscrições (uma por aparelho) e o envio. Quando cada aviso sai
 * é decidido em activity-notify.js.
 *
 * Sem VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY o push fica desligado e nada muda.
 */

const MAX_SUBSCRIPTIONS_PER_MEMBER = 10;
const SEND_CONCURRENCY = 20;
const SEND_TIMEOUT_MS = 10_000;
const MAX_FAILURES = 20;
const TEST_COOLDOWN_MS = 15_000;

// Só os serviços de push dos navegadores. Sem essa lista, qualquer membro poderia
// cadastrar um endereço interno e fazer a API mandar requisições para ele.
const PUSH_HOSTS = new Set([
  "fcm.googleapis.com",
  "android.googleapis.com",
  "updates.push.services.mozilla.com",
  "web.push.apple.com",
]);
const PUSH_HOST_SUFFIXES = [".notify.windows.com", ".push.apple.com"];

const LANGS = new Set(["pt", "en", "es"]);
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;

const TEXT = {
  pt: {
    soonTitle: "{name} começa em {min} min",
    soonBody: "Fique pronto para o check-in.",
    openTitle: "{name} abriu",
    openBody: "Faça o check-in agora. Fecha em {min} min.",
    reminderTitle: "Ainda dá tempo: {name}",
    reminderBody: "Você ainda não fez check-in. Fecha em {min} min.",
    reopenTitle: "{name} foi reaberta",
    reopenBody: "Você ainda não fez check-in. Fecha em {min} min.",
    testTitle: "Notificações ligadas",
    testBody: "Os avisos de atividade vão chegar assim, mesmo com o site fechado.",
    checkin: "Fazer check-in",
    checkinDone: "Check-in feito em {name}: +{dkp} DKP",
    checkinAlready: "Você já tinha feito check-in em {name}.",
    checkinFail: "Não deu para fazer o check-in. Toque para abrir o site.",
  },
  en: {
    soonTitle: "{name} starts in {min} min",
    soonBody: "Get ready to check in.",
    openTitle: "{name} is open",
    openBody: "Check in now. Closes in {min} min.",
    reminderTitle: "Still time: {name}",
    reminderBody: "You haven't checked in yet. Closes in {min} min.",
    reopenTitle: "{name} was reopened",
    reopenBody: "You haven't checked in yet. Closes in {min} min.",
    testTitle: "Notifications on",
    testBody: "Activity alerts will look like this, even with the site closed.",
    checkin: "Check in",
    checkinDone: "Checked in to {name}: +{dkp} DKP",
    checkinAlready: "You had already checked in to {name}.",
    checkinFail: "Couldn't check in. Tap to open the site.",
  },
  es: {
    soonTitle: "{name} empieza en {min} min",
    soonBody: "Prepárate para el check-in.",
    openTitle: "{name} está abierta",
    openBody: "Haz el check-in ahora. Cierra en {min} min.",
    reminderTitle: "Todavía hay tiempo: {name}",
    reminderBody: "Todavía no hiciste el check-in. Cierra en {min} min.",
    reopenTitle: "{name} fue reabierta",
    reopenBody: "Todavía no hiciste el check-in. Cierra en {min} min.",
    testTitle: "Notificaciones activadas",
    testBody: "Los avisos de actividad llegarán así, incluso con el sitio cerrado.",
    checkin: "Hacer check-in",
    checkinDone: "Check-in hecho en {name}: +{dkp} DKP",
    checkinAlready: "Ya habías hecho el check-in en {name}.",
    checkinFail: "No se pudo hacer el check-in. Toca para abrir el sitio.",
  },
};

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}

function textFor(lang) {
  return TEXT[LANGS.has(lang) ? lang : "pt"];
}

function minutesUntil(date, now = Date.now()) {
  return Math.max(1, Math.round((new Date(date).getTime() - now) / 60_000));
}

let enabled = false;
let publicKey = null;

function defaultSubject() {
  const origin = (process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("https://"));
  return origin || "https://guildnox.app";
}

export function configurePush() {
  const pub = process.env.VAPID_PUBLIC_KEY;
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!pub || !priv) {
    console.log("push desligado: defina VAPID_PUBLIC_KEY e VAPID_PRIVATE_KEY para ligar.");
    return false;
  }
  try {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT || defaultSubject(), pub, priv);
  } catch (error) {
    console.error(`push desligado: chaves VAPID inválidas (${error.message})`);
    return false;
  }
  enabled = true;
  publicKey = pub;
  return true;
}

export function pushEnabled() {
  return enabled;
}

export function pushConfig() {
  return { enabled, publicKey: enabled ? publicKey : null };
}

export async function migratePush() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id BIGSERIAL PRIMARY KEY,
      member_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      lang TEXT NOT NULL DEFAULT 'pt',
      user_agent TEXT,
      failure_count INTEGER NOT NULL DEFAULT 0,
      last_success_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS push_subscriptions_member_idx
    ON push_subscriptions(member_discord_id)
  `);
}

export function isAllowedPushEndpoint(value) {
  if (typeof value !== "string" || value.length > 1024) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

function readKey(value, min, max, label) {
  if (typeof value !== "string" || value.length < min || value.length > max || !BASE64URL_RE.test(value)) {
    throw fail(400, `Chave ${label} da inscrição inválida.`);
  }
  return value;
}

export async function saveSubscription(member, body = {}, userAgent = "") {
  if (!enabled) throw fail(503, "As notificações ainda não foram ligadas neste servidor.");
  const sub = body.subscription || {};
  if (!isAllowedPushEndpoint(sub.endpoint)) throw fail(400, "Endereço de notificação não aceito.");
  const p256dh = readKey(sub.keys?.p256dh, 80, 100, "p256dh");
  const auth = readKey(sub.keys?.auth, 16, 32, "auth");
  const lang = LANGS.has(body.lang) ? body.lang : "pt";
  const agent = String(userAgent || "").slice(0, 200) || null;

  // O mesmo aparelho pode trocar de conta: a inscrição passa para quem está logado agora.
  await pool.query(
    `
    INSERT INTO push_subscriptions (member_discord_id, endpoint, p256dh, auth, lang, user_agent)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (endpoint) DO UPDATE SET
      member_discord_id = EXCLUDED.member_discord_id,
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      lang = EXCLUDED.lang,
      user_agent = EXCLUDED.user_agent,
      failure_count = 0,
      updated_at = now()
    `,
    [member.discord_id, sub.endpoint, p256dh, auth, lang, agent],
  );
  await pool.query(
    `
    DELETE FROM push_subscriptions
    WHERE member_discord_id = $1
      AND id NOT IN (
        SELECT id FROM push_subscriptions
        WHERE member_discord_id = $1
        ORDER BY updated_at DESC, id DESC
        LIMIT $2
      )
    `,
    [member.discord_id, MAX_SUBSCRIPTIONS_PER_MEMBER],
  );
  return { ok: true };
}

export async function removeSubscription(member, endpoint) {
  if (typeof endpoint !== "string" || !endpoint) throw fail(400, "Informe a inscrição.");
  const { rowCount } = await pool.query(
    "DELETE FROM push_subscriptions WHERE endpoint = $1 AND member_discord_id = $2",
    [endpoint, member.discord_id],
  );
  return { ok: true, removed: rowCount };
}

/**
 * Inscrições de quem joga na guilda: membros da guilda, oficiais que gerenciam
 * a guilda e pilotos das contas da guilda. Quem já fez check-in fica de fora.
 */
async function recipientsFor(guildId, activityId) {
  const { rows } = await pool.query(
    `
    WITH targets AS (
      SELECT m.discord_id AS member_id, m.discord_id AS char_id
      FROM members m
      WHERE m.guild_id = $1
         OR (m.role IN ('master', 'admin') AND m.managing_guild_id = $1)
      UNION
      SELECT p.pilot_discord_id AS member_id, p.owner_discord_id AS char_id
      FROM account_pilots p
      JOIN members o ON o.discord_id = p.owner_discord_id
      WHERE p.status = 'active' AND o.guild_id = $1
    ),
    pending AS (
      SELECT DISTINCT t.member_id
      FROM targets t
      WHERE NOT EXISTS (
        SELECT 1 FROM activity_participants ap
        WHERE ap.activity_id = $2 AND ap.member_discord_id = t.char_id
      )
    )
    SELECT s.id, s.endpoint, s.p256dh, s.auth, s.lang
    FROM push_subscriptions s
    JOIN pending p ON p.member_id = s.member_discord_id
    `,
    [guildId, activityId],
  );
  return rows;
}

async function sendAll(subscriptions, buildPayload, { ttl, topic }) {
  const ok = [];
  const gone = [];
  const failed = [];
  for (let i = 0; i < subscriptions.length; i += SEND_CONCURRENCY) {
    const batch = subscriptions.slice(i, i + SEND_CONCURRENCY);
    await Promise.allSettled(batch.map(async (sub) => {
      if (!isAllowedPushEndpoint(sub.endpoint)) {
        gone.push(sub.id);
        return;
      }
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(buildPayload(textFor(sub.lang))),
          { TTL: ttl, urgency: "high", topic, timeout: SEND_TIMEOUT_MS },
        );
        ok.push(sub.id);
      } catch (error) {
        const code = error?.statusCode;
        if (code === 404 || code === 410) gone.push(sub.id);
        else failed.push(sub.id);
      }
    }));
  }
  if (ok.length) {
    await pool.query(
      "UPDATE push_subscriptions SET last_success_at = now(), failure_count = 0 WHERE id = ANY($1::bigint[])",
      [ok],
    );
  }
  if (gone.length) {
    await pool.query("DELETE FROM push_subscriptions WHERE id = ANY($1::bigint[])", [gone]);
  }
  if (failed.length) {
    await pool.query(
      "UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = ANY($1::bigint[])",
      [failed],
    );
    await pool.query("DELETE FROM push_subscriptions WHERE failure_count >= $1", [MAX_FAILURES]);
  }
  return { sent: ok.length, removed: gone.length, failed: failed.length };
}

function activityPayload(kind, activity, text, now = Date.now()) {
  const name = String(activity.name || "").trim() || "Atividade";
  const id = Number(activity.id);
  const vars = {
    name,
    min: kind === "soon" ? minutesUntil(activity.starts_at, now) : minutesUntil(activity.expires_at, now),
  };
  const canCheckIn = kind !== "soon";
  return {
    kind,
    title: fill(text[`${kind}Title`], vars),
    body: fill(text[`${kind}Body`], vars),
    tag: `guildnox-activity-${id}`,
    hash: "#/atividades",
    activityId: id,
    activityName: name,
    actions: canCheckIn ? [{ action: "checkin", title: text.checkin }] : [],
    strings: canCheckIn
      ? { done: text.checkinDone, already: text.checkinAlready, fail: text.checkinFail }
      : null,
  };
}

export async function sendActivityPush(kind, activity) {
  if (!enabled || activity?.guild_id == null) return { sent: 0 };
  const now = Date.now();
  // Depois que a atividade fecha o aviso não serve mais; o Topic faz o "abriu"
  // substituir o "começa em 5 min" se o aparelho estava offline.
  const ttl = Math.max(60, Math.round((new Date(activity.expires_at).getTime() - now) / 1000));
  const subscriptions = await recipientsFor(activity.guild_id, activity.id);
  if (!subscriptions.length) return { sent: 0 };
  return sendAll(subscriptions, (text) => activityPayload(kind, activity, text, now), {
    ttl,
    topic: `act${Number(activity.id)}`,
  });
}

const lastTestAt = new Map();

export async function sendTestPush(member) {
  if (!enabled) throw fail(503, "As notificações ainda não foram ligadas neste servidor.");
  const now = Date.now();
  if (now - (lastTestAt.get(member.discord_id) || 0) < TEST_COOLDOWN_MS) {
    throw fail(429, "Espere alguns segundos antes de testar de novo.");
  }
  lastTestAt.set(member.discord_id, now);
  const { rows } = await pool.query(
    "SELECT id, endpoint, p256dh, auth, lang FROM push_subscriptions WHERE member_discord_id = $1",
    [member.discord_id],
  );
  if (!rows.length) throw fail(400, "Nenhum aparelho com notificação ligada nesta conta.");
  return sendAll(rows, (text) => ({
    kind: "test",
    title: text.testTitle,
    body: text.testBody,
    tag: "guildnox-test",
    hash: "#/atividades",
    actions: [],
  }), { ttl: 300, topic: "test" });
}
