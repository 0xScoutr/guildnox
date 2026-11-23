import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import {
  createAuction,
  deleteAuction,
  getAuction,
  getAuctionImage,
  listAuctions,
  migrateAuctions,
  placeBid,
  presentMemberWallet,
  setAuctionFavorite,
  setAuctionPaused,
  updateAuction,
} from "./auctions.js";
import {
  createActivity,
  getActivitySound,
  listActivities,
  listActivityParticipants,
  deleteActivity,
  migrateActivities,
  participateActivity,
  reopenActivity,
} from "./activities.js";
import {
  countMasters,
  dashboardData,
  findMember,
  listMembers,
  migrate,
  pool,
  present,
  presentMember,
  expelMember,
  updateMember,
  upsertDiscordUser,
} from "./db.js";
import { listDkpHistory, migrateDkpLedger, setDkpAbsolute } from "./dkp-ledger.js";
import {
  applyToGuild,
  cancelGuildApplication,
  createGuild,
  deleteGuild,
  effectiveGuildId,
  findGuild,
  getGuildsParticipationAverage,
  getPendingApplication,
  isOfficer,
  listActiveGuilds,
  listGuilds,
  listPendingApplications,
  migrateGuilds,
  presentMemberWithGuild,
  renameGuild,
  resolveGuildApplication,
  selectGuild,
  setGuildActive,
} from "./guilds.js";
import {
  configurePush,
  migratePush,
  pushConfig,
  removeSubscription,
  saveSubscription,
  sendTestPush,
} from "./push.js";
import { migrateActivityNotify, startActivityNotify } from "./activity-notify.js";
import { discordStatusByGuild, migrateDiscordNotify, setGuildDiscord, testGuildDiscord } from "./discord-notify.js";
import { getRanking } from "./ranking.js";
import {
  acceptPilotInvite,
  getPilotContext,
  invitePilot,
  listPilotCandidates,
  listOpenPilotLinks,
  migratePilots,
  removePilotLink,
  choosePilotAccount,
  leavePilotAccount,
} from "./pilots.js";
import {
  createSchedule,
  deleteSchedule,
  listSchedules,
  migrateActivitySchedules,
  startActivitySchedules,
  updateSchedule,
} from "./activity-schedules.js";

