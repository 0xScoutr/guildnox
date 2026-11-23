import { pool } from "./db.js";

/**
 * Agenda automática de bosses: os oficiais cadastram o boss uma vez (dias da
 * semana e horários no fuso de Brasília) e a API cria a atividade sozinha
 * LEAD_MINUTES antes de começar. Daí em diante ela é uma atividade comum: aparece
 * em "Em breve", abre no horário e dispara os avisos.
 *
 * Cada horário vira no máximo uma atividade: o índice único (schedule_id, starts_at)
 * garante isso mesmo com a API reiniciando ou rodando em duas réplicas.
 */

const TICK_MS = 60_000;
const LEAD_MINUTES = 60;
// Brasília (padrão) ou o horário do servidor da América do Norte. Não se sabe se o
// servidor segue o horário de verão dos EUA, então as duas opções existem.
const TIMEZONES = new Set(["America/Sao_Paulo", "Etc/GMT+5", "America/New_York"]);
const DEFAULT_TIMEZONE = "America/Sao_Paulo";
const MAX_SCHEDULES_PER_GUILD = 50;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function assertOfficer(actor) {
  if (actor?.role !== "master" && actor?.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin mexe na agenda.");
  }
}

export async function migrateActivitySchedules() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_schedules (
      id BIGSERIAL PRIMARY KEY,
      guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      dkp_value INTEGER NOT NULL CHECK (dkp_value >= 0 AND dkp_value <= 1000000),
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 1 AND duration_minutes <= 1440),
      weekdays SMALLINT[] NOT NULL,
      times TEXT[] NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
      active BOOLEAN NOT NULL DEFAULT true,
      created_by TEXT REFERENCES members(discord_id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    ALTER TABLE activities
    ADD COLUMN IF NOT EXISTS schedule_id BIGINT REFERENCES activity_schedules(id) ON DELETE SET NULL
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS activities_schedule_start_unique
    ON activities (schedule_id, starts_at)
    WHERE schedule_id IS NOT NULL
  `);
}

function present(row) {
  return {
    id: Number(row.id),
    name: row.name,
    dkpValue: row.dkp_value,
    durationMinutes: row.duration_minutes,
    weekdays: (row.weekdays || []).map(Number).sort((a, b) => a - b),
    times: [...(row.times || [])].sort(),
    timezone: row.timezone,
    active: Boolean(row.active),
    createdAt: row.created_at,
  };
}

function readSchedule(body, current = null) {
  const out = {};
  if (!current || "name" in body) {
    const name = String(body.name ?? "").trim();
    if (!name || name.length > 80) throw fail(400, "Informe o nome do boss.");
    out.name = name;
  }
  if (!current || "dkpValue" in body) {
    const dkp = Number(body.dkpValue);
    if (!Number.isInteger(dkp) || dkp < 0 || dkp > 1000000) throw fail(400, "DKP inválido.");
    out.dkpValue = dkp;
  }
  if (!current || "durationMinutes" in body) {
    const duration = Number(body.durationMinutes ?? 30);
    if (!Number.isInteger(duration) || duration < 1 || duration > 1440) throw fail(400, "Duração inválida.");
    out.durationMinutes = duration;
  }
  if (!current || "weekdays" in body) {
    const days = Array.isArray(body.weekdays) ? body.weekdays.map(Number) : [];
    const unique = [...new Set(days)];
    if (!unique.length || unique.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw fail(400, "Escolha pelo menos um dia da semana.");
    }
    out.weekdays = unique.sort((a, b) => a - b);
  }
  if (!current || "times" in body) {
    const raw = Array.isArray(body.times) ? body.times : String(body.times ?? "").split(/[\s,;]+/);
    const times = [...new Set(raw.map((value) => String(value).trim()).filter(Boolean).map((value) => (
      /^\d:\d\d$/.test(value) ? `0${value}` : value
    )))];
    if (!times.length || times.length > 48 || times.some((value) => !TIME_RE.test(value))) {
      throw fail(400, "Informe os horários no formato 15:00, separados por vírgula.");
    }
    out.times = times.sort();
  }
  if (!current || "timezone" in body) {
    const timezone = body.timezone == null || body.timezone === "" ? DEFAULT_TIMEZONE : String(body.timezone);
    if (!TIMEZONES.has(timezone)) throw fail(400, "Fuso inválido.");
    out.timezone = timezone;
  }
  if ("active" in body) out.active = Boolean(body.active);
  return out;
}

export async function listSchedules(actor, guildId) {
  assertOfficer(actor);
  const { rows } = await pool.query(
    "SELECT * FROM activity_schedules WHERE guild_id = $1 ORDER BY name ASC, id ASC",
    [guildId],
  );
  return rows.map(present);
}

export async function createSchedule(actor, body = {}, guildId) {
  assertOfficer(actor);
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  const data = readSchedule(body);
  const { rows: countRows } = await pool.query(
    "SELECT count(*)::int AS n FROM activity_schedules WHERE guild_id = $1",
    [guildId],
  );
  if (countRows[0].n >= MAX_SCHEDULES_PER_GUILD) throw fail(400, `A agenda pode ter no máximo ${MAX_SCHEDULES_PER_GUILD} bosses.`);
  const { rows } = await pool.query(
    `
    INSERT INTO activity_schedules
      (guild_id, name, dkp_value, duration_minutes, weekdays, times, timezone, active, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING *
    `,
    [guildId, data.name, data.dkpValue, data.durationMinutes, data.weekdays, data.times, data.timezone,
      data.active ?? true, actor.discord_id],
  );
  kickActivitySchedules();
  return present(rows[0]);
}

async function loadOwn(id, guildId) {
  const { rows } = await pool.query("SELECT * FROM activity_schedules WHERE id = $1", [id]);
  const row = rows[0];
  if (!row || Number(row.guild_id) !== Number(guildId)) throw fail(404, "Boss da agenda não encontrado.");
  return row;
}

export async function updateSchedule(actor, id, body = {}, guildId) {
  assertOfficer(actor);
  const current = await loadOwn(id, guildId);
  const data = readSchedule(body, current);
  const columns = {
    name: data.name,
    dkp_value: data.dkpValue,
    duration_minutes: data.durationMinutes,
    weekdays: data.weekdays,
    times: data.times,
    timezone: data.timezone,
    active: data.active,
  };
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return present(current);
  values.push(id);
  const { rows } = await pool.query(
    `UPDATE activity_schedules SET ${sets.join(", ")}, updated_at = now() WHERE id = $${values.length} RETURNING *`,
    values,
  );
  kickActivitySchedules();
  return present(rows[0]);
}

export async function deleteSchedule(actor, id, guildId) {
  assertOfficer(actor);
  await loadOwn(id, guildId);
  // As atividades que já foram criadas ficam; só param de nascer novas.
  await pool.query("DELETE FROM activity_schedules WHERE id = $1", [id]);
  return { ok: true, id: Number(id) };
}

/**
 * Cria as atividades que começam na próxima hora. A conta do horário é feita no
 * Postgres, no fuso da agenda: "hoje às 15:00 em Brasília" vira o instante certo.
 * Quem criou a agenda pode ter saído da guilda: aí a atividade fica no nome de um
 * oficial da guilda.
 */
async function createDueActivities() {
  const { rows } = await pool.query(
    `
    INSERT INTO activities
      (name, dkp_value, duration_minutes, starts_at, expires_at, created_by, guild_id, schedule_id)
    SELECT s.name, s.dkp_value, s.duration_minutes, occ.starts_at,
           occ.starts_at + make_interval(mins => s.duration_minutes),
           coalesce(
             s.created_by,
             (SELECT m.discord_id FROM members m
              WHERE m.role IN ('master', 'admin')
              ORDER BY (m.role = 'master') DESC, m.created_at ASC
              LIMIT 1)
           ),
           s.guild_id, s.id
    FROM activity_schedules s
    JOIN guilds g ON g.id = s.guild_id AND g.active IS NOT FALSE
    CROSS JOIN LATERAL (
      SELECT ((day + t::time) AT TIME ZONE s.timezone) AS starts_at,
             EXTRACT(DOW FROM day)::int AS dow
      FROM generate_series(0, 1) AS d,
           LATERAL (SELECT (now() AT TIME ZONE s.timezone)::date + d AS day) AS days,
           unnest(s.times) AS t
    ) occ
    WHERE s.active
      AND occ.dow = ANY(s.weekdays)
      AND occ.starts_at > now()
      AND occ.starts_at <= now() + make_interval(mins => $1)
    ON CONFLICT (schedule_id, starts_at) WHERE schedule_id IS NOT NULL DO NOTHING
    RETURNING id, name, guild_id, starts_at
    `,
    [LEAD_MINUTES],
  );
  for (const row of rows) {
    console.log(`agenda: criou "${row.name}" (#${row.id}) para ${new Date(row.starts_at).toISOString()}`);
  }
  return rows;
}

let ticking = false;
let timer = null;

export async function runActivitySchedulesTick() {
  if (ticking) return [];
  ticking = true;
  try {
    return await createDueActivities();
  } catch (error) {
    console.error(`agenda: ciclo falhou: ${error.message}`);
    return [];
  } finally {
    ticking = false;
  }
}

export function kickActivitySchedules() {
  setTimeout(() => { runActivitySchedulesTick(); }, 250);
}

export function startActivitySchedules() {
  if (timer) return;
  timer = setInterval(() => { runActivitySchedulesTick(); }, TICK_MS);
  setTimeout(() => { runActivitySchedulesTick(); }, 5_000);
}
