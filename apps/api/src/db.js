import pg from "pg";

const { Pool } = pg;

function needsSsl(url) {
  return !/localhost|127\.0\.0\.1|railway\.internal/.test(url);
}

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && needsSsl(process.env.DATABASE_URL)
    ? { rejectUnauthorized: false }
    : false,
  connectionTimeoutMillis: 10000,
});

export async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      discord_id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      global_name TEXT,
      avatar TEXT,
      character_name TEXT,
      class_name TEXT,
      level INTEGER NOT NULL DEFAULT 1,
      power INTEGER NOT NULL DEFAULT 0,
      dkp INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT 'member',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS power_updated_at TIMESTAMPTZ
  `);
}

export function avatarUrl(row) {
  if (row.avatar) {
    const ext = row.avatar.startsWith("a_") ? "gif" : "png";
    return `https://cdn.discordapp.com/avatars/${row.discord_id}/${row.avatar}.${ext}`;
  }
  let index = 0;
  try {
    index = Number((BigInt(row.discord_id) >> 22n) % 6n);
  } catch {
    index = 0;
  }
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}

export function present(row) {
  return {
    discordId: row.discord_id,
    username: row.username,
    globalName: row.global_name,
    avatarUrl: avatarUrl(row),
    characterName: row.character_name,
    className: row.class_name,
    level: row.level,
    power: row.power,
    dkp: row.dkp,
    role: row.role,
    guildId: row.guild_id == null ? null : Number(row.guild_id),
    managingGuildId: row.managing_guild_id == null ? null : Number(row.managing_guild_id),
    createdAt: row.created_at,
  };
}

export async function findMember(discordId) {
  const { rows } = await pool.query(
    "SELECT * FROM members WHERE discord_id = $1",
    [discordId],
  );
  return rows[0] || null;
}

export async function countMasters() {
  const { rows } = await pool.query(
    "SELECT count(*)::int AS n FROM members WHERE role = 'master'",
  );
  return rows[0].n;
}

