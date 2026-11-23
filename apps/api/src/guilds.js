import { brtDateString, brtEndOfDay, brtStartOfDay, brtToday } from "./brt-time.js";
import { pool, present } from "./db.js";

export const MAX_GUILDS = 5;

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function isOfficer(member) {
  return member?.role === "master" || member?.role === "admin";
}

export function effectiveGuildId(member) {
  if (!member) return null;
  if (isOfficer(member) && member.managing_guild_id) return Number(member.managing_guild_id);
  return member.guild_id == null ? null : Number(member.guild_id);
}

export function presentGuild(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    name: row.name,
    active: Boolean(row.active),
    createdAt: row.created_at,
    memberCount: row.member_count == null ? undefined : Number(row.member_count),
  };
}

export async function migrateGuilds() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guilds (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS guild_id BIGINT REFERENCES guilds(id)
  `);
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS managing_guild_id BIGINT REFERENCES guilds(id)
  `);

  await pool.query(`
    ALTER TABLE auctions
    ADD COLUMN IF NOT EXISTS guild_id BIGINT REFERENCES guilds(id)
  `);
  await pool.query(`
    ALTER TABLE activities
    ADD COLUMN IF NOT EXISTS guild_id BIGINT REFERENCES guilds(id)
  `);

  // One-shot rename from legacy Chapa names → NOX.
  const renames = [
    ["^chapa\\s*1$", "NOX I"],
    ["^chapa\\s*2$", "NOX II"],
    ["^chapa\\s*3$", "NOX III"],
  ];
  for (const [pattern, to] of renames) {
    await pool.query(
      `UPDATE guilds SET name = $2
       WHERE name ~* $1
         AND NOT EXISTS (
           SELECT 1 FROM guilds g2 WHERE lower(g2.name) = lower($2)
         )`,
      [pattern, to],
    );
  }

  const { rows: existing } = await pool.query("SELECT id FROM guilds ORDER BY id ASC LIMIT 1");
  let defaultId = existing[0]?.id;
  if (!defaultId) {
    const created = await pool.query(
      `INSERT INTO guilds (name, active) VALUES ('NOX I', true) RETURNING id`,
    );
    defaultId = created.rows[0].id;
  }

  // Não atribui guilda automaticamente a membro sem guilda: entrada exige aprovação.
  await pool.query(
    `UPDATE auctions SET guild_id = $1 WHERE guild_id IS NULL`,
    [defaultId],
  );
  await pool.query(
    `UPDATE activities SET guild_id = $1 WHERE guild_id IS NULL`,
    [defaultId],
  );

  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_applications (
      id BIGSERIAL PRIMARY KEY,
      member_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'accepted', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by TEXT REFERENCES members(discord_id)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS guild_applications_one_pending_per_member
    ON guild_applications (member_discord_id)
    WHERE status = 'pending'
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS guild_applications_pending_guild_idx
    ON guild_applications (guild_id, created_at)
    WHERE status = 'pending'
  `);
}

export async function getPendingApplication(discordId) {
  const { rows } = await pool.query(
    `
    SELECT a.*, g.name AS guild_name
    FROM guild_applications a
    JOIN guilds g ON g.id = a.guild_id
    WHERE a.member_discord_id = $1
      AND a.status = 'pending'
    ORDER BY a.created_at DESC
    LIMIT 1
    `,
    [discordId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: Number(row.guild_id),
    guildName: row.guild_name,
    createdAt: row.created_at,
    status: row.status,
  };
}

export async function applyToGuild(actor, guildId) {
  if (actor.guild_id != null) {
    throw fail(400, "Você já está em uma guilda.");
  }
  // Mestre ainda entra direto (montagem da aliança).
  if (actor.role === "master") {
    return { member: await selectGuild(actor, guildId), pendingApplication: null };
  }

  const id = Number(guildId);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  const guild = await findGuild(id);
  if (!guild) throw fail(404, "Guilda não encontrada.");
  if (!guild.active) throw fail(400, "Essa guilda está inativa.");

  const existing = await getPendingApplication(actor.discord_id);
  if (existing && existing.guildId === id) {
    return { member: actor, pendingApplication: existing };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
      UPDATE guild_applications
      SET status = 'rejected', resolved_at = now()
      WHERE member_discord_id = $1 AND status = 'pending'
      `,
      [actor.discord_id],
    );
    // Pedido de guilda sai do modo piloto (conta volta a disputar vaga).
    await client.query(
      `
      UPDATE members
      SET pilot_account = false, updated_at = now()
      WHERE discord_id = $1
      `,
      [actor.discord_id],
    );
    await client.query(
      `
      INSERT INTO guild_applications (member_discord_id, guild_id, status)
      VALUES ($1, $2, 'pending')
      `,
      [actor.discord_id, id],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }

  const fresh = (await pool.query("SELECT * FROM members WHERE discord_id = $1", [actor.discord_id])).rows[0] || actor;
  return {
    member: fresh,
    pendingApplication: await getPendingApplication(actor.discord_id),
  };
}