const PORT = Number(process.env.PORT || 8080);
const ROLES = new Set(["master", "admin", "member"]);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clientOrigins() {
  return (process.env.CLIENT_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function apiPublicUrl() {
  if (process.env.API_PUBLIC_URL) return process.env.API_PUBLIC_URL.replace(/\/$/, "");
  if (process.env.RAILWAY_PUBLIC_DOMAIN) return `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`;
  return `http://localhost:${PORT}`;
}

function redirectUri() {
  return `${apiPublicUrl()}/auth/discord/callback`;
}

function discordReady() {
  return Boolean(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET);
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw fail(500, "SESSION_SECRET ausente.");
  return secret;
}

function signSession(discordId) {
  const body = Buffer.from(JSON.stringify({
    sub: discordId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 14,
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function readSession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (!payload?.sub || typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return String(payload.sub);
  } catch {
    return null;
  }
}

function cookieBase() {
  // Login passa pelo mesmo site (guildnox.app → proxy → API).
  // Lax evita cookie cross-site bloqueado pelo navegador.
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readText(value, max, label) {
  if (value == null) return null;
  if (typeof value !== "string") throw fail(400, `${label} inválido.`);
  const text = value.trim();
  if (!text) return null;
  if (text.length > max) throw fail(400, `${label} pode ter no máximo ${max} caracteres.`);
  return text;
}

function readInt(value, { min, max, label }) {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw fail(400, `${label} precisa ser um número inteiro.`);
  }
  if (value < min || value > max) {
    throw fail(400, `${label} precisa estar entre ${min} e ${max}.`);
  }
  return value;
}

function wrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function requireUser(req, res, next) {
  try {
    const discordId = readSession(req.cookies.gc_session);
    if (!discordId) return res.status(401).json({ error: "Faça login para continuar." });
    const member = await findMember(discordId);
    if (!member) return res.status(401).json({ error: "Faça login para continuar." });
    req.member = member;
    next();
  } catch (error) {
    next(error);
  }
}

function pilotActAs(req) {
  return req.cookies?.gc_pilot_act === "self" ? "self" : "owner";
}

async function requireGuild(req, res, next) {
  try {
    const ctx = await getPilotContext(req.member, { actAs: pilotActAs(req) });
    req.pilotContext = ctx;
    req.actor = ctx.actor;
    const guildId = effectiveGuildId(ctx.actor);
    if (guildId == null) {
      return res.status(403).json({
        error: "Escolha uma guilda para continuar.",
        needsGuild: true,
      });
    }
    req.guildId = guildId;
    next();
  } catch (error) {
    next(error);
  }
}

async function presentMe(member, actAs = "owner") {
  const ctx = await getPilotContext(member, { actAs });
  const actor = ctx.actor;
  const pilotAccount = Boolean(member.pilot_account);
  const awaitingPilotLink = Boolean(
    pilotAccount
    && member.guild_id == null
    && !ctx.piloting
    && !ctx.pilotSeat,
  );
  const [wallet, withGuild, pendingApplication] = await Promise.all([
    presentMemberWallet(actor),
    presentMemberWithGuild(actor),
    member.guild_id == null && !ctx.piloting && !pilotAccount
      ? getPendingApplication(member.discord_id)
      : null,
  ]);
  return {
    ...wallet,
    // Permissões seguem quem está logado; ficha/DKP seguem o personagem selecionado.
    role: member.role,
    loginDiscordId: member.discord_id,
    loginUsername: member.username,
    loginNick: member.character_name || member.global_name || member.username,
    loginHasGuild: member.guild_id != null,
    guildId: withGuild.guildId,
    managingGuildId: withGuild.managingGuildId,
    currentGuild: withGuild.currentGuild,
    homeGuild: withGuild.homeGuild,
    pendingApplication,
    pilotAccount,
    awaitingPilotLink,
    actingAs: ctx.actingAs,
    pilotSeat: ctx.pilotSeat,
    piloting: ctx.piloting,
    pilot: ctx.pilot,
    pilotInvite: ctx.invite,
  };
}

function homeUrl(error) {
  const origin = clientOrigins()[0];
  return error ? `${origin}/?error=${encodeURIComponent(error)}` : `${origin}/#/painel`;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && clientOrigins().includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
}));

app.get("/api/status", wrap(async (_req, res) => {
  await pool.query("SELECT 1");
  res.json({
    ok: true,
    name: "guildnox",
    game: "Vampir",
    discord: discordReady(),
  });
}));

app.get("/auth/discord", (req, res) => {
  if (!discordReady()) return res.redirect(homeUrl("discord_unconfigured"));
  const state = crypto.randomBytes(24).toString("hex");
  res.cookie("gc_oauth_state", state, { ...cookieBase(), maxAge: 10 * 60 * 1000 });
  const url = new URL("https://discord.com/api/oauth2/authorize");
  url.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "identify");
  url.searchParams.set("state", state);
  url.searchParams.set("prompt", "consent");
  res.redirect(url.toString());
});

app.get("/auth/discord/callback", async (req, res) => {
  try {
  const expected = req.cookies.gc_oauth_state;
  res.clearCookie("gc_oauth_state", cookieBase());
  if (req.query.error) return res.redirect(homeUrl("discord_denied"));
  if (!expected || !req.query.state || !safeEqual(expected, req.query.state)) {
    return res.redirect(homeUrl("invalid_state"));
  }
  if (!discordReady() || typeof req.query.code !== "string") {
    return res.redirect(homeUrl("discord"));
  }

  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID,
      client_secret: process.env.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code",
      code: req.query.code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!tokenRes.ok) return res.redirect(homeUrl("discord"));
  const token = await tokenRes.json();

  const userRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  if (!userRes.ok) return res.redirect(homeUrl("discord"));
  const user = await userRes.json();

  await upsertDiscordUser({
    id: user.id,
    username: user.username,
    globalName: user.global_name || null,
    avatar: user.avatar || null,
  });
  res.cookie("gc_session", signSession(user.id), {
    ...cookieBase(),
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  res.redirect(homeUrl());
  } catch (error) {
    console.error(error);
    res.redirect(homeUrl("discord"));
  }
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("gc_session", cookieBase());
  res.json({ ok: true });
});

app.get("/api/me", requireUser, wrap(async (req, res) => {
  res.json({
    member: await presentMe(req.member, pilotActAs(req)),
    guilds: isOfficer(req.member) ? await listActiveGuilds() : await listActiveGuilds(),
  });
}));

app.get("/api/guilds/active", requireUser, wrap(async (_req, res) => {
  res.json({ guilds: await listActiveGuilds() });
}));

app.get("/api/guilds/participation-average", requireUser, wrap(async (_req, res) => {
  res.json(await getGuildsParticipationAverage());
}));

app.get("/api/guilds", requireUser, wrap(async (req, res) => {
  if (!isOfficer(req.member)) throw fail(403, "Só o mestre ou um admin gerencia guildas.");
  const [guilds, discord] = await Promise.all([listGuilds(), discordStatusByGuild()]);
  res.json({
    guilds: guilds.map((guild) => ({
      ...guild,
      discord: discord.get(guild.id) || { configured: false, mention: null },
    })),
  });
}));

app.post("/api/guilds", requireUser, wrap(async (req, res) => {
  res.status(201).json({ guild: await createGuild(req.member, req.body || {}) });
}));

app.post("/api/guilds/:id/active", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  res.json({ guild: await setGuildActive(req.member, id, Boolean(req.body?.active)) });
}));

app.patch("/api/guilds/:id", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  res.json({ guild: await renameGuild(req.member, id, req.body || {}) });
}));

