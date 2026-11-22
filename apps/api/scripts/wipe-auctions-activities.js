import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const before = await client.query(`
    SELECT
      (SELECT count(*)::int FROM auctions) AS auctions,
      (SELECT count(*)::int FROM auction_bids) AS bids,
      (SELECT count(*)::int FROM auction_favorites) AS favorites,
      (SELECT count(*)::int FROM activities) AS activities,
      (SELECT count(*)::int FROM activity_participants) AS participants
  `);
  console.log("before", before.rows[0]);

  await client.query("DELETE FROM auction_favorites");
  await client.query("DELETE FROM auction_bids");
  await client.query("DELETE FROM auctions");
  await client.query("DELETE FROM activity_participants");
  await client.query("DELETE FROM activities");

  const after = await client.query(`
    SELECT
      (SELECT count(*)::int FROM auctions) AS auctions,
      (SELECT count(*)::int FROM auction_bids) AS bids,
      (SELECT count(*)::int FROM auction_favorites) AS favorites,
      (SELECT count(*)::int FROM activities) AS activities,
      (SELECT count(*)::int FROM activity_participants) AS participants
  `);
  console.log("after", after.rows[0]);

  await client.query("COMMIT");
  console.log("ok");
} catch (error) {
  try { await client.query("ROLLBACK"); } catch { /* ignore */ }
  console.error(error);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
