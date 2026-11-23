import { applyDkpDelta } from "./dkp-ledger.js";
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
  return currentBid + 1;
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
  await pool.query(`
    ALTER TABLE auctions
    ADD COLUMN IF NOT EXISTS image_data TEXT
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

/**
 * Encerra o leilão vencido e cobra o vencedor, numa transação de verdade.
 *
 * Antes isto rodava BEGIN, SELECT ... FOR UPDATE e COMMIT direto no pool, e cada
 * comando ia para uma conexão diferente: o lock não segurava nada, duas abas
 * abertas podiam cobrar o mesmo leilão juntas e um BEGIN ficava esquecido numa
 * conexão do pool, levando junto o trabalho de outras pessoas.
 */
async function finalizeIfNeeded(row) {
  if (!row || row.finalized_at) return row;
  if (computeStatus(row) !== "ended") return row;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query(
      "SELECT * FROM auctions WHERE id = $1 FOR UPDATE",
      [row.id],
    );
    const auction = locked.rows[0];
    if (!auction || auction.finalized_at || computeStatus(auction) !== "ended") {
      await client.query("COMMIT");
      return auction || row;
    }

    const winner = await topBid(auction.id, client);
    if (winner) {
      const member = await client.query(
        "SELECT * FROM members WHERE discord_id = $1 FOR UPDATE",
        [winner.bidder_discord_id],
      );
      const payer = member.rows[0];
      if (payer) {
        const charge = Math.min(Number(payer.dkp), Number(winner.amount));
        if (charge > 0) {
          await applyDkpDelta(client, {
            discordId: payer.discord_id,
            amount: -charge,
            reason: "auction",
            label: auction.item_name || `Leilão #${auction.id}`,
            refType: "auction",
            refId: String(auction.id),
          });
        }
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
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
  return loadAuctionRow(row.id);
}

const IMAGE_DATA_MAX = 450_000;
const IMAGE_DATA_RE = /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function normalizeImageData(value) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw fail(400, "Foto do item inválida.");
  const imageData = value.trim().replace(/\s+/g, "");
  if (!imageData) return null;
  if (!IMAGE_DATA_RE.test(imageData)) {
    throw fail(400, "Use uma imagem JPG, PNG ou WEBP.");
  }
  if (imageData.length > IMAGE_DATA_MAX) {
    throw fail(400, "A foto ficou grande demais. Escolha outra ou uma menor.");
  }
  return imageData;
}