app.patch("/api/guilds/:id/discord", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  res.json({ discord: await setGuildDiscord(req.member, id, req.body || {}) });
}));

app.post("/api/guilds/:id/discord/test", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  res.json(await testGuildDiscord(req.member, id));
}));

app.delete("/api/guilds/:id", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Guilda inválida.");
  res.json(await deleteGuild(req.member, id));
}));

app.post("/api/guilds/select", requireUser, wrap(async (req, res) => {
  const updated = await selectGuild(req.member, req.body?.guildId);
  res.json({ member: await presentMe(updated, pilotActAs(req)) });
}));

app.post("/api/guilds/apply", requireUser, wrap(async (req, res) => {
  const result = await applyToGuild(req.member, req.body?.guildId);
  const memberRow = result.member?.discord_id
    ? result.member
    : req.member;
  const fresh = await findMember(memberRow.discord_id);
  res.json({
    member: await presentMe(fresh, pilotActAs(req)),
    pendingApplication: result.pendingApplication
      ?? (await getPendingApplication(fresh.discord_id)),
  });
}));

app.delete("/api/guilds/apply", requireUser, wrap(async (req, res) => {
  await cancelGuildApplication(req.member);
  const fresh = await findMember(req.member.discord_id);
  res.json({ member: await presentMe(fresh, pilotActAs(req)) });
}));

app.get("/api/guilds/applications", requireUser, requireGuild, wrap(async (req, res) => {
  res.json({ applications: await listPendingApplications(req.member) });
}));

app.post("/api/guilds/applications/:id/accept", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Pedido inválido.");
  res.json(await resolveGuildApplication(req.member, id, "accept"));
}));

app.post("/api/guilds/applications/:id/reject", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Pedido inválido.");
  res.json(await resolveGuildApplication(req.member, id, "reject"));
}));

app.get("/api/dashboard", requireUser, requireGuild, wrap(async (req, res) => {
  res.json(await dashboardData(req.actor || req.member, req.guildId));
}));

app.get("/api/pilots/candidates", requireUser, wrap(async (req, res) => {
  const ownerDiscordId = req.query.ownerDiscordId || null;
  res.json({ members: await listPilotCandidates(req.member, ownerDiscordId) });
}));

app.post("/api/pilots/choose", requireUser, wrap(async (req, res) => {
  const updated = await choosePilotAccount(req.member);
  res.json({ member: await presentMe(updated, pilotActAs(req)) });
}));

app.delete("/api/pilots/choose", requireUser, wrap(async (req, res) => {
  const updated = await leavePilotAccount(req.member);
  res.json({ member: await presentMe(updated, pilotActAs(req)) });
}));

