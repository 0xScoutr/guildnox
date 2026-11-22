import { pool } from "./db.js";
import { pushEnabled, sendActivityPush } from "./push.js";

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

// Cada canal recebe (kind, activity). O push é o primeiro; outros canais entram aqui.
const CHANNELS = [
  { name: "push", enabled: pushEnabled, send: sendActivityPush },
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

async function deliver(kind, activity) {
  for (const channel of CHANNELS) {
    if (!channel.enabled()) continue;
    try {
      const result = await channel.send(kind, activity);
      if (result?.sent || result?.removed || result?.failed) {
        console.log(
          `aviso ${channel.name} ${kind} #${activity.id}: ${result.sent || 0} enviados, `
          + `${result.removed || 0} removidos, ${result.failed || 0} falharam`,
        );
      }
    } catch (error) {
      console.error(`aviso ${channel.name} ${kind} #${activity.id} falhou: ${error.message}`);
    }
  }
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
        const { rows } = await pool.query(claim.sql, claim.params);
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