export async function cancelGuildApplication(actor) {
  if (actor.guild_id != null) throw fail(400, "Você já está em uma guilda.");
  await pool.query(
    `
    UPDATE guild_applications
    SET status = 'rejected', resolved_at = now(), resolved_by = $1
    WHERE member_discord_id = $1 AND status = 'pending'
    `,
    [actor.discord_id],
  );
  return { ok: true };
}

export async function listPendingApplications(actor) {
  if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin vê pedidos.");
  const { rows } = await pool.query(
    `
    SELECT
      a.id,
      a.guild_id,
      a.created_at,
      g.name AS guild_name,
      m.discord_id,
      m.username,
      m.global_name,
      m.avatar,
      m.character_name,
      m.class_name,
      m.level,
      m.power
    FROM guild_applications a
    JOIN guilds g ON g.id = a.guild_id
    JOIN members m ON m.discord_id = a.member_discord_id
    WHERE a.status = 'pending'
    ORDER BY a.created_at ASC
    `,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    guildId: Number(row.guild_id),
    guildName: row.guild_name,
    createdAt: row.created_at,
    member: {
      discordId: row.discord_id,
      nick: row.character_name || row.global_name || row.username,
      username: row.username,
      avatarUrl: present(row).avatarUrl,
      className: row.class_name,
      level: row.level,
      power: row.power,
    },
  }));
}

export async function resolveGuildApplication(actor, applicationId, decision) {
  if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin resolve pedidos.");
  const id = Number(applicationId);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Pedido inválido.");
  const accept = decision === "accept" || decision === "accepted";
  const reject = decision === "reject" || decision === "rejected";
  if (!accept && !reject) throw fail(400, "Decisão inválida.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      `
      SELECT a.*, g.active AS guild_active, g.name AS guild_name
      FROM guild_applications a
      JOIN guilds g ON g.id = a.guild_id
      WHERE a.id = $1
      FOR UPDATE OF a
      `,
      [id],
    );
    const app = locked.rows[0];
    if (!app) throw fail(404, "Pedido não encontrado.");
    if (app.status !== "pending") throw fail(400, "Esse pedido já foi resolvido.");

    if (reject) {
      await client.query(
        `
        UPDATE guild_applications
        SET status = 'rejected', resolved_at = now(), resolved_by = $2
        WHERE id = $1
        `,
        [id, actor.discord_id],
      );
      await client.query("COMMIT");
      return { ok: true, status: "rejected" };
    }

    if (!app.guild_active) throw fail(400, "Essa guilda está inativa.");
    const memberLocked = await client.query(
      "SELECT * FROM members WHERE discord_id = $1 FOR UPDATE",
      [app.member_discord_id],
    );
    const member = memberLocked.rows[0];
    if (!member) throw fail(404, "Membro não encontrado.");
    if (member.guild_id != null) {
      await client.query(
        `
        UPDATE guild_applications
        SET status = 'rejected', resolved_at = now(), resolved_by = $2
        WHERE id = $1
        `,
        [id, actor.discord_id],
      );
      await client.query("COMMIT");
      throw fail(400, "Esse jogador já entrou em uma guilda.");
    }

    await client.query(
      `
      UPDATE members
      SET guild_id = $2,
          pilot_account = false,
          managing_guild_id = CASE WHEN role IN ('master', 'admin') THEN $2 ELSE managing_guild_id END,
          updated_at = now()
      WHERE discord_id = $1
      `,
      [app.member_discord_id, app.guild_id],
    );
    await client.query(
      `
      UPDATE guild_applications
      SET status = 'accepted', resolved_at = now(), resolved_by = $2
      WHERE id = $1
      `,
      [id, actor.discord_id],
    );
    await client.query(
      `
      UPDATE guild_applications
      SET status = 'rejected', resolved_at = now(), resolved_by = $2
      WHERE member_discord_id = $1 AND status = 'pending' AND id <> $3
      `,
      [app.member_discord_id, actor.discord_id, id],
    );
    await client.query("COMMIT");
    return {
      ok: true,
      status: "accepted",
      guildId: Number(app.guild_id),
      guildName: app.guild_name,
      discordId: app.member_discord_id,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function listActiveGuilds() {
  const { rows } = await pool.query(`
    SELECT * FROM guilds
    WHERE active = true
    ORDER BY id ASC
  `);
  return rows.map(presentGuild);
}

export async function listGuilds() {
  const { rows } = await pool.query(`
    SELECT g.*,
      (
        SELECT count(*)::int
        FROM members m
        WHERE m.guild_id = g.id
          AND m.pilot_account = false
      ) AS member_count
    FROM guilds g
    ORDER BY g.id ASC
  `);
  return rows.map(presentGuild);
}

export async function findGuild(id) {
  const { rows } = await pool.query("SELECT * FROM guilds WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function createGuild(actor, body) {
  if (!isOfficer(actor) || actor.role !== "master") {
    throw fail(403, "Só o mestre cadastra guildas.");
  }
  const { rows: countRows } = await pool.query("SELECT count(*)::int AS n FROM guilds");
  if (countRows[0].n >= MAX_GUILDS) {
    throw fail(400, `A aliança pode ter no máximo ${MAX_GUILDS} guildas.`);
  }
  const name = String(body.name || "").trim();
  if (!name || name.length > 60) throw fail(400, "Informe o nome da guilda.");
  try {
    const { rows } = await pool.query(
      `INSERT INTO guilds (name, active) VALUES ($1, true) RETURNING *`,
      [name],
    );
    return presentGuild(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw fail(400, "Já existe uma guilda com esse nome.");
    throw error;
  }
}

export async function renameGuild(actor, id, body) {
  if (actor.role !== "master") throw fail(403, "Só o mestre renomeia guildas.");
  const guildId = Number(id);
  if (!Number.isInteger(guildId) || guildId < 1) throw fail(400, "Guilda inválida.");
  const guild = await findGuild(guildId);
  if (!guild) throw fail(404, "Guilda não encontrada.");
  const name = String(body.name || "").trim();
  if (!name || name.length > 60) throw fail(400, "Informe o nome da guilda.");
  if (name === guild.name) return presentGuild(guild);
  try {
    const { rows } = await pool.query(
      `UPDATE guilds SET name = $2 WHERE id = $1 RETURNING *`,
      [guildId, name],
    );
    return presentGuild(rows[0]);
  } catch (error) {
    if (error.code === "23505") throw fail(400, "Já existe uma guilda com esse nome.");
    throw error;
  }
}

export async function setGuildActive(actor, id, active) {
  if (actor.role !== "master") throw fail(403, "Só o mestre ativa ou desativa guildas.");
  const guild = await findGuild(id);
  if (!guild) throw fail(404, "Guilda não encontrada.");
  if (!active) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM guilds WHERE active = true AND id <> $1`,
      [id],
    );
    if (rows[0].n < 1) throw fail(400, "Precisa ficar pelo menos uma guilda ativa.");
  }
  const { rows } = await pool.query(
    `UPDATE guilds SET active = $2 WHERE id = $1 RETURNING *`,
    [id, Boolean(active)],
  );
  return presentGuild(rows[0]);
}