app.post("/api/pilots/acting", requireUser, wrap(async (req, res) => {
  const mode = req.body?.actAs === "self" ? "self" : "owner";
  if (mode === "owner") {
    const seat = await getPilotContext(req.member, { actAs: "self" });
    if (!seat.pilotSeat) throw fail(400, "Você não tem uma conta vinculada para pilotar.");
  }
  res.cookie("gc_pilot_act", mode, {
    ...cookieBase(),
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  const fresh = await findMember(req.member.discord_id);
  res.json({ member: await presentMe(fresh, mode) });
}));

app.post("/api/pilots", requireUser, wrap(async (req, res) => {
  res.status(201).json(await invitePilot(req.member, req.body || {}));
}));

app.post("/api/pilots/:id/accept", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Convite inválido.");
  await acceptPilotInvite(req.member, id);
  res.cookie("gc_pilot_act", "owner", {
    ...cookieBase(),
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  const fresh = await findMember(req.member.discord_id);
  res.json({ member: await presentMe(fresh, "owner") });
}));

app.delete("/api/pilots/:id", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Vínculo inválido.");
  await removePilotLink(req.member, id);
  res.cookie("gc_pilot_act", "self", {
    ...cookieBase(),
    maxAge: 14 * 24 * 60 * 60 * 1000,
  });
  const fresh = await findMember(req.member.discord_id);
  res.json({ member: await presentMe(fresh, "self") });
}));

app.get("/api/members", requireUser, requireGuild, wrap(async (req, res) => {
  if (!isOfficer(req.member)) {
    throw fail(403, "Só o mestre ou um admin vê a lista de membros.");
  }
  // Oficiais veem a aliança inteira pra filtrar por guilda.
  const [members, pilotLinks] = await Promise.all([
    listMembers(null),
    listOpenPilotLinks(),
  ]);
  const byPilot = new Map(pilotLinks.map((link) => [link.pilotDiscordId, link]));
  const byOwner = new Map(pilotLinks.map((link) => [link.ownerDiscordId, link]));
  res.json({
    members: members.map((row) => {
      const base = presentMember(row);
      const asPilot = byPilot.get(row.discord_id);
      const asOwner = byOwner.get(row.discord_id);
      return {
        ...base,
        pilotingOwner: asPilot
          ? {
            linkId: asPilot.linkId,
            status: asPilot.status,
            nick: asPilot.owner.nick,
            username: asPilot.owner.username,
            discordId: asPilot.owner.discordId,
            avatarUrl: asPilot.owner.avatarUrl,
          }
          : null,
        linkedPilot: asOwner
          ? {
            linkId: asOwner.linkId,
            status: asOwner.status,
            nick: asOwner.pilot.nick,
            username: asOwner.pilot.username,
            discordId: asOwner.pilot.discordId,
            avatarUrl: asOwner.pilot.avatarUrl,
          }
          : null,
      };
    }),
  });
}));

