import { pool, present } from "./db.js";

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function nickOf(member) {
  return member.character_name || member.global_name || member.username;
}

function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function parseDay(value, label) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw fail(400, `${label} inválida.`);
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) throw fail(400, `${label} inválida.`);
  return date;
}

function defaultRange() {
  const end = endOfDay(new Date());
  const start = startOfDay(new Date());
  start.setDate(start.getDate() - 9);
  return { start, end };
}

export async function getRanking(query = {}, guildId = null) {
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  let start;
  let end;
  if (query.from || query.to) {
    const from = parseDay(query.from, "Data inicial");
    const to = parseDay(query.to, "Data final");
    if (!from || !to) throw fail(400, "Informe as duas datas do período.");
    if (from > to) throw fail(400, "A data inicial não pode ser depois da final.");
    start = startOfDay(from);
    end = endOfDay(to);
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
