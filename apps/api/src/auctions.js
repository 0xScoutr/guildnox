import { pool, present } from "./db.js";

function fail(status, message, data = {}) {
  const error = new Error(message);
  error.status = status;
  error.data = data;
  return error;
}

function nickOf(member) {
  return member.character_name || member.global_name || member.username;
}

function minNextBid(startingBid, currentBid) {
  if (currentBid == null) return startingBid;
  return Math.max(currentBid + 1, Math.ceil(currentBid * 1.2));
}

function computeStatus(row, now = Date.now()) {
  if (row.finalized_at || row.status_forced === "ended") return "ended";
  if (row.paused_at) return "paused";
  const starts = new Date(row.starts_at).getTime();
  const ends = new Date(row.expires_at).getTime();
  if (now < starts) return "upcoming";
  if (now >= ends) return "ended";
  return "live";
}

export async function migrateAuctions() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auctions (
      id BIGSERIAL PRIMARY KEY,
      item_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      starting_bid INTEGER NOT NULL CHECK (starting_bid >= 1),
      starts_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      reset_minutes INTEGER NOT NULL DEFAULT 2 CHECK (reset_minutes >= 0 AND reset_minutes <= 120),
      quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity >= 1 AND quantity <= 9999),
      paused_at TIMESTAMPTZ,
      finalized_at TIMESTAMPTZ,
      winner_discord_id TEXT REFERENCES members(discord_id),
      created_by TEXT NOT NULL REFERENCES members(discord_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auction_bids (
      id BIGSERIAL PRIMARY KEY,
      auction_id BIGINT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
      bidder_discord_id TEXT NOT NULL REFERENCES members(discord_id),
      amount INTEGER NOT NULL CHECK (amount >= 1),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS auction_bids_auction_id_idx ON auction_bids(auction_id, created_at DESC)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS auctions_expires_at_idx ON auctions(expires_at)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS auction_favorites (
      auction_id BIGINT NOT NULL REFERENCES auctions(id) ON DELETE CASCADE,
      member_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (auction_id, member_discord_id)
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS auction_favorites_member_idx
    ON auction_favorites(member_discord_id, created_at DESC)
  `);
}

export async function reservedDkp(discordId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT coalesce(sum(top.amount), 0)::int AS reserved
    FROM auctions a
    JOIN LATERAL (
      SELECT b.amount, b.bidder_discord_id
      FROM auction_bids b
      WHERE b.auction_id = a.id
      ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
      LIMIT 1
    ) top ON true
    WHERE a.finalized_at IS NULL
      AND a.starts_at <= now()
      AND top.bidder_discord_id = $1
      AND (
        a.paused_at IS NOT NULL
        OR a.expires_at > now()
      )
    `,
    [discordId],
  );
  return rows[0].reserved;
}

export async function availableDkp(member, client = pool) {
  const reserved = await reservedDkp(member.discord_id, client);
  return Math.max(0, member.dkp - reserved);
}

export async function presentMemberWallet(member) {
  const reserved = await reservedDkp(member.discord_id);
  return {
    ...present(member),
    dkpTotal: member.dkp,
    dkp: Math.max(0, member.dkp - reserved),
    reservedDkp: reserved,
  };
}

async function loadAuctionRow(id, client = pool) {
  const { rows } = await client.query("SELECT * FROM auctions WHERE id = $1", [id]);
  return rows[0] || null;
}

async function topBid(auctionId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT b.*, m.character_name, m.global_name, m.username
    FROM auction_bids b
    JOIN members m ON m.discord_id = b.bidder_discord_id
    WHERE b.auction_id = $1
    ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
    LIMIT 1
    `,
    [auctionId],
  );
  return rows[0] || null;
}

async function listBids(auctionId, client = pool) {
  const { rows } = await client.query(
    `
    SELECT b.id, b.amount, b.created_at, b.bidder_discord_id,
           m.character_name, m.global_name, m.username
    FROM auction_bids b
    JOIN members m ON m.discord_id = b.bidder_discord_id
    WHERE b.auction_id = $1
    ORDER BY b.amount DESC, b.created_at ASC, b.id ASC
    LIMIT 20
    `,
    [auctionId],
  );
  return rows;
}

async function finalizeIfNeeded(row, client = pool) {
  if (!row || row.finalized_at) return row;
  const status = computeStatus(row);
  if (status !== "ended") return row;

  await client.query("BEGIN");
  try {
    const locked = await client.query(
      "SELECT * FROM auctions WHERE id = $1 FOR UPDATE",
      [row.id],
    );
    const auction = locked.rows[0];
    if (!auction || auction.finalized_at) {
      await client.query("COMMIT");
      return auction || row;
    }
    if (computeStatus(auction) !== "ended") {
      await client.query("COMMIT");
      return auction;
    }

    const winner = await topBid(auction.id, client);
    if (winner) {
      const member = await client.query(
        "SELECT * FROM members WHERE discord_id = $1 FOR UPDATE",
        [winner.bidder_discord_id],
      );
      const payer = member.rows[0];
      if (payer) {
        const next = Math.max(0, payer.dkp - winner.amount);
        await client.query(
          "UPDATE members SET dkp = $1, updated_at = now() WHERE discord_id = $2",
          [next, payer.discord_id],
        );
      }
      await client.query(
        `
        UPDATE auctions
        SET finalized_at = now(), winner_discord_id = $2
        WHERE id = $1
        `,
        [auction.id, winner.bidder_discord_id],
      );
    } else {
      await client.query(
        "UPDATE auctions SET finalized_at = now() WHERE id = $1",
        [auction.id],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  return loadAuctionRow(row.id, client);
}

function presentAuction(row, top, viewerId, { hasYourBid = false, isFavorite = false } = {}) {
  const status = computeStatus(row);
  const currentBid = top ? top.amount : null;
  return {
    id: Number(row.id),
    itemName: row.item_name,
    description: row.description,
    startingBid: row.starting_bid,
    startsAt: row.starts_at,
    expiresAt: row.expires_at,
    effectiveExpiresAt: row.expires_at,
    resetMinutes: row.reset_minutes,
    quantity: row.quantity,
    pausedAt: row.paused_at,
    finalizedAt: row.finalized_at,
    createdAt: row.created_at,
    status,
    currentBid,
    highestBidderNick: top ? nickOf(top) : null,
    highestBidderId: top ? top.bidder_discord_id : null,
    minNextBid: minNextBid(row.starting_bid, currentBid),
    youAreHighestBidder: Boolean(top && top.bidder_discord_id === viewerId),
    hasYourBid,
    isFavorite,
    winnerDiscordId: row.winner_discord_id,
  };
}

async function favoriteIdsFor(viewerId, auctionIds, client = pool) {
  if (!auctionIds.length) return new Set();
  const { rows } = await client.query(
    `
    SELECT auction_id
    FROM auction_favorites
    WHERE member_discord_id = $1
      AND auction_id = ANY($2::bigint[])
    `,
    [viewerId, auctionIds],
  );
  return new Set(rows.map((row) => Number(row.auction_id)));
}

async function isFavoriteAuction(auctionId, viewerId, client = pool) {
  const { rowCount } = await client.query(
    `
    SELECT 1 FROM auction_favorites
    WHERE auction_id = $1 AND member_discord_id = $2
    LIMIT 1
    `,
    [auctionId, viewerId],
  );
  return rowCount > 0;
}

export async function listAuctions(viewer) {
  const { rows } = await pool.query("SELECT * FROM auctions ORDER BY created_at DESC LIMIT 300");
  const out = [];
  const ids = [];
  for (const row of rows) {
    const fresh = await finalizeIfNeeded(row);
    ids.push(Number(fresh.id));
    const top = await topBid(fresh.id);
    const yours = await pool.query(
      `
      SELECT 1 FROM auction_bids
      WHERE auction_id = $1 AND bidder_discord_id = $2
      LIMIT 1
      `,
      [fresh.id, viewer.discord_id],
    );
    out.push({
      fresh,
      top,
      hasYourBid: yours.rowCount > 0,
    });
  }
  const favorites = await favoriteIdsFor(viewer.discord_id, ids);
  return out.map(({ fresh, top, hasYourBid }) => presentAuction(fresh, top, viewer.discord_id, {
    hasYourBid,
    isFavorite: favorites.has(Number(fresh.id)),
  }));
}

export async function getAuction(id, viewer) {
  let row = await loadAuctionRow(id);
  if (!row) throw fail(404, "Leilão não encontrado.");
  row = await finalizeIfNeeded(row);
  const top = await topBid(row.id);
  const bids = await listBids(row.id);
  const yours = bids.some((b) => b.bidder_discord_id === viewer.discord_id);
  const detail = presentAuction(row, top, viewer.discord_id, {
    hasYourBid: yours,
    isFavorite: await isFavoriteAuction(row.id, viewer.discord_id),
  });
  return {
    ...detail,
    yourAvailableDkp: await availableDkp(viewer),
    bids: bids.map((b) => ({
      id: Number(b.id),
      nick: nickOf(b),
      amount: b.amount,
      createdAt: b.created_at,
      yours: b.bidder_discord_id === viewer.discord_id,
    })),
  };
}

export async function setAuctionFavorite(viewer, id, favorite) {
  const row = await loadAuctionRow(id);
  if (!row) throw fail(404, "Leilão não encontrado.");
  if (favorite) {
    await pool.query(
      `
      INSERT INTO auction_favorites (auction_id, member_discord_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
      [id, viewer.discord_id],
    );
  } else {
    await pool.query(
      `
      DELETE FROM auction_favorites
      WHERE auction_id = $1 AND member_discord_id = $2
      `,
      [id, viewer.discord_id],
    );
  }
  return getAuction(id, viewer);
}