app.patch("/api/members/:discordId", requireUser, wrap(async (req, res) => {
  if (!/^\d{5,22}$/.test(req.params.discordId)) throw fail(400, "Membro inválido.");
  const target = await findMember(req.params.discordId);
  if (!target) return res.status(404).json({ error: "Membro não encontrado." });

  const actor = req.member;
  const isSelf = actor.discord_id === target.discord_id;
  const officer = isOfficer(actor);
  const master = actor.role === "master";
  if (!isSelf && !officer) throw fail(403, "Você só pode editar a própria ficha.");
  if ("dkp" in req.body && !officer) throw fail(403, "Só o mestre ou um admin altera DKP.");
  if ("role" in req.body && !master) throw fail(403, "Só o mestre altera cargos.");
  if ("guildId" in req.body && !officer) throw fail(403, "Só o mestre ou um admin altera a guilda do membro.");
  if ("pilotAccount" in req.body && !officer) throw fail(403, "Só o mestre ou um admin marca piloto.");

  const patch = {};
  if ("characterName" in req.body) patch.characterName = readText(req.body.characterName, 32, "O nome");
  if ("className" in req.body) patch.className = readText(req.body.className, 32, "A classe");
  if ("level" in req.body) patch.level = readInt(req.body.level, { min: 1, max: 9999, label: "O nível" });
  if ("power" in req.body) {
    patch.power = readInt(req.body.power, { min: 0, max: 2000000000, label: "O poder" });
  }
  let nextDkp = null;
  let expectedDkp = null;
  if ("dkp" in req.body && officer) {
    nextDkp = readInt(req.body.dkp, { min: -1000000, max: 1000000, label: "O DKP" });
    if (req.body.expectedDkp != null) {
      expectedDkp = readInt(req.body.expectedDkp, { min: -1000000000, max: 1000000000, label: "O DKP anterior" });
    }
  }
  if ("role" in req.body && master) {
    if (!ROLES.has(req.body.role)) throw fail(400, "Cargo inválido.");
    if (target.role === "master" && req.body.role !== "master" && await countMasters() <= 1) {
      throw fail(400, "A guilda precisa de um mestre.");
    }
    patch.role = req.body.role;
  }
  if ("pilotAccount" in req.body && officer && req.body.pilotAccount === true) {
    if (target.role === "master") throw fail(400, "O mestre não pode ser marcado como piloto.");
    patch.pilotAccount = true;
  } else if ("guildId" in req.body && officer) {
    const guildId = readInt(Number(req.body.guildId), { min: 1, max: 1000000, label: "A guilda" });
    const guild = await findGuild(guildId);
    if (!guild || guild.active === false) throw fail(400, "Guilda inválida ou inativa.");
    patch.guildId = guildId;
  }

  if (nextDkp != null) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // A comparação com o saldo atual acontece com a linha travada, dentro da transação.
      await setDkpAbsolute(client, {
        discordId: target.discord_id,
        nextDkp,
        expectedDkp,
        reason: "adjustment",
        label: "Ajuste manual",
      });
      await client.query("COMMIT");
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* ignore */ }
      throw error;
    } finally {
      client.release();
    }
  }

  const updated = await updateMember(target.discord_id, patch);
  const member = updated.discord_id === actor.discord_id
    ? await presentMe(updated, pilotActAs(req))
    : await presentMemberWithGuild(updated);
  res.json({ member });
}));

app.get("/api/me/dkp-history", requireUser, wrap(async (req, res) => {
  const actor = req.actor || req.member;
  res.json({ entries: await listDkpHistory(actor.discord_id) });
}));

app.delete("/api/members/:discordId", requireUser, wrap(async (req, res) => {
  if (!/^\d{5,22}$/.test(req.params.discordId)) throw fail(400, "Membro inválido.");
  res.json(await expelMember(req.member, req.params.discordId));
}));

app.get("/api/auctions", requireUser, requireGuild, wrap(async (req, res) => {
  res.json({ auctions: await listAuctions(req.actor || req.member, req.guildId) });
}));

app.get("/api/auctions/:id/image", requireUser, requireGuild, wrap(async (req, res) => {
  const image = await getAuctionImage(Number(req.params.id), req.guildId);
  res.setHeader("Content-Type", image.contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(image.buffer);
}));

app.get("/api/auctions/:id", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json(await getAuction(id, req.actor || req.member, req.guildId));
}));

app.post("/api/auctions", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não cria leilão.");
  const created = await createAuction(req.member, req.body || {}, req.guildId);
  res.status(201).json(created);
}));

app.post("/api/auctions/:id/bid", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  const actor = req.actor || req.member;
  await getAuction(id, actor, req.guildId);
  const amount = Number(req.body?.amount);
  res.json({ auction: await placeBid(actor, id, amount) });
}));

app.post("/api/auctions/:id/pause", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não pausa leilão.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  await getAuction(id, req.member, req.guildId);
  res.json({ auction: await setAuctionPaused(req.member, id, true) });
}));

app.post("/api/auctions/:id/resume", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não retoma leilão.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  await getAuction(id, req.member, req.guildId);
  res.json({ auction: await setAuctionPaused(req.member, id, false) });
}));

app.delete("/api/auctions/:id", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não exclui leilão.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json(await deleteAuction(req.member, id, req.guildId));
}));

app.patch("/api/auctions/:id", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não edita leilão.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json({ auction: await updateAuction(req.member, id, req.body || {}, req.guildId) });
}));

app.post("/api/auctions/:id/favorite", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  const actor = req.actor || req.member;
  await getAuction(id, actor, req.guildId);
  res.json({ auction: await setAuctionFavorite(actor, id, true) });
}));

