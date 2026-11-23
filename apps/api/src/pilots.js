import { pool, findMember, avatarUrl } from "./db.js";
import { isOfficer } from "./guilds.js";

function fail(status, message, data = {}) {
  const error = new Error(message);
  error.status = status;
  error.data = data;
  return error;
}

function nickOf(row) {
  return row.character_name || row.global_name || row.username;
}

function presentPilotMember(row) {
  if (!row) return null;
  return {
    discordId: row.discord_id,
    nick: nickOf(row),
    username: row.username,
    avatarUrl: avatarUrl(row),
    className: row.class_name || null,
    level: row.level,
    guildId: row.guild_id == null ? null : Number(row.guild_id),
  };
}

export async function migratePilots() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_pilots (
      id BIGSERIAL PRIMARY KEY,
      owner_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      pilot_discord_id TEXT NOT NULL REFERENCES members(discord_id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at TIMESTAMPTZ,
      created_by TEXT REFERENCES members(discord_id),
      CHECK (owner_discord_id <> pilot_discord_id)
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS account_pilots_one_owner_open
    ON account_pilots (owner_discord_id)
    WHERE status IN ('pending', 'active')
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS account_pilots_one_pilot_open
    ON account_pilots (pilot_discord_id)
    WHERE status IN ('pending', 'active')
  `);
  // Conta marcada como piloto: entra no site sem guilda e sem ocupar vaga.
  // Só isso (ou marcar cargo Piloto na ficha) tira a vaga — vínculo de piloto sozinho não.
  await pool.query(`
    ALTER TABLE members
    ADD COLUMN IF NOT EXISTS pilot_account BOOLEAN NOT NULL DEFAULT false
  `);
}

/** Entra no modo piloto (sem guilda / sem vaga) e aguarda vínculo do dono. */
export async function choosePilotAccount(actor) {
  if (!actor?.discord_id) throw fail(401, "Faça login para continuar.");
  if (actor.guild_id != null) {
    throw fail(400, "Saia da guilda antes de entrar como piloto.");
  }
  if (actor.role === "master") {
    throw fail(400, "O mestre não entra como piloto.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
      UPDATE guild_applications
      SET status = 'rejected', resolved_at = now(), resolved_by = $1
      WHERE member_discord_id = $1 AND status = 'pending'
      `,
      [actor.discord_id],
    );
    const { rows } = await client.query(
      `
      UPDATE members
      SET pilot_account = true, updated_at = now()
      WHERE discord_id = $1
      RETURNING *
      `,
      [actor.discord_id],
    );
    await client.query("COMMIT");
    return rows[0];
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
}

/** Volta para a tela de escolha de guilda (sai do modo piloto sem vínculo). */
export async function leavePilotAccount(actor) {
  if (!actor?.discord_id) throw fail(401, "Faça login para continuar.");
  if (actor.guild_id != null) {
    throw fail(400, "Você já está em uma guilda.");
  }

  const open = await pool.query(
    `
    SELECT id, status FROM account_pilots
    WHERE pilot_discord_id = $1 AND status IN ('pending', 'active')
    LIMIT 1
    `,
    [actor.discord_id],
  );
  if (open.rows[0]?.status === "active") {
    throw fail(400, "Remova o vínculo de piloto ativo antes de sair do modo piloto.");
  }
  if (open.rows[0]?.status === "pending") {
    await pool.query(
      `DELETE FROM account_pilots WHERE id = $1 AND status = 'pending'`,
      [open.rows[0].id],
    );
  }

  const { rows } = await pool.query(
    `
    UPDATE members
    SET pilot_account = false, updated_at = now()
    WHERE discord_id = $1
    RETURNING *
    `,
    [actor.discord_id],
  );
  return rows[0];
}

async function loadLink(id, client = pool) {
  const { rows } = await client.query("SELECT * FROM account_pilots WHERE id = $1", [id]);
  return rows[0] || null;
}