export async function upsertDiscordUser({ id, username, globalName, avatar }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(641184)");
    await client.query(
      `INSERT INTO members (discord_id, username, global_name, avatar)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (discord_id) DO UPDATE SET
         username = EXCLUDED.username,
         global_name = EXCLUDED.global_name,
         avatar = EXCLUDED.avatar,
         updated_at = now()`,
      [id, username, globalName, avatar],
    );
    await client.query(
      `UPDATE members
       SET role = 'master', updated_at = now()
       WHERE discord_id = $1
         AND NOT EXISTS (SELECT 1 FROM members WHERE role = 'master')`,
      [id],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return findMember(id);
}

export async function listMembers(guildId = null) {
  const { rows } = guildId == null
    ? await pool.query(`
        SELECT m.*, g.name AS guild_name
        FROM members m
        LEFT JOIN guilds g ON g.id = m.guild_id
        ORDER BY CASE m.role WHEN 'master' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 m.power DESC,
                 coalesce(m.character_name, m.global_name, m.username) ASC
      `)
    : await pool.query(
      `
        SELECT m.*, g.name AS guild_name
        FROM members m
        LEFT JOIN guilds g ON g.id = m.guild_id
        WHERE m.guild_id = $1
        ORDER BY CASE m.role WHEN 'master' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                 m.power DESC,
                 coalesce(m.character_name, m.global_name, m.username) ASC
      `,
      [guildId],
    );
  return rows;
}

export function presentMember(row) {
  return {
    ...present(row),
    guildName: row.guild_name || null,
  };
}

export async function dashboardData(viewer = null, guildId = null) {
  const stats = guildId == null
    ? await pool.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE role IN ('master', 'admin'))::int AS officers,
          coalesce(sum(dkp), 0)::bigint AS dkp,
          coalesce(round(avg(power)), 0)::int AS power_avg
        FROM members
      `)
    : await pool.query(
      `
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE role IN ('master', 'admin'))::int AS officers,
          coalesce(sum(dkp), 0)::bigint AS dkp,
          coalesce(round(avg(power)), 0)::int AS power_avg
        FROM members
        WHERE guild_id = $1
      `,
      [guildId],
    );
  const top = guildId == null
    ? await pool.query(`
        SELECT * FROM members
        ORDER BY power DESC, coalesce(character_name, global_name, username) ASC
        LIMIT 5
      `)
    : await pool.query(
      `
        SELECT * FROM members
        WHERE guild_id = $1
        ORDER BY power DESC, coalesce(character_name, global_name, username) ASC
        LIMIT 5
      `,
      [guildId],
    );
  const recent = guildId == null
    ? await pool.query(`
        SELECT * FROM members
        ORDER BY created_at DESC
        LIMIT 5
      `)
    : await pool.query(
      `
        SELECT * FROM members
        WHERE guild_id = $1
        ORDER BY created_at DESC
        LIMIT 5
      `,
      [guildId],
    );
  const row = stats.rows[0];

  let auctionHistory = [];
  let liveAuctions = 0;
  try {
    const live = guildId == null
      ? await pool.query(`
          SELECT count(*)::int AS n
          FROM auctions
          WHERE finalized_at IS NULL
            AND paused_at IS NULL
            AND starts_at <= now()
            AND expires_at > now()
        `)
      : await pool.query(
        `
          SELECT count(*)::int AS n
          FROM auctions
          WHERE guild_id = $1
            AND finalized_at IS NULL
            AND paused_at IS NULL
            AND starts_at <= now()
            AND expires_at > now()
        `,
        [guildId],
      );
    liveAuctions = live.rows[0].n;

    if (viewer?.discord_id) {
      const history = await pool.query(
        `
        SELECT
          a.id,
          a.item_name AS "itemName",
          a.quantity,
          a.finalized_at AS "finalizedAt",
          (a.image_data IS NOT NULL AND a.image_data <> '') AS "hasImage",
          top.amount,
          CASE
            WHEN a.winner_discord_id = $1 THEN 'won'
            ELSE 'bid'
          END AS kind
        FROM auctions a
        JOIN LATERAL (
          SELECT b.amount
          FROM auction_bids b
          WHERE b.auction_id = a.id
            AND b.bidder_discord_id = $1
          ORDER BY b.amount DESC, b.created_at ASC
          LIMIT 1
        ) top ON true
        WHERE a.finalized_at IS NOT NULL
          AND ($2::bigint IS NULL OR a.guild_id = $2)
        ORDER BY a.finalized_at DESC
        LIMIT 12
        `,
        [viewer.discord_id, guildId],
      );
      auctionHistory = history.rows.map((item) => ({
        id: Number(item.id),
        itemName: item.itemName,
        quantity: item.quantity,
        amount: item.amount,
        kind: item.kind,
        at: item.finalizedAt,
        hasImage: Boolean(item.hasImage),
      }));
    }
  } catch {
    auctionHistory = [];
    liveAuctions = 0;
  }

  return {
    stats: {
      total: row.total,
      officers: row.officers,
      dkp: Number(row.dkp),
      powerAvg: row.power_avg,
      liveAuctions,
    },
    top: top.rows.map(present),
    recent: recent.rows.map(present),
    auctionHistory,
  };
}

export async function expelMember(actor, targetDiscordId) {
  if (!actor) {
    const error = new Error("Não autenticado.");
    error.status = 401;
    throw error;
  }
  const officer = actor.role === "master" || actor.role === "admin";
  if (!officer) {
    const error = new Error("Só o mestre ou um admin expulsa membros.");
    error.status = 403;
    throw error;
  }
  if (actor.discord_id === targetDiscordId) {
    const error = new Error("Você não pode expulsar a si mesmo.");
    error.status = 400;
    throw error;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT * FROM members WHERE discord_id = $1 FOR UPDATE",
      [targetDiscordId],
    );
    const target = locked.rows[0];
    if (!target) {
      const error = new Error("Membro não encontrado.");
      error.status = 404;
      throw error;
    }
    if (target.role === "master") {
      const error = new Error("Não dá para expulsar o mestre. Troque o cargo antes.");
      error.status = 400;
      throw error;
    }
    if (target.role === "admin" && actor.role !== "master") {
      const error = new Error("Só o mestre expulsa um admin.");
      error.status = 403;
      throw error;
    }

    await client.query(
      "DELETE FROM activity_participants WHERE member_discord_id = $1",
      [targetDiscordId],
    );
    await client.query(
      "DELETE FROM auction_favorites WHERE member_discord_id = $1",
      [targetDiscordId],
    );
    await client.query(
      "DELETE FROM auction_bids WHERE bidder_discord_id = $1",
      [targetDiscordId],
    );
    await client.query(
      "UPDATE auctions SET winner_discord_id = NULL WHERE winner_discord_id = $1",
      [targetDiscordId],
    );
    // Mantém leilões/atividades criados por ele, mas troca o autor pro quem expulsou.
    await client.query(
      "UPDATE auctions SET created_by = $2 WHERE created_by = $1",
      [targetDiscordId, actor.discord_id],
    );
    await client.query(
      "UPDATE activities SET created_by = $2 WHERE created_by = $1",
      [targetDiscordId, actor.discord_id],
    );
    await client.query("DELETE FROM members WHERE discord_id = $1", [targetDiscordId]);

    await client.query("COMMIT");
    return { discordId: targetDiscordId };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateMember(discordId, fields) {
  const map = {
    character_name: fields.characterName,
    class_name: fields.className,
    level: fields.level,
    power: fields.power,
    dkp: fields.dkp,
    role: fields.role,
    guild_id: fields.guildId,
  };
  // Ao mudar a guilda de casa, alinha a guilda em gestão pra não ficar apontando pra outra.
  if (fields.guildId !== undefined) {
    map.managing_guild_id = fields.guildId;
  }
  if (fields.powerUpdatedAt !== undefined) {
    map.power_updated_at = fields.powerUpdatedAt;
  }
  const sets = [];
  const values = [];
  for (const [column, value] of Object.entries(map)) {
    if (value === undefined) continue;
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  }
  if (!sets.length) return findMember(discordId);
  values.push(discordId);
  sets.push("updated_at = now()");
  const { rows } = await pool.query(
    `UPDATE members SET ${sets.join(", ")} WHERE discord_id = $${values.length} RETURNING *`,
    values,
  );
  if (fields.guildId !== undefined) {
    await pool.query(
      `
      UPDATE guild_applications
      SET status = 'accepted', resolved_at = now()
      WHERE member_discord_id = $1 AND status = 'pending'
      `,
      [discordId],
    );
  }
  return rows[0] || null;
}