app.delete("/api/auctions/:id/favorite", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  const actor = req.actor || req.member;
  await getAuction(id, actor, req.guildId);
  res.json({ auction: await setAuctionFavorite(actor, id, false) });
}));

// Agenda automática de bosses (só oficiais; a guilda é a que o oficial está gerenciando).
app.get("/api/activity-schedules", requireUser, requireGuild, wrap(async (req, res) => {
  res.json({ schedules: await listSchedules(req.member, req.guildId) });
}));

app.post("/api/activity-schedules", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não mexe na agenda.");
  res.status(201).json({ schedule: await createSchedule(req.member, req.body || {}, req.guildId) });
}));

app.patch("/api/activity-schedules/:id", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não mexe na agenda.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Agenda inválida.");
  res.json({ schedule: await updateSchedule(req.member, id, req.body || {}, req.guildId) });
}));

app.delete("/api/activity-schedules/:id", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não mexe na agenda.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Agenda inválida.");
  res.json(await deleteSchedule(req.member, id, req.guildId));
}));

app.get("/api/activities", requireUser, requireGuild, wrap(async (req, res) => {
  res.json({ activities: await listActivities(req.actor || req.member, req.guildId) });
}));

app.post("/api/activities", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não cria atividade.");
  res.status(201).json({ activity: await createActivity(req.member, req.body || {}, req.guildId) });
}));

app.get("/api/activities/:id/sound", requireUser, requireGuild, wrap(async (req, res) => {
  const sound = await getActivitySound(Number(req.params.id), req.guildId);
  res.setHeader("Content-Type", sound.contentType);
  res.setHeader("Cache-Control", "private, max-age=3600");
  res.send(sound.buffer);
}));

app.get("/api/activities/:id/participants", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Atividade inválida.");
  res.json({ participants: await listActivityParticipants(id, req.guildId) });
}));

app.post("/api/activities/:id/participate", requireUser, requireGuild, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Atividade inválida.");
  const actor = req.actor || req.member;
  const alsoCredit = req.pilotContext?.piloting ? req.member : null;
  res.json(await participateActivity(actor, id, req.guildId, alsoCredit));
}));

app.post("/api/activities/:id/reopen", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não reabre atividade.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Atividade inválida.");
  res.json({ activity: await reopenActivity(req.member, id, req.body || {}, req.guildId) });
}));

app.delete("/api/activities/:id", requireUser, requireGuild, wrap(async (req, res) => {
  if (req.pilotContext?.piloting) throw fail(403, "Piloto não exclui atividade.");
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Atividade inválida.");
  res.json(await deleteActivity(req.member, id, req.guildId));
}));

// Push: a inscrição é do aparelho de quem está logado (não do personagem pilotado).
app.get("/api/push/config", requireUser, (_req, res) => {
  res.json(pushConfig());
});

app.post("/api/push/subscriptions", requireUser, wrap(async (req, res) => {
  res.status(201).json(await saveSubscription(req.member, req.body || {}, req.get("user-agent")));
}));

app.delete("/api/push/subscriptions", requireUser, wrap(async (req, res) => {
  res.json(await removeSubscription(req.member, req.body?.endpoint));
}));

app.post("/api/push/test", requireUser, wrap(async (req, res) => {
  res.json(await sendTestPush(req.member));
}));

app.get("/api/ranking", requireUser, requireGuild, wrap(async (req, res) => {
  res.json(await getRanking(req.query || {}, req.guildId));
}));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  res.status(status).json({
    error: status >= 500 ? "Erro interno." : error.message,
    ...(error.data || {}),
  });
});

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL ausente.");
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error("SESSION_SECRET ausente.");
  process.exit(1);
}

await migrate();
await migrateAuctions();
await migrateActivities();
await migrateGuilds();
await migrateActivitySchedules();
// O primeiro ciclo da agenda roda 5 s depois, com o resto das migrações já feito.
startActivitySchedules();
await migratePilots();
await migrateDkpLedger();
await migratePush();
await migrateActivityNotify();
await migrateDiscordNotify();
configurePush();
app.listen(PORT, () => {
  console.log(`guildnox api em :${PORT}`);
  startActivityNotify();
});
