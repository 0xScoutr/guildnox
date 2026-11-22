import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const q = process.argv[2] || "charizaldoo";
const { rows } = await pool.query(
  `SELECT discord_id, username, character_name, guild_id, role, created_at, updated_at
   FROM members
   WHERE username ILIKE $1 OR character_name ILIKE $1 OR global_name ILIKE $1
   ORDER BY created_at DESC LIMIT 10`,
  [`%${q}%`],
);
console.log(JSON.stringify(rows, null, 2));
await pool.end();
