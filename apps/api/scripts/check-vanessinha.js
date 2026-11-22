import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const members = await pool.query(`
  SELECT discord_id, username, global_name, character_name, created_at, guild_id
  FROM members
  WHERE lower(coalesce(character_name, global_name, username)) LIKE '%vaness%'
     OR lower(username) LIKE '%vaness%'
     OR lower(global_name) LIKE '%vaness%'
  ORDER BY created_at DESC
`);
console.log("members", JSON.stringify(members.rows, null, 2));

const acts = await pool.query(`
  SELECT id, name, starts_at, guild_id
  FROM activities
  WHERE guild_id = $1
  ORDER BY starts_at DESC
  LIMIT 10
`, [members.rows[0]?.guild_id || 3]);
console.log("recent activities", JSON.stringify(acts.rows, null, 2));
await pool.end();
