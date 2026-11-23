import { pool } from "./db.js";

/** Mesma regra das atividades: base + 0,0015% do power (só para backfill). */
function estimateActivityAward(baseDkp, power) {
  const base = Math.max(0, Number(baseDkp) || 0);
  const rawPower = Math.max(0, Number(power) || 0);
  return Math.max(0, Math.round(base + rawPower * 0.000015));
}

export async function migrateDkpLedger() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dkp_ledger (
      id BIGSERIAL PRIMARY KEY,
      member_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL,
      reason TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      ref_type TEXT,
      ref_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS dkp_ledger_member_created_idx
    ON dkp_ledger (member_discord_id, created_at DESC, id DESC)
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS dkp_ledger_ref_unique
    ON dkp_ledger (member_discord_id, ref_type, ref_id)
    WHERE ref_type IS NOT NULL AND ref_id IS NOT NULL
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS dkp_ledger_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
  await backfillDkpLedger();
}

/**
 * Aplica delta de DKP e grava no histórico (mesma transação do client).
 * Se amount for 0, não altera nada.
 */
export async function applyDkpDelta(client, {
  discordId,
  amount,
  reason,
  label = "",
  refType = null,
  refId = null,
  createdAt = null,
}) {
  const delta = Math.trunc(Number(amount) || 0);
  if (!delta) return { amount: 0, balanceAfter: null };

  const locked = await client.query(
    "SELECT dkp FROM members WHERE discord_id = $1 FOR UPDATE",
    [discordId],
  );
  if (!locked.rows[0]) {
    const err = new Error("Membro não encontrado.");
    err.status = 404;
    throw err;
  }

  if (refType && refId) {
    const dup = await client.query(
      `
      SELECT 1 FROM dkp_ledger
      WHERE member_discord_id = $1 AND ref_type = $2 AND ref_id = $3
      `,
      [discordId, refType, refId],
    );
    if (dup.rowCount > 0) {
      return { amount: 0, balanceAfter: Number(locked.rows[0].dkp) };
    }
  }

  const next = Number(locked.rows[0].dkp) + delta;
  await client.query(
    "UPDATE members SET dkp = $1, updated_at = now() WHERE discord_id = $2",
    [next, discordId],
  );

  if (createdAt) {
    await client.query(
      `
      INSERT INTO dkp_ledger
        (member_discord_id, amount, balance_after, reason, label, ref_type, ref_id, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      [discordId, delta, next, reason, label, refType, refId, createdAt],
    );
  } else {
    await client.query(
      `
      INSERT INTO dkp_ledger
        (member_discord_id, amount, balance_after, reason, label, ref_type, ref_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [discordId, delta, next, reason, label, refType, refId],
    );
  }

  return { amount: delta, balanceAfter: next };
}

/**
 * Define DKP absoluto (edição de oficial) e registra a diferença.
 * Com expectedDkp, só grava se o saldo ainda for o que o oficial viu ao abrir a
 * ficha; senão um check-in ou leilão cobrado no meio seria apagado sem ninguém ver.
 */
export async function setDkpAbsolute(client, {
  discordId,
  nextDkp,
  expectedDkp = null,
  reason = "adjustment",
  label = "Ajuste manual",
}) {
  const locked = await client.query(
    "SELECT dkp FROM members WHERE discord_id = $1 FOR UPDATE",
    [discordId],
  );
  if (!locked.rows[0]) {
    const err = new Error("Membro não encontrado.");
    err.status = 404;
    throw err;
  }
  const current = Number(locked.rows[0].dkp);
  if (expectedDkp != null && current !== Number(expectedDkp)) {
    const err = new Error(`O DKP mudou desde que a ficha foi aberta (agora está em ${current}). Confira e salve de novo.`);
    err.status = 409;
    err.data = { currentDkp: current };
    throw err;
  }
  const target = Math.trunc(Number(nextDkp));
  const delta = target - current;
  if (!delta) return { amount: 0, balanceAfter: current };

  await client.query(
    "UPDATE members SET dkp = $1, updated_at = now() WHERE discord_id = $2",
    [target, discordId],
  );
  await client.query(
    `
    INSERT INTO dkp_ledger
      (member_discord_id, amount, balance_after, reason, label, ref_type, ref_id)
    VALUES ($1, $2, $3, $4, $5, NULL, NULL)
    `,
    [discordId, delta, target, reason, label],
  );
  return { amount: delta, balanceAfter: target };
}

export function presentLedgerEntry(row) {
  return {
    id: Number(row.id),
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    reason: row.reason,
    label: row.label || "",
    refType: row.ref_type || null,
    refId: row.ref_id || null,
    createdAt: row.created_at,
  };
}

export async function listDkpHistory(discordId, { limit = 100 } = {}) {
  await backfillDkpLedger();
  const capped = Math.min(200, Math.max(1, Number(limit) || 100));
  const { rows } = await pool.query(
    `
    SELECT *
    FROM dkp_ledger
    WHERE member_discord_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT $2
    `,
    [discordId, capped],
  );
  return rows.map(presentLedgerEntry);
}

async function backfillDkpLedger() {
  const flag = await pool.query(
    "SELECT value FROM dkp_ledger_meta WHERE key = 'backfilled_v1'",
  );
  if (flag.rows[0]?.value === "1") return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const again = await client.query(
      "SELECT value FROM dkp_ledger_meta WHERE key = 'backfilled_v1' FOR UPDATE",
    );
    if (again.rows[0]?.value === "1") {
      await client.query("COMMIT");
      return;
    }

    // Não mexe no saldo atual dos membros — só reconstrói o histórico.
    const members = await client.query("SELECT discord_id, power, dkp FROM members");
    const eventsByMember = new Map();
    for (const m of members.rows) eventsByMember.set(m.discord_id, []);

    const parts = await client.query(`
      SELECT p.member_discord_id, p.activity_id, p.created_at, a.name, a.dkp_value, m.power
      FROM activity_participants p
      JOIN activities a ON a.id = p.activity_id
      JOIN members m ON m.discord_id = p.member_discord_id
      ORDER BY p.created_at ASC, p.activity_id ASC
    `);
    for (const row of parts.rows) {
      const amount = estimateActivityAward(row.dkp_value, row.power);
      if (!amount) continue;
      eventsByMember.get(row.member_discord_id)?.push({
        amount,
        reason: "activity",
        label: row.name,
        refType: "activity",
        refId: String(row.activity_id),
        createdAt: row.created_at,
      });
    }

    const wins = await client.query(`
      SELECT a.id, a.item_name, a.winner_discord_id, a.finalized_at, b.amount
      FROM auctions a
      JOIN LATERAL (
        SELECT amount
        FROM auction_bids
        WHERE auction_id = a.id AND bidder_discord_id = a.winner_discord_id
        ORDER BY amount DESC, created_at ASC, id ASC
        LIMIT 1
      ) b ON true
      WHERE a.finalized_at IS NOT NULL
        AND a.winner_discord_id IS NOT NULL
      ORDER BY a.finalized_at ASC, a.id ASC
    `);
    for (const row of wins.rows) {
      const amount = -Math.abs(Number(row.amount) || 0);
      if (!amount) continue;
      eventsByMember.get(row.winner_discord_id)?.push({
        amount,
        reason: "auction",
        label: row.item_name,
        refType: "auction",
        refId: String(row.id),
        createdAt: row.finalized_at,
      });
    }

    for (const member of members.rows) {
      const events = eventsByMember.get(member.discord_id) || [];
      events.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

      const summed = events.reduce((sum, event) => sum + event.amount, 0);
      const actual = Number(member.dkp);
      const gap = actual - summed;
      if (gap !== 0) {
        const firstAt = events[0]?.createdAt
          ? new Date(new Date(events[0].createdAt).getTime() - 1000)
          : new Date();
        events.unshift({
          amount: gap,
          reason: "opening",
          label: gap > 0 ? "Saldo anterior" : "Ajuste de saldo",
          refType: "opening",
          refId: member.discord_id,
          createdAt: firstAt.toISOString(),
        });
      }

      let running = 0;
      for (const event of events) {
        running += event.amount;
        await client.query(
          `
          INSERT INTO dkp_ledger
            (member_discord_id, amount, balance_after, reason, label, ref_type, ref_id, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT DO NOTHING
          `,
          [
            member.discord_id,
            event.amount,
            running,
            event.reason,
            event.label,
            event.refType,
            event.refId,
            event.createdAt,
          ],
        );
      }
    }

    await client.query(
      `
      INSERT INTO dkp_ledger_meta (key, value) VALUES ('backfilled_v1', '1')
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `,
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}
