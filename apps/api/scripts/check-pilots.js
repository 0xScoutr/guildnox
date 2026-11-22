import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const links = await pool.query(`
  SELECT p.id, p.status, p.created_at,
         o.username AS owner_user, o.character_name AS owner_nick,
         m.username AS pilot_user, m.character_name AS pilot_nick
  FROM account_pilots p
  JOIN members o ON o.discord_id = p.owner_discord_id
  JOIN members m ON m.discord_id = p.pilot_discord_id
  ORDER BY p.created_at DESC
  LIMIT 20
`);
console.log(JSON.stringify(links.rows, null, 2));
await pool.end();