export async function getPilotContext(loginMember, { actAs = "owner" } = {}) {
  if (!loginMember?.discord_id) {
    return {
      login: loginMember,
      actor: loginMember,
      piloting: null,
      pilotSeat: null,
      actingAs: "self",
      pilot: null,
      invite: null,
    };
  }

  const asPilot = await pool.query(
    `
    SELECT p.*,
           o.discord_id AS o_discord_id, o.username AS o_username, o.global_name AS o_global_name,
           o.avatar AS o_avatar, o.character_name AS o_character_name, o.class_name AS o_class_name,
           o.level AS o_level, o.power AS o_power, o.dkp AS o_dkp, o.role AS o_role,
           o.guild_id AS o_guild_id, o.managing_guild_id AS o_managing_guild_id
    FROM account_pilots p
    JOIN members o ON o.discord_id = p.owner_discord_id
    WHERE p.pilot_discord_id = $1 AND p.status = 'active'
    LIMIT 1
    `,
    [loginMember.discord_id],
  );

  const asOwner = await pool.query(
    `
    SELECT p.*,
           m.discord_id, m.username, m.global_name, m.avatar, m.character_name, m.class_name, m.level, m.guild_id
    FROM account_pilots p
    JOIN members m ON m.discord_id = p.pilot_discord_id
    WHERE p.owner_discord_id = $1 AND p.status IN ('pending', 'active')
    ORDER BY CASE p.status WHEN 'active' THEN 0 ELSE 1 END, p.created_at DESC
    LIMIT 1
    `,
    [loginMember.discord_id],
  );

  const invite = await pool.query(
    `
    SELECT p.*,
           o.discord_id, o.username, o.global_name, o.avatar, o.character_name, o.class_name, o.level, o.guild_id
    FROM account_pilots p
    JOIN members o ON o.discord_id = p.owner_discord_id
    WHERE p.pilot_discord_id = $1 AND p.status = 'pending'
    LIMIT 1
    `,
    [loginMember.discord_id],
  );

  let pilotSeat = null;
  if (asPilot.rows[0]) {
    const row = asPilot.rows[0];
    pilotSeat = {
      linkId: Number(row.id),
      owner: presentPilotMember({
        discord_id: row.o_discord_id,
        username: row.o_username,
        global_name: row.o_global_name,
        avatar: row.o_avatar,
        character_name: row.o_character_name,
        class_name: row.o_class_name,
        level: row.o_level,
        guild_id: row.o_guild_id,
      }),
      ownerMember: {
        discord_id: row.o_discord_id,
        username: row.o_username,
        global_name: row.o_global_name,
        avatar: row.o_avatar,
        character_name: row.o_character_name,
        class_name: row.o_class_name,
        level: row.o_level,
        power: row.o_power,
        dkp: row.o_dkp,
        role: row.o_role,
        guild_id: row.o_guild_id,
        managing_guild_id: row.o_managing_guild_id,
      },
    };
  }

  const useOwner = Boolean(pilotSeat) && actAs !== "self";
  const actor = useOwner ? pilotSeat.ownerMember : loginMember;
  const piloting = useOwner
    ? { linkId: pilotSeat.linkId, owner: pilotSeat.owner }
    : null;
  const actingAs = useOwner ? "owner" : "self";

  const ownerLink = asOwner.rows[0];
  const pilot = ownerLink
    ? {
      linkId: Number(ownerLink.id),
      status: ownerLink.status,
      member: presentPilotMember(ownerLink),
    }
    : null;

  const pendingInvite = invite.rows[0]
    ? {
      linkId: Number(invite.rows[0].id),
      owner: presentPilotMember(invite.rows[0]),
    }
    : null;

  return {
    login: loginMember,
    actor,
    piloting,
    pilotSeat: pilotSeat
      ? { linkId: pilotSeat.linkId, owner: pilotSeat.owner }
      : null,
    actingAs,
    pilot,
    invite: pendingInvite,
  };
}