export async function createAuction(actor, body) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin cria leilão.");
  }
  const itemName = String(body.itemName || "").trim();
  if (!itemName || itemName.length > 80) throw fail(400, "Informe o nome do item.");
  const description = String(body.description || "").trim().slice(0, 500);
  const startingBid = Number(body.startingBid);
  const quantity = Number(body.quantity || 1);
  const resetMinutes = Number(body.resetMinutes ?? 2);
  if (!Number.isInteger(startingBid) || startingBid < 1 || startingBid > 1000000) {
    throw fail(400, "Lance inicial inválido.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    throw fail(400, "Quantidade inválida.");
  }
  if (!Number.isInteger(resetMinutes) || resetMinutes < 0 || resetMinutes > 120) {
    throw fail(400, "Minutos de extensão inválidos.");
  }

  const startsAt = body.startsAt ? new Date(body.startsAt) : new Date();
  const durationMinutes = Number(body.durationMinutes || 30);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 7 * 24 * 60) {
    throw fail(400, "Duração inválida.");
  }
  if (Number.isNaN(startsAt.getTime())) throw fail(400, "Início inválido.");
  const expiresAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);

  const { rows } = await pool.query(
    `
    INSERT INTO auctions
      (item_name, description, starting_bid, starts_at, expires_at, reset_minutes, quantity, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    RETURNING *
    `,
    [itemName, description, startingBid, startsAt.toISOString(), expiresAt.toISOString(), resetMinutes, quantity, actor.discord_id],
  );
  return getAuction(rows[0].id, actor);
}

