import { applyDkpDelta } from "./dkp-ledger.js";
import { pool, present } from "./db.js";

function fail(status, message, data = {}) {
  const error = new Error(message);
  error.status = status;
  error.data = data;
  return error;
}

function nickOf(member) {
  return member.character_name || member.global_name || member.username;
}

/** Bônus de atividade: DKP fixo + 0,0015% do power (ex.: 200k → +3). */
export const ACTIVITY_POWER_BONUS_RATE = 0.000015;

export function activityDkpWithPowerBonus(baseDkp, power) {
  const base = Math.max(0, Number(baseDkp) || 0);
  const rawPower = Math.max(0, Number(power) || 0);
  return Math.max(0, Math.round(base + rawPower * ACTIVITY_POWER_BONUS_RATE));
}

function computeFlags(row, now = Date.now()) {
  const starts = new Date(row.starts_at).getTime();
  const ends = new Date(row.expires_at).getTime();
  const finalized = Boolean(row.finalized_at);
  const isScheduled = !finalized && now < starts;
  const isOpen = !finalized && now >= starts && now < ends;
  return { isScheduled, isOpen, finalized };
}

export async function migrateActivities() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activities (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      dkp_value INTEGER NOT NULL CHECK (dkp_value >= 0 AND dkp_value <= 1000000),
      duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 1 AND duration_minutes <= 1440),
      starts_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      finalized_at TIMESTAMPTZ,
      created_by TEXT NOT NULL REFERENCES members(discord_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS activity_participants (
      activity_id BIGINT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
      member_discord_id TEXT NOT NULL REFERENCES members(discord_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (activity_id, member_discord_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS activities_starts_at_idx ON activities(starts_at DESC)
  `);
  await pool.query(`
    ALTER TABLE activities
    ADD COLUMN IF NOT EXISTS sound_data TEXT
  `);
}

const SOUND_DATA_MAX = 1_800_000;
const SOUND_DATA_RE = /^data:audio\/(mpeg|mp3|wav|x-wav|ogg|webm|mp4|aac|x-m4a);base64,[A-Za-z0-9+/=\s]+$/i;

function normalizeSoundData(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw fail(400, "Áudio da atividade inválido.");
  const soundData = value.trim().replace(/\s+/g, "");
  if (!soundData) return null;
  if (!SOUND_DATA_RE.test(soundData)) {
    throw fail(400, "Use um áudio MP3, WAV, OGG ou M4A.");
  }
  if (soundData.length > SOUND_DATA_MAX) {
    throw fail(400, "O áudio ficou grande demais (máx. cerca de 1,3 MB).");
  }
  return soundData;
}

async function loadActivity(id, client = pool) {
  const { rows } = await client.query("SELECT * FROM activities WHERE id = $1", [id]);
  return rows[0] || null;
}

async function finalizeIfNeeded(row, client = pool) {
  if (!row || row.finalized_at) return row;
  const now = Date.now();
  if (now < new Date(row.expires_at).getTime()) return row;
  const { rows } = await client.query(
    `
    UPDATE activities
    SET finalized_at = now()
    WHERE id = $1 AND finalized_at IS NULL AND expires_at <= now()
    RETURNING *
    `,
    [row.id],
  );
  return rows[0] || row;
}

async function presentActivity(row, viewerId) {
  const fresh = await finalizeIfNeeded(row);
  const flags = computeFlags(fresh);
  const count = await pool.query(
    "SELECT count(*)::int AS n FROM activity_participants WHERE activity_id = $1",
    [fresh.id],
  );
  const mine = await pool.query(
    `
    SELECT 1 FROM activity_participants
    WHERE activity_id = $1 AND member_discord_id = $2
    LIMIT 1
    `,
    [fresh.id, viewerId],
  );
  return {
    id: Number(fresh.id),
    name: fresh.name,
    dkpValue: fresh.dkp_value,
    durationMinutes: fresh.duration_minutes,
    startsAt: fresh.starts_at,
    openedAt: fresh.starts_at,
    expiresAt: fresh.expires_at,
    scheduledAt: flags.isScheduled ? fresh.starts_at : null,
    finalizedAt: fresh.finalized_at,
    createdAt: fresh.created_at,
    isOpen: flags.isOpen,
    isScheduled: flags.isScheduled,
    participated: mine.rowCount > 0,
    participantsCount: count.rows[0].n,
    hasSound: Boolean(fresh.has_sound ?? fresh.sound_data),
  };
}

export async function listActivities(viewer, guildId) {
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  const { rows } = await pool.query(
    `
    SELECT id, name, dkp_value, duration_minutes, starts_at, expires_at, finalized_at,
           created_by, created_at, guild_id,
           (sound_data IS NOT NULL AND sound_data <> '') AS has_sound
    FROM activities
    WHERE guild_id = $1
    ORDER BY starts_at DESC, id DESC
    LIMIT 200
    `,
    [guildId],
  );
  const out = [];
  for (const row of rows) out.push(await presentActivity(row, viewer.discord_id));
  return out;
}

export async function createActivity(actor, body, guildId) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin cria atividade.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) throw fail(400, "Informe o nome da atividade.");
  const soundData = normalizeSoundData(body.soundData);
  const dkpValue = Number(body.dkpValue);
  const durationMinutes = Number(body.durationMinutes || 30);
  if (!Number.isInteger(dkpValue) || dkpValue < 0 || dkpValue > 1000000) {
    throw fail(400, "DKP inválido.");
  }
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 1440) {
    throw fail(400, "Duração inválida.");
  }
  const startsAt = body.startsAt || body.scheduledAt
    ? new Date(body.startsAt || body.scheduledAt)
    : new Date();
  if (Number.isNaN(startsAt.getTime())) throw fail(400, "Horário de início inválido.");
  const expiresAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

  const { rows } = await pool.query(
    `
    INSERT INTO activities
      (name, dkp_value, duration_minutes, starts_at, expires_at, created_by, guild_id, sound_data)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [name, dkpValue, durationMinutes, startsAt.toISOString(), expiresAt.toISOString(), actor.discord_id, guildId, soundData],
  );
  return presentActivity(rows[0], actor.discord_id);
}

export async function getActivitySound(id, guildId) {
  const { rows } = await pool.query(
    `
    SELECT id, guild_id, sound_data
    FROM activities
    WHERE id = $1
    `,
    [id],
  );
  const row = rows[0];
  if (!row) throw fail(404, "Atividade não encontrada.");
  if (guildId != null && Number(row.guild_id) !== Number(guildId)) {
    throw fail(404, "Atividade não encontrada.");
  }
  if (!row.sound_data) throw fail(404, "Esta atividade não tem áudio.");
  const match = String(row.sound_data).match(/^data:(audio\/[a-z0-9.+-]+);base64,(.+)$/i);
  if (!match) throw fail(404, "Áudio inválido.");
  let contentType = match[1].toLowerCase();
  if (contentType === "audio/mp3") contentType = "audio/mpeg";
  if (contentType === "audio/x-wav") contentType = "audio/wav";
  if (contentType === "audio/x-m4a") contentType = "audio/mp4";
  return {
    contentType,
    buffer: Buffer.from(match[2], "base64"),
  };
}

export async function listActivityParticipants(id, guildId = null) {
  const row = await loadActivity(id);
  if (!row) throw fail(404, "Atividade não encontrada.");
  if (guildId != null && Number(row.guild_id) !== Number(guildId)) {
    throw fail(404, "Atividade não encontrada.");
  }
  const { rows } = await pool.query(
    `
    SELECT m.*
    FROM activity_participants p
    JOIN members m ON m.discord_id = p.member_discord_id
    WHERE p.activity_id = $1
    ORDER BY p.created_at ASC
    `,
    [id],
  );
  return rows.map((member) => ({
    discordId: member.discord_id,
    nick: nickOf(member),
    className: member.class_name,
    avatarUrl: present(member).avatarUrl,
  }));
}

export async function reopenActivity(actor, id, body = {}, guildId = null) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin reabre atividade.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");

  const extraMinutes = Number(body.extraMinutes ?? body.minutes ?? 15);
  if (!Number.isInteger(extraMinutes) || extraMinutes < 1 || extraMinutes > 1440) {
    throw fail(400, "Informe quantos minutos reabrir (1 a 1440).");
  }

  const client = await pool.connect();
  let updated = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM activities WHERE id = $1 FOR UPDATE", [id]);
    let activity = locked.rows[0];
    if (!activity) throw fail(404, "Atividade não encontrada.");
    if (Number(activity.guild_id) !== Number(guildId)) {
      throw fail(404, "Atividade não encontrada.");
    }

    activity = await finalizeIfNeeded(activity, client);
    const flags = computeFlags(activity);
    if (flags.isOpen) {
      throw fail(400, "Essa atividade ainda está aberta.");
    }
    if (flags.isScheduled) {
      throw fail(400, "Essa atividade ainda não começou.");
    }

    const expiresAt = new Date(Date.now() + extraMinutes * 60 * 1000);
    const { rows } = await client.query(
      `
      UPDATE activities
      SET finalized_at = NULL,
          expires_at = $2
      WHERE id = $1
      RETURNING *
      `,
      [id, expiresAt.toISOString()],
    );
    await client.query("COMMIT");
    updated = rows[0];
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }

  return presentActivity(updated, actor.discord_id);
}