/** Membro efetivo para presença/lance (dono, se estiver pilotando). */
export async function actingMember(loginMember, options = {}) {
  const ctx = await getPilotContext(loginMember, options);
  return ctx.actor;
}

async function findMemberByQuery(query) {
  const raw = String(query || "").trim();
  if (!raw) return null;
  if (/^\d{5,22}$/.test(raw)) return findMember(raw);
  const username = raw.replace(/^@/, "");
  const { rows } = await pool.query(
    `
    SELECT * FROM members
    WHERE lower(username) = lower($1)
       OR lower(coalesce(character_name, '')) = lower($1)
    ORDER BY updated_at DESC
    LIMIT 1
    `,
    [username],
  );
  return rows[0] || null;
}

/** Só quem já é de uma guilda (ou oficial) mexe com piloto: login do Discord sozinho não basta. */
function assertInGuild(actor) {
  if (!isOfficer(actor) && actor?.guild_id == null) {
    throw fail(403, "Entre numa guilda para vincular piloto.");
  }
}

export async function listPilotCandidates(actor, ownerDiscordId = null) {
  if (!actor?.discord_id) throw fail(401, "Faça login para continuar.");
  assertInGuild(actor);
  let owner = actor;
  if (ownerDiscordId && String(ownerDiscordId) !== actor.discord_id) {
    if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin lista pilotos de outra conta.");
    owner = await findMember(String(ownerDiscordId));
    if (!owner) throw fail(404, "Conta não encontrada.");
  }
  const { rows } = await pool.query(
    `
    SELECT m.discord_id, m.username, m.global_name, m.avatar, m.character_name, m.class_name, m.level, m.guild_id
    FROM members m
    WHERE m.discord_id <> $1
      -- Membro comum vê só a própria guilda e quem ainda não tem guilda (amigo que vai pilotar).
      AND ($2::boolean OR m.guild_id IS NULL OR m.guild_id = $3)
      AND NOT EXISTS (
        SELECT 1 FROM account_pilots p
        WHERE p.status IN ('pending', 'active')
          AND (p.pilot_discord_id = m.discord_id OR p.owner_discord_id = m.discord_id)
      )
    ORDER BY coalesce(m.character_name, m.global_name, m.username) ASC
    LIMIT 500
    `,
    [owner.discord_id, isOfficer(actor), owner.guild_id ?? null],
  );
  return rows.map((row) => presentPilotMember(row));
}

export async function invitePilot(actor, body = {}) {
  const ownerId = actor.discord_id;
  if (!ownerId) throw fail(401, "Faça login para continuar.");
  assertInGuild(actor);

  // Dono convida na própria conta; oficial pode vincular em outra.
  let targetOwnerId = ownerId;
  if (body.ownerDiscordId && String(body.ownerDiscordId) !== ownerId) {
    if (!isOfficer(actor)) throw fail(403, "Só o mestre ou um admin vincula piloto em outra conta.");
    targetOwnerId = String(body.ownerDiscordId);
  }

  const owner = await findMember(targetOwnerId);
  if (!owner) throw fail(404, "Dono da conta não encontrado.");

  const pilot = await findMemberByQuery(body.pilotQuery || body.username || body.discordId);
  if (!pilot) throw fail(404, "Piloto não encontrado. Peça pra pessoa entrar no site pelo Discord antes.");
  if (pilot.discord_id === owner.discord_id) throw fail(400, "Não dá para vincular a si mesmo.");
  // Oficial não se coloca como piloto da conta de outra pessoa: daria para gastar o DKP dela.
  if (targetOwnerId !== ownerId && pilot.discord_id === actor.discord_id) {
    throw fail(403, "Você não pode se colocar como piloto da conta de outra pessoa.");
  }

  const existingOwner = await pool.query(
    `
    SELECT id, status FROM account_pilots
    WHERE owner_discord_id = $1 AND status IN ('pending', 'active')
    LIMIT 1
    `,
    [owner.discord_id],
  );
  if (existingOwner.rows[0]) {
    throw fail(400, existingOwner.rows[0].status === "active"
      ? "Essa conta já tem um piloto ativo. Remova o atual antes."
      : "Já existe um convite de piloto pendente nessa conta.");
  }

  const existingPilot = await pool.query(
    `
    SELECT id, status FROM account_pilots
    WHERE pilot_discord_id = $1 AND status IN ('pending', 'active')
    LIMIT 1
    `,
    [pilot.discord_id],
  );
  if (existingPilot.rows[0]) {
    throw fail(400, "Esse Discord já está vinculado ou convidado como piloto de outra conta.");
  }

  // Todo vínculo começa pendente e só vale depois que o piloto aceita, inclusive o
  // criado por oficial (antes o oficial podia ativar na hora, sem ninguém aceitar).
  const activateNow = false;
  const { rows } = await pool.query(
    `
    INSERT INTO account_pilots (owner_discord_id, pilot_discord_id, status, accepted_at, created_by)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *
    `,
    [
      owner.discord_id,
      pilot.discord_id,
      activateNow ? "active" : "pending",
      activateNow ? new Date().toISOString() : null,
      actor.discord_id,
    ],
  );

  return {
    link: {
      id: Number(rows[0].id),
      status: rows[0].status,
      owner: presentPilotMember(owner),
      pilot: presentPilotMember(pilot),
    },
  };
}

