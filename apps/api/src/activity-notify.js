import { jobPool, pool } from "./db.js";
import { sendActivityDiscord } from "./discord-notify.js";
import { pushEnabled, sendActivityPush } from "./push.js";
import { sendActivityVoice, voiceEnabled } from "./voice-notify.js";

/**
 * Quando cada aviso de atividade sai. Três avisos por atividade:
 * - "soon": SOON_MINUTES antes de uma atividade agendada começar;
 * - "open": quando a atividade abre (agendada ou criada na hora);
 * - "reminder": REMINDER_MINUTES depois de abrir, só para quem ainda não fez check-in.
 * Reabrir uma atividade manda "reopen" para quem ainda não fez check-in, e o
 * lembrete volta a valer a partir da reabertura.
 *
 * Cada aviso sai uma vez só: a coluna notify_*_sent_at é marcada no mesmo UPDATE
 * que escolhe a atividade, então reiniciar a API ou rodar duas réplicas não
 * duplica nada. Quem já fez check-in nunca recebe aviso daquela atividade.
 */

const TICK_MS = 30_000;
const SOON_MINUTES = 5;
const REMINDER_MINUTES = 10;

// Cada canal recebe (kind, activity). O Discord fica sempre ligado porque o
// webhook é configurado por guilda, a qualquer hora; sem webhook ele não envia nada.
const CHANNELS = [
  { name: "push", enabled: pushEnabled, send: sendActivityPush },
  { name: "discord", enabled: () => true, send: sendActivityDiscord },
  // A voz leva segundos (entrar, falar, sair): roda à parte para não atrasar os outros canais.
  { name: "voz", enabled: voiceEnabled, send: sendActivityVoice, background: true },
];

function anyChannel() {
  return CHANNELS.some((channel) => channel.enabled());
}

export async function migrateActivityNotify() {
  await pool.query(`
    ALTER TABLE activities
      ADD COLUMN IF NOT EXISTS notify_soon_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notify_open_sent_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS notify_reminder_sent_at TIMESTAMPTZ
  `);
}

const RETURNING = "RETURNING id, name, guild_id, dkp_value, starts_at, expires_at";

const CLAIMS = [
  {
    kind: "soon",
    sql: `
      UPDATE activities SET notify_soon_sent_at = now()
      WHERE notify_soon_sent_at IS NULL
        AND finalized_at IS NULL
        AND guild_id IS NOT NULL
        AND starts_at > now() + interval '1 minute'
        AND starts_at <= now() + make_interval(mins => $1)
      ${RETURNING}
    `,
    params: [SOON_MINUTES],
  },
  {
    kind: "open",
    sql: `
      UPDATE activities
      SET notify_open_sent_at = now(),
          notify_soon_sent_at = coalesce(notify_soon_sent_at, now())
      WHERE notify_open_sent_at IS NULL
        AND finalized_at IS NULL
        AND guild_id IS NOT NULL
        AND starts_at <= now()
        AND expires_at > now() + interval '1 minute'
      ${RETURNING}
    `,
    params: [],
  },
  {
    kind: "reminder",
    sql: `
      UPDATE activities SET notify_reminder_sent_at = now()
      WHERE notify_reminder_sent_at IS NULL
        AND finalized_at IS NULL
        AND guild_id IS NOT NULL
        AND notify_open_sent_at IS NOT NULL
        AND notify_open_sent_at <= now() - make_interval(mins => $1)
        AND expires_at > now() + interval '1 minute'
      ${RETURNING}
    `,
    params: [REMINDER_MINUTES],
  },
];

const RETRY_DELAY_MS = 3_000;

/**
 * Manda por um canal, com uma nova tentativa. Os canais só lançam erro quando o
 * aviso não saiu (falha ao ler destinatários ou configuração, ou o Discord recusou);
 * depois do envio eles só registram no log. Então tentar de novo não duplica o aviso.
 */
async function deliverTo(channel, kind, activity) {
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const result = await channel.send(kind, activity);
      if (result?.sent || result?.removed || result?.failed) {
        console.log(
          `aviso ${channel.name} ${kind} #${activity.id}: ${result.sent || 0} enviados, `
          + `${result.removed || 0} removidos, ${result.failed || 0} falharam`,
        );
      }
      return;
    } catch (error) {
      console.error(`aviso ${channel.name} ${kind} #${activity.id} falhou (tentativa ${attempt}): ${error.message}`);
      if (attempt === 1) await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }
}

async function deliver(kind, activity) {
  const active = CHANNELS.filter((channel) => channel.enabled());
  for (const channel of active.filter((item) => item.background)) {
    deliverTo(channel, kind, activity).catch(() => {});
  }
  await Promise.all(active.filter((item) => !item.background).map((channel) => deliverTo(channel, kind, activity)));
}

let ticking = false;
let tickAgain = false;
let timer = null;

export async function runActivityNotifyTick() {
  if (!anyChannel()) return;
  if (ticking) {
    tickAgain = true;
    return;
  }
  ticking = true;
  try {
    do {
      tickAgain = false;
      for (const claim of CLAIMS) {
        const { rows } = await jobPool.query(claim.sql, claim.params);
        for (const activity of rows) await deliver(claim.kind, activity);
      }
    } while (tickAgain);
  } catch (error) {
    console.error(`avisos de atividade: ciclo falhou: ${error.message}`);
  } finally {
    ticking = false;
  }
}

/** Roda um ciclo já (ex.: atividade criada para abrir na hora). */
export function kickActivityNotify() {
  if (!anyChannel()) return;
  setTimeout(() => { runActivityNotifyTick(); }, 250);
}

export function startActivityNotify() {
  if (!anyChannel() || timer) return;
  timer = setInterval(() => { runActivityNotifyTick(); }, TICK_MS);
  setTimeout(() => { runActivityNotifyTick(); }, 5_000);
}

/** Reabriu: avisa só quem ainda não fez check-in. */
export async function notifyActivityReopened(activity) {
  if (!anyChannel() || !activity) return;
  await deliver("reopen", activity);
}
