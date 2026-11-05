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

export async function listMembers() {
  const { rows } = await pool.query(`
    SELECT * FROM members
    ORDER BY CASE role WHEN 'master' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
             power DESC,
             coalesce(character_name, global_name, username) ASC
  `);
  return rows;
}

export async function dashboardData(viewer = null) {
  const stats = await pool.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE role IN ('master', 'admin'))::int AS officers,
      coalesce(sum(dkp), 0)::bigint AS dkp,
      coalesce(round(avg(power)), 0)::int AS power_avg
    FROM members
  `);
  const top = await pool.query(`
    SELECT * FROM members
    ORDER BY power DESC, coalesce(character_name, global_name, username) ASC
    LIMIT 5
  `);
  const recent = await pool.query(`
    SELECT * FROM members
    ORDER BY created_at DESC
    LIMIT 5
  `);
  const row = stats.rows[0];

  let auctionHistory = [];
  let liveAuctions = 0;
  try {
    const live = await pool.query(`
      SELECT count(*)::int AS n
      FROM auctions
      WHERE finalized_at IS NULL
        AND paused_at IS NULL
        AND starts_at <= now()
        AND expires_at > now()
    `);
    liveAuctions = live.rows[0].n;

    if (viewer?.discord_id) {
      const history = await pool.query(
        `
        SELECT
          a.id,
          a.item_name AS "itemName",
          a.quantity,
          a.finalized_at AS "finalizedAt",
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
        ORDER BY a.finalized_at DESC
        LIMIT 12
        `,
        [viewer.discord_id],
      );
      auctionHistory = history.rows.map((item) => ({
        id: Number(item.id),
        itemName: item.itemName,
        quantity: item.quantity,
        amount: item.amount,
        kind: item.kind,
        at: item.finalizedAt,
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

export async function updateMember(discordId, fields) {
  const map = {
    character_name: fields.characterName,
    class_name: fields.className,
    level: fields.level,
    power: fields.power,
    dkp: fields.dkp,
    role: fields.role,
  };
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
  return rows[0] || null;
}