export async function acceptPilotInvite(actor, linkId) {
  const id = Number(linkId);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Convite inválido.");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM account_pilots WHERE id = $1 FOR UPDATE",
      [id],
    );
    const link = rows[0];
    if (!link) throw fail(404, "Convite não encontrado.");
    if (link.pilot_discord_id !== actor.discord_id) throw fail(403, "Esse convite não é seu.");
    if (link.status !== "pending") throw fail(400, "Esse convite já foi resolvido.");

    await client.query(
      `
      UPDATE account_pilots
      SET status = 'active', accepted_at = now()
      WHERE id = $1
      `,
      [id],
    );
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
  }
  return { ok: true };
}

export async function removePilotLink(actor, linkId) {
  const id = Number(linkId);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Vínculo inválido.");
  const link = await loadLink(id);
  if (!link) throw fail(404, "Vínculo não encontrado.");

  const allowed = isOfficer(actor)
    || actor.discord_id === link.owner_discord_id
    || actor.discord_id === link.pilot_discord_id;
  if (!allowed) throw fail(403, "Sem permissão para remover esse vínculo.");

  await pool.query("DELETE FROM account_pilots WHERE id = $1", [id]);
  return { ok: true };
}

/** Vínculos abertos para enriquecer a lista de membros (piloto ↔ dono). */
export async function listOpenPilotLinks() {
  const { rows } = await pool.query(`
    SELECT
      p.id,
      p.status,
      p.owner_discord_id,
      p.pilot_discord_id,
      o.username AS owner_username,
      o.global_name AS owner_global_name,
      o.character_name AS owner_character_name,
      o.avatar AS owner_avatar,
      m.username AS pilot_username,
      m.global_name AS pilot_global_name,
      m.character_name AS pilot_character_name,
      m.avatar AS pilot_avatar
    FROM account_pilots p
    JOIN members o ON o.discord_id = p.owner_discord_id
    JOIN members m ON m.discord_id = p.pilot_discord_id
    WHERE p.status IN ('pending', 'active')
  `);
  return rows.map((row) => ({
    linkId: Number(row.id),
    status: row.status,
    ownerDiscordId: row.owner_discord_id,
    pilotDiscordId: row.pilot_discord_id,
    owner: presentPilotMember({
      discord_id: row.owner_discord_id,
      username: row.owner_username,
      global_name: row.owner_global_name,
      character_name: row.owner_character_name,
      avatar: row.owner_avatar,
    }),
    pilot: presentPilotMember({
      discord_id: row.pilot_discord_id,
      username: row.pilot_username,
      global_name: row.pilot_global_name,
      character_name: row.pilot_character_name,
      avatar: row.pilot_avatar,
    }),
  }));
}
