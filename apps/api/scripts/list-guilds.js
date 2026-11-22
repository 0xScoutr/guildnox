import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const { rows } = await pool.query("SELECT id, name FROM guilds ORDER BY id");
console.log(JSON.stringify(rows));
await pool.end();