export async function deleteGuild(actor, id) {
  if (actor.role !== "master") throw fail(403, "Só o mestre exclui guildas.");
  const guildId = Number(id);
  if (!Number.isInteger(guildId) || guildId < 1) throw fail(400, "Guilda inválida.");
  const guild = await findGuild(guildId);
  if (!guild) throw fail(404, "Guilda não encontrada.");

  const { rows: total } = await pool.query("SELECT count(*)::int AS n FROM guilds");
  if (total[0].n <= 1) throw fail(400, "Não dá pra excluir a única guilda da aliança.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const fallback = await client.query(
      `
      SELECT id FROM guilds
      WHERE id <> $1
      ORDER BY active DESC, id ASC
      LIMIT 1
      `,
      [guildId],
    );
    const fallbackId = fallback.rows[0]?.id;
    if (!fallbackId) throw fail(400, "Não dá pra excluir a única guilda da aliança.");

    await client.query(
      `
      UPDATE members
      SET guild_id = NULL,
          managing_guild_id = NULL,
          updated_at = now()
      WHERE guild_id = $1 OR managing_guild_id = $1
      `,
      [guildId],
    );

    // O mestre que excluiu continua na aliança, na outra guilda.
    await client.query(
      `
      UPDATE members
      SET guild_id = $2,
          managing_guild_id = $2,
          updated_at = now()
      WHERE discord_id = $1
      `,
      [actor.discord_id, fallbackId],
    );

    await client.query(`DELETE FROM activity_participants WHERE activity_id IN (SELECT id FROM activities WHERE guild_id = $1)`, [guildId]);
    await client.query(`DELETE FROM activities WHERE guild_id = $1`, [guildId]);
    await client.query(`DELETE FROM auction_favorites WHERE auction_id IN (SELECT id FROM auctions WHERE guild_id = $1)`, [guildId]);
    await client.query(`DELETE FROM auction_bids WHERE auction_id IN (SELECT id FROM auctions WHERE guild_id = $1)`, [guildId]);
    await client.query(`DELETE FROM auctions WHERE guild_id = $1`, [guildId]);
    await client.query(`DELETE FROM guilds WHERE id = $1`, [guildId]);

    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }

  return { ok: true, id: guildId };
}

