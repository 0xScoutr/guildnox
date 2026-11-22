import pg from "pg";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const before = await pool.query("SELECT id, name FROM guilds ORDER BY id");
console.log("before", JSON.stringify(before.rows));

const targets = [
  { re: /^chapa\s*1$/i, to: "NOX I" },
  { re: /^chapa\s*2$/i, to: "NOX II" },
  { re: /^chapa\s*3$/i, to: "NOX III" },
];

for (const row of before.rows) {
  const hit = targets.find((t) => t.re.test(String(row.name || "").trim()));
  if (!hit) continue;
  const exists = await pool.query(
    "SELECT 1 FROM guilds WHERE lower(name) = lower($1) AND id <> $2 LIMIT 1",
    [hit.to, row.id],
  );
  if (exists.rowCount) {
    console.log("skip", row.name, "target exists", hit.to);
    continue;
  }
  await pool.query("UPDATE guilds SET name = $1 WHERE id = $2", [hit.to, row.id]);
  console.log("renamed", row.id, row.name, "->", hit.to);
}

const after = await pool.query("SELECT id, name FROM guilds ORDER BY id");
console.log("after", JSON.stringify(after.rows));
await pool.end();
