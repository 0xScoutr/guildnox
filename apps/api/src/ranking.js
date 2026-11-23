import { brtEndOfDay, brtStartOfDay, brtToday } from "./brt-time.js";
import { pool, present } from "./db.js";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function nickOf(member) {
  return member.character_name || member.global_name || member.username;
}

// Os dias do ranking são os de Brasília (o servidor roda em UTC).
function parseDay(value, label) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw fail(400, `${label} inválida.`);
  const day = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const check = new Date(Date.UTC(day.year, day.month - 1, day.day));
  if (check.getUTCMonth() !== day.month - 1 || check.getUTCDate() !== day.day) throw fail(400, `${label} inválida.`);
  return day;
}

function defaultRange() {
  const today = brtToday();
  const first = brtToday(-9);
  return {
    start: brtStartOfDay(first.year, first.month, first.day),
    end: brtEndOfDay(today.year, today.month, today.day),
  };
}

export async function getRanking(query = {}, guildId = null) {
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  let start;
  let end;
  if (query.from || query.to) {
    const from = parseDay(query.from, "Data inicial");
    const to = parseDay(query.to, "Data final");
    if (!from || !to) throw fail(400, "Informe as duas datas do período.");
    start = brtStartOfDay(from.year, from.month, from.day);
    end = brtEndOfDay(to.year, to.month, to.day);
    if (start > end) throw fail(400, "A data inicial não pode ser depois da final.");
  } else {
    ({ start, end } = defaultRange());
  }

  const members = await pool.query(
    `
    SELECT * FROM members
    WHERE guild_id = $1
    ORDER BY coalesce(character_name, global_name, username) ASC
    `,
    [guildId],
  );

  const activities = await pool.query(
    `
    SELECT id, starts_at
    FROM activities
    WHERE guild_id = $3
      AND starts_at >= $1 AND starts_at <= $2
      -- Boss que ainda não aconteceu não entra na conta (senão todo mundo cai de 100%).
      AND starts_at <= now()
    ORDER BY starts_at ASC
    `,
    [start.toISOString(), end.toISOString(), guildId],
  );

  const activityIds = activities.rows.map((row) => Number(row.id));
  const totalCount = activityIds.length;
  const lastActivityAt = activities.rows.length
    ? new Date(activities.rows[activities.rows.length - 1].starts_at)
    : null;

  const participation = new Map();
  if (activityIds.length) {
    const parts = await pool.query(
      `
      SELECT member_discord_id, count(*)::int AS n
      FROM activity_participants
      WHERE activity_id = ANY($1::bigint[])
      GROUP BY member_discord_id
      `,
      [activityIds],
    );
    for (const row of parts.rows) participation.set(row.member_discord_id, row.n);
  }

  const reserved = new Map();
  const reservedRows = await pool.query(
    `
    SELECT top.bidder_discord_id AS discord_id, coalesce(sum(top.amount), 0)::int AS reserved
    FROM auctions a
    JOIN LATERAL (
      SELECT b.amount, b.bidder_discord_id
      FROM auction_bids b
      WHERE b.auction_id = a.id
      ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
      LIMIT 1
    ) top ON true
    WHERE a.guild_id = $1
      AND a.finalized_at IS NULL
      AND a.starts_at <= now()
      AND (
        a.paused_at IS NOT NULL
        OR a.expires_at > now()
      )
    GROUP BY top.bidder_discord_id
    `,
    [guildId],
  );
  for (const row of reservedRows.rows) reserved.set(row.discord_id, row.reserved);

  return {
    weekStart: start.toISOString(),
    weekEnd: end.toISOString(),
    members: members.rows.map((row) => {
      const member = present(row);
      const joinedAfter = lastActivityAt && new Date(row.created_at) > lastActivityAt;
      const participatedCount = participation.get(row.discord_id) || 0;
      let percent = null;
      if (totalCount > 0 && !joinedAfter) {
        percent = Math.round((participatedCount / totalCount) * 100);
      } else if (totalCount === 0) {
        percent = null;
      }
      const held = reserved.get(row.discord_id) || 0;

      return {
        discordId: member.discordId,
        nick: nickOf(row),
        className: member.className || "—",
        level: member.level,
        dkp: Math.max(0, member.dkp - held),
        power: member.power,
        photo: member.avatarUrl,
        totalCount,
        participatedCount,
        percent: totalCount === 0 ? null : percent,
      };
    }),
  };
}