export async function deleteActivity(actor, id, guildId = null) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin exclui atividade.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");

  const locked = await pool.query(
    `
    SELECT id, guild_id, name
    FROM activities
    WHERE id = $1
    `,
    [id],
  );
  const activity = locked.rows[0];
  if (!activity) throw fail(404, "Atividade não encontrada.");
  if (Number(activity.guild_id) !== Number(guildId)) {
    throw fail(404, "Atividade não encontrada.");
  }

  // Participantes saem no CASCADE; DKP já creditado permanece.
  await pool.query("DELETE FROM activities WHERE id = $1", [id]);
  return { ok: true, id: Number(id), name: activity.name };
}

async function creditActivityParticipation(client, activityId, discordId, dkpValue, activityName = "") {
  const existing = await client.query(
    `
    SELECT 1 FROM activity_participants
    WHERE activity_id = $1 AND member_discord_id = $2
    `,
    [activityId, discordId],
  );
  if (existing.rowCount > 0) return { credited: false, awardedDkp: 0 };

  const memberRes = await client.query(
    `
    SELECT power FROM members WHERE discord_id = $1
    `,
    [discordId],
  );
  if (!memberRes.rows[0]) {
    throw fail(404, "Membro não encontrado.");
  }
  const awardedDkp = activityDkpWithPowerBonus(dkpValue, memberRes.rows[0].power);

  await client.query(
    `
    INSERT INTO activity_participants (activity_id, member_discord_id)
    VALUES ($1, $2)
    `,
    [activityId, discordId],
  );

  if (awardedDkp > 0) {
    await applyDkpDelta(client, {
      discordId,
      amount: awardedDkp,
      reason: "activity",
      label: activityName || `Atividade #${activityId}`,
      refType: "activity",
      refId: String(activityId),
    });
  }
  return { credited: true, awardedDkp };
}