export async function selectGuild(actor, guildId) {
  const id = Number(guildId);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  const guild = await findGuild(id);
  if (!guild) throw fail(404, "Guilda não encontrada.");
  if (!guild.active) throw fail(400, "Essa guilda está inativa.");

  // Só o mestre entra direto na primeira guilda; demais pedem aprovação.
  if (actor.guild_id == null) {
    if (actor.role !== "master") {
      throw fail(403, "Envie um pedido de entrada. Um oficial precisa aceitar.");
    }
    const { rows } = await pool.query(
      `
      UPDATE members
      SET guild_id = $2,
          pilot_account = false,
          managing_guild_id = CASE WHEN role IN ('master', 'admin') THEN $2 ELSE managing_guild_id END,
          updated_at = now()
      WHERE discord_id = $1
      RETURNING *
      `,
      [actor.discord_id, id],
    );
    return rows[0];
  }

  // Oficial troca a guilda em gestão (vê leilão/atividades/membros dela).
  if (isOfficer(actor)) {
    const { rows } = await pool.query(
      `
      UPDATE members
      SET managing_guild_id = $2, updated_at = now()
      WHERE discord_id = $1
      RETURNING *
      `,
      [actor.discord_id, id],
    );
    return rows[0];
  }

  throw fail(403, "Você já está em uma guilda. Fale com a administração pra trocar.");
}

export async function presentMemberWithGuild(member) {
  const base = present(member);
  const home = member.guild_id ? await findGuild(member.guild_id) : null;
  const managing = effectiveGuildId(member)
    ? await findGuild(effectiveGuildId(member))
    : null;
  return {
    ...base,
    guildId: member.guild_id == null ? null : Number(member.guild_id),
    managingGuildId: member.managing_guild_id == null ? null : Number(member.managing_guild_id),
    currentGuild: presentGuild(managing || home),
    homeGuild: presentGuild(home),
    pilotAccount: Boolean(member.pilot_account),
  };
}

const GUILD_SLOTS = 50;
const PARTICIPATION_DAYS = 7;

export async function getGuildsParticipationAverage() {
  // Mesma régua da Fate: média dos últimos 7 dias, % = participantes da guild
  // / 50 vagas (vaga sem membro = 0%), e só conta quem já estava na guild
  // quando a atividade abriu. Atividade sem participante não entra.
  // Dias de Brasília: o servidor roda em UTC.
  const today = brtToday();
  const first = brtToday(-(PARTICIPATION_DAYS - 1));
  const end = brtEndOfDay(today.year, today.month, today.day);
  const start = brtStartOfDay(first.year, first.month, first.day);

  const guilds = await pool.query(`
    SELECT g.*,
      (
        SELECT count(*)::int
        FROM members m
        WHERE m.guild_id = g.id
          AND m.pilot_account = false
      ) AS member_count
    FROM guilds g
    WHERE g.active = true
    ORDER BY g.id ASC
  `);

  const activities = await pool.query(
    `
    SELECT a.id, a.guild_id, a.starts_at,
      (
        SELECT count(*)::int
        FROM activity_participants p
        JOIN members m ON m.discord_id = p.member_discord_id
        WHERE p.activity_id = a.id
          AND m.guild_id = a.guild_id
          AND m.created_at <= a.starts_at
      ) AS participants
    FROM activities a
    WHERE a.starts_at >= $1
      AND a.starts_at <= $2
      AND a.guild_id IS NOT NULL
    `,
    [start.toISOString(), end.toISOString()],
  );

  const byGuild = new Map();
  for (const row of activities.rows) {
    const participants = Number(row.participants) || 0;
    if (participants < 1) continue;
    const gid = Number(row.guild_id);
    if (!byGuild.has(gid)) byGuild.set(gid, []);
    byGuild.get(gid).push(Math.min(100, Math.round((participants / GUILD_SLOTS) * 100)));
  }

  const out = guilds.rows.map((guild) => {
    const scores = byGuild.get(Number(guild.id)) || [];
    const percent = scores.length
      ? Math.round(scores.reduce((sum, n) => sum + n, 0) / scores.length)
      : null;
    return {
      id: Number(guild.id),
      name: guild.name,
      memberCount: Number(guild.member_count) || 0,
      slots: GUILD_SLOTS,
      activityCount: scores.length,
      percent,
    };
  });

  out.sort((a, b) => (b.percent ?? -1) - (a.percent ?? -1) || a.name.localeCompare(b.name, "pt-BR"));

  return {
    dias: PARTICIPATION_DAYS,
    from: brtDateString(first),
    to: brtDateString(today),
    guilds: out,
  };
}