export async function setAuctionPaused(actor, id, paused) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin pausa leilão.");
  }
  const row = await loadAuctionRow(id);
  if (!row) throw fail(404, "Leilão não encontrado.");
  if (row.finalized_at) throw fail(400, "Esse leilão já encerrou.");
  if (paused) {
    await pool.query("UPDATE auctions SET paused_at = now() WHERE id = $1", [id]);
  } else {
    await pool.query(
      `
      UPDATE auctions
      SET paused_at = NULL,
          expires_at = expires_at + (now() - paused_at)
      WHERE id = $1 AND paused_at IS NOT NULL
      `,
      [id],
    );
  }
  return getAuction(id, actor);
}

export async function placeBid(actor, id, amount) {
  if (!Number.isInteger(amount) || amount < 1 || amount > 1000000) {
    throw fail(400, "Informe um valor de lance válido.", { error: "invalid_amount" });
  }

  const client = await pool.connect();
  let shouldFinalize = null;
  let thrown = null;
  try {
    await client.query("BEGIN");
    const locked = await client.query("SELECT * FROM auctions WHERE id = $1 FOR UPDATE", [id]);
    const auction = locked.rows[0];
    if (!auction) throw fail(404, "Leilão não encontrado.");

    const status = computeStatus(auction);
    if (status === "ended" || auction.finalized_at) {
      shouldFinalize = auction.finalized_at ? null : auction;
      throw fail(400, "Esse leilão já encerrou.", { error: "ended" });
    }
    if (status === "upcoming") throw fail(400, "Esse leilão ainda não começou.", { error: "not_started" });
    if (status === "paused") throw fail(400, "Esse leilão está pausado no momento.", { error: "paused" });

    const top = await topBid(auction.id, client);
    if (top && top.bidder_discord_id === actor.discord_id) {
      throw fail(400, "Você já está com o lance mais alto neste leilão.", { error: "own_bid" });
    }

    const min = minNextBid(auction.starting_bid, top ? top.amount : null);
    if (amount < min) {
      throw fail(400, `O lance mínimo agora é ${min} DKP.`, {
        error: "bid_too_low",
        minRequired: min,
      });
    }

    const memberRes = await client.query(
      "SELECT * FROM members WHERE discord_id = $1 FOR UPDATE",
      [actor.discord_id],
    );
    const member = memberRes.rows[0];
    if (!member) throw fail(400, "Não foi possível identificar seu personagem.", { error: "no_character" });

    const available = await availableDkp(member, client);
    if (amount > available) {
      throw fail(400, `Você só tem ${available} DKP disponível agora.`, {
        error: "insufficient_dkp",
        available,
      });
    }

    await client.query(
      `
      INSERT INTO auction_bids (auction_id, bidder_discord_id, amount)
      VALUES ($1, $2, $3)
      `,
      [auction.id, actor.discord_id, amount],
    );

    const remainingMs = new Date(auction.expires_at).getTime() - Date.now();
    const resetMs = auction.reset_minutes * 60 * 1000;
    if (resetMs > 0 && remainingMs < resetMs) {
      const nextExpires = new Date(Date.now() + resetMs).toISOString();
      await client.query("UPDATE auctions SET expires_at = $2 WHERE id = $1", [auction.id, nextExpires]);
    }

    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    thrown = error;
  } finally {
    client.release();
  }

  if (shouldFinalize) await finalizeIfNeeded(shouldFinalize);
  if (thrown) throw thrown;
  return getAuction(id, actor);
}