export async function participateActivity(actor, id, guildId = null, alsoCredit = null) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM activities WHERE id = $1 FOR UPDATE", [id]);
    let activity = locked.rows[0];
    if (!activity) throw fail(404, "Atividade não encontrada.");
    if (guildId != null && Number(activity.guild_id) !== Number(guildId)) {
      throw fail(404, "Atividade não encontrada.");
    }
    activity = await finalizeIfNeeded(activity, client);
    const flags = computeFlags(activity);
    if (flags.finalized || activity.finalized_at) {
      throw fail(400, "Essa atividade já encerrou.", { error: "ended" });
    }
    if (flags.isScheduled) {
      throw fail(400, "Essa atividade ainda não abriu.", { error: "not_started" });
    }
    if (!flags.isOpen) {
      throw fail(400, "O prazo para participar acabou.", { error: "expired" });
    }

    const ownerCredit = await creditActivityParticipation(
      client,
      id,
      actor.discord_id,
      activity.dkp_value,
      activity.name,
    );
    if (!ownerCredit.credited) {
      throw fail(400, "Você já participou dessa atividade.", { error: "already_participated" });
    }

    let alsoAwardedDkp = null;
    // Piloto: um check-in conta presença/DKP na conta do dono e na dele.
    const extraId = alsoCredit?.discord_id;
    if (extraId && extraId !== actor.discord_id) {
      const extraCredit = await creditActivityParticipation(
        client,
        id,
        extraId,
        activity.dkp_value,
        activity.name,
      );
      if (extraCredit.credited) alsoAwardedDkp = extraCredit.awardedDkp;
    }

    await client.query("COMMIT");

    const row = await loadActivity(id);
    return {
      activity: await presentActivity(row, actor.discord_id),
      awardedDkp: ownerCredit.awardedDkp,
      alsoAwardedDkp,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}