function presentAuction(row, top, viewerId, { hasYourBid = false, isFavorite = false, includeImage = false } = {}) {
  const status = computeStatus(row);
  const currentBid = top ? top.amount : null;
  const hasImage = Boolean(row.has_image ?? row.image_data);
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
    hasImage,
    imageData: includeImage && row.image_data ? row.image_data : null,
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

export async function listAuctions(viewer, guildId) {
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  const { rows } = await pool.query(
    `
    SELECT id, item_name, description, starting_bid, starts_at, expires_at, reset_minutes,
           quantity, paused_at, finalized_at, winner_discord_id, created_by, created_at, guild_id,
           (image_data IS NOT NULL AND image_data <> '') AS has_image
    FROM auctions
    WHERE guild_id = $1
    ORDER BY created_at DESC
    LIMIT 300
    `,
    [guildId],
  );
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

export async function assertAuctionGuild(row, guildId) {
  if (!row) throw fail(404, "Leilão não encontrado.");
  if (guildId != null && Number(row.guild_id) !== Number(guildId)) {
    throw fail(404, "Leilão não encontrado.");
  }
  return row;
}

export async function getAuction(id, viewer, guildId = null) {
  let row = await loadAuctionRow(id);
  await assertAuctionGuild(row, guildId);
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

export async function createAuction(actor, body, guildId) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin cria leilão.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");
  const itemName = String(body.itemName || "").trim();
  if (!itemName || itemName.length > 80) throw fail(400, "Informe o nome do item.");
  const description = String(body.description || "").trim().slice(0, 500);
  const imageData = normalizeImageData(body.imageData);
  const startingBid = Number(body.startingBid);
  const quantity = Number(body.quantity || 1);
  const copies = Number(body.copies ?? 1);
  const resetMinutes = Number(body.resetMinutes ?? 2);
  if (!Number.isInteger(startingBid) || startingBid < 1 || startingBid > 1000000) {
    throw fail(400, "Lance inicial inválido.");
  }
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
    throw fail(400, "Quantidade inválida.");
  }
  if (!Number.isInteger(copies) || copies < 1 || copies > 50) {
    throw fail(400, "Informe entre 1 e 50 leilões iguais.");
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
  const startsIso = startsAt.toISOString();
  const expiresIso = expiresAt.toISOString();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [];
    for (let i = 0; i < copies; i += 1) {
      const { rows } = await client.query(
        `
        INSERT INTO auctions
          (item_name, description, starting_bid, starts_at, expires_at, reset_minutes, quantity, created_by, guild_id, image_data)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING id
        `,
        [itemName, description, startingBid, startsIso, expiresIso, resetMinutes, quantity, actor.discord_id, guildId, imageData],
      );
      created.push(rows[0].id);
    }
    await client.query("COMMIT");
    const auctions = [];
    for (const id of created) {
      auctions.push(await getAuction(id, actor, guildId));
    }
    return { auction: auctions[0], auctions, created: auctions.length };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function getAuctionImage(id, guildId) {
  const { rows } = await pool.query(
    `
    SELECT id, guild_id, image_data
    FROM auctions
    WHERE id = $1
    `,
    [id],
  );
  const row = rows[0];
  await assertAuctionGuild(row, guildId);
  if (!row.image_data) throw fail(404, "Este leilão não tem foto.");
  const match = String(row.image_data).match(/^data:(image\/(?:jpeg|jpg|png|webp));base64,(.+)$/i);
  if (!match) throw fail(404, "Foto inválida.");
  return {
    contentType: match[1].toLowerCase() === "image/jpg" ? "image/jpeg" : match[1].toLowerCase(),
    buffer: Buffer.from(match[2], "base64"),
  };
}

export async function setAuctionPaused(actor, id, paused) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin pausa leilão.");
  }
  const row = await loadAuctionRow(id);
  if (!row) throw fail(404, "Leilão não encontrado.");
  if (row.finalized_at) throw fail(400, "Esse leilão já encerrou.");
  if (paused) {
    await pool.query("UPDATE auctions SET paused_at = now() WHERE id = $1 AND paused_at IS NULL", [id]);
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

export async function deleteAuction(actor, id, guildId = null) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin exclui leilão.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");

  const row = await loadAuctionRow(id);
  if (!row) throw fail(404, "Leilão não encontrado.");
  await assertAuctionGuild(row, guildId);

  // Lances e favoritos saem no CASCADE. DKP já cobrado de leilão encerrado permanece;
  // lances abertos só liberam o DKP reservado (nunca debitado).
  await pool.query("DELETE FROM auctions WHERE id = $1", [id]);
  return { ok: true, id: Number(id), itemName: row.item_name };
}

export async function updateAuction(actor, id, body, guildId = null) {
  if (actor.role !== "master" && actor.role !== "admin") {
    throw fail(403, "Só o mestre ou um admin edita leilão.");
  }
  if (guildId == null) throw fail(400, "Escolha uma guilda para continuar.");

  // Com o leilão travado: um lance no meio da edição (que estende o fim pelo
  // anti-snipe) não pode ser desfeito pelo salvar do oficial.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows: lockedRows } = await client.query("SELECT * FROM auctions WHERE id = $1 FOR UPDATE", [id]);
    const row = lockedRows[0];
    if (!row) throw fail(404, "Leilão não encontrado.");
    await assertAuctionGuild(row, guildId);

    const status = computeStatus(row);
    if (status === "ended" || row.finalized_at) {
      throw fail(400, "Não dá para editar leilão encerrado.");
    }

    const itemName = String(body.itemName ?? row.item_name).trim();
    if (!itemName || itemName.length > 80) throw fail(400, "Informe o nome do item.");
    const description = String(body.description ?? row.description ?? "").trim().slice(0, 500);

    const quantity = body.quantity == null ? row.quantity : Number(body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
      throw fail(400, "Quantidade inválida.");
    }

    const resetMinutes = body.resetMinutes == null ? row.reset_minutes : Number(body.resetMinutes);
    if (!Number.isInteger(resetMinutes) || resetMinutes < 0 || resetMinutes > 120) {
      throw fail(400, "Minutos de extensão inválidos.");
    }

    const top = await topBid(row.id, client);
    let startingBid = row.starting_bid;
    if (body.startingBid != null) {
      const next = Number(body.startingBid);
      if (!Number.isInteger(next) || next < 1 || next > 1000000) {
        throw fail(400, "Lance inicial inválido.");
      }
      if (top && next !== row.starting_bid) {
        throw fail(400, "Não dá para mudar o lance inicial depois que já houve lances.");
      }
      startingBid = next;
    }

    let startsAt = new Date(row.starts_at);
    let startsChanged = false;
    if (body.startsAt != null) {
      const nextStart = new Date(body.startsAt);
      if (Number.isNaN(nextStart.getTime())) throw fail(400, "Início inválido.");
      if (nextStart.getTime() !== startsAt.getTime()) {
        if (status !== "upcoming") {
          throw fail(400, "Só dá para mudar o horário de início antes do leilão começar.");
        }
        startsAt = nextStart;
        startsChanged = true;
      }
    }

    // O site sempre manda a duração arredondada em minutos. Só mexe no fim se ela mudou
    // de verdade (ou se o início mudou); senão mantém o fim atual, que pode ter sido
    // estendido por um lance nos últimos minutos.
    const prevDurationMs = new Date(row.expires_at).getTime() - new Date(row.starts_at).getTime();
    let expiresAt = new Date(row.expires_at);
    const requestedDuration = body.durationMinutes == null ? null : Number(body.durationMinutes);
    if (requestedDuration != null) {
      if (!Number.isInteger(requestedDuration) || requestedDuration < 1 || requestedDuration > 7 * 24 * 60) {
        throw fail(400, "Duração inválida.");
      }
    }
    const durationChanged = requestedDuration != null && requestedDuration !== Math.round(prevDurationMs / 60_000);
    if (durationChanged) {
      expiresAt = new Date(startsAt.getTime() + requestedDuration * 60 * 1000);
    } else if (startsChanged) {
      expiresAt = new Date(startsAt.getTime() + Math.max(60_000, prevDurationMs));
    }

    if (expiresAt.getTime() <= startsAt.getTime()) {
      throw fail(400, "O fim precisa ser depois do início.");
    }
    if ((status === "live" || status === "paused") && durationChanged && expiresAt.getTime() <= Date.now()) {
      throw fail(400, "A duração precisa deixar o leilão ainda aberto.");
    }

    let imageData = row.image_data;
    if (Object.prototype.hasOwnProperty.call(body, "imageData")) {
      imageData = normalizeImageData(body.imageData);
    }

    await client.query(
      `
      UPDATE auctions
      SET item_name = $2,
          description = $3,
          starting_bid = $4,
          quantity = $5,
          reset_minutes = $6,
          starts_at = $7,
          expires_at = $8,
          image_data = $9
      WHERE id = $1
      `,
      [
        id,
        itemName,
        description,
        startingBid,
        quantity,
        resetMinutes,
        startsAt.toISOString(),
        expiresAt.toISOString(),
        imageData,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }

  return getAuction(id, actor, guildId);
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

