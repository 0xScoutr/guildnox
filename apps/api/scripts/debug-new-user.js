import pg from "pg";
import { getPilotContext } from "../src/pilots.js";
import { presentMemberWallet } from "../src/auctions.js";
import { presentMemberWithGuild, getPendingApplication } from "../src/guilds.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const tables = await pool.query(`
  SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('members','guilds','guild_applications','account_pilots','auctions','activities')
  ORDER BY table_name
`);
console.log("tables", tables.rows.map((r) => r.table_name));

const orphan = await pool.query(`
  SELECT discord_id, username, character_name, guild_id, role, created_at
  FROM members
  WHERE guild_id IS NULL
  ORDER BY created_at DESC
  LIMIT 10
`);
console.log("no_guild", JSON.stringify(orphan.rows, null, 2));

const recent = await pool.query(`
  SELECT discord_id, username, character_name, guild_id, role, created_at
  FROM members
  ORDER BY created_at DESC
  LIMIT 5
`);
console.log("recent", JSON.stringify(recent.rows, null, 2));

if (orphan.rows[0]) {
  const member = (await pool.query("SELECT * FROM members WHERE discord_id = $1", [orphan.rows[0].discord_id])).rows[0];
  try {
    const ctx = await getPilotContext(member);
    const wallet = await presentMemberWallet(ctx.actor);
    const withGuild = await presentMemberWithGuild(ctx.actor);
    const pending = await getPendingApplication(member.discord_id);
    console.log("presentMe_ok", {
      login: member.username,
      role: member.role,
      currentGuild: withGuild.currentGuild,
      pending,
      piloting: ctx.piloting,
      pilotInvite: ctx.invite,
      dkp: wallet.dkp,
    });
  } catch (e) {
    console.error("presentMe_fail", e.message, e.stack);
  }
}

await pool.end();
