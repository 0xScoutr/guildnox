import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const pending = await pool.query(`
  SELECT a.id, a.status, a.created_at, g.name AS guild, m.username
  FROM guild_applications a
  JOIN guilds g ON g.id = a.guild_id
  JOIN members m ON m.discord_id = a.member_discord_id
  WHERE a.status = 'pending'
  ORDER BY a.created_at DESC
  LIMIT 30
`);
console.log("pending_count", pending.rowCount);
console.log(JSON.stringify(pending.rows, null, 2));
const rejected = await pool.query(`
  SELECT count(*)::int AS n FROM guild_applications WHERE status = 'rejected'
`);
const accepted = await pool.query(`
  SELECT count(*)::int AS n FROM guild_applications WHERE status = 'accepted'
`);
console.log("accepted", accepted.rows[0].n, "rejected", rejected.rows[0].n);
await pool.end();
