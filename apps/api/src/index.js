import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import express from "express";
import {
  createAuction,
  getAuction,
  listAuctions,
  migrateAuctions,
  placeBid,
  setAuctionFavorite,
  setAuctionPaused,
} from "./auctions.js";
import {
  countMasters,
  dashboardData,
  findMember,
  listMembers,
  migrate,
  pool,
  present,
  updateMember,
  upsertDiscordUser,
} from "./db.js";

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
  return {
    httpOnly: true,
    secure: true,
    sameSite: "none",
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

function homeUrl(error) {
  const origin = clientOrigins()[0];
  return error ? `${origin}/?error=${encodeURIComponent(error)}` : `${origin}/#/painel`;
}

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cookieParser());
app.use(express.json({ limit: "16kb" }));
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
    name: "guildchapa",
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

app.get("/api/me", requireUser, (req, res) => {
  res.json({ member: present(req.member) });
});

app.get("/api/dashboard", requireUser, wrap(async (req, res) => {
  res.json(await dashboardData(req.member));
}));

app.get("/api/members", requireUser, wrap(async (_req, res) => {
  const members = await listMembers();
  res.json({ members: members.map(present) });
}));

app.patch("/api/members/:discordId", requireUser, wrap(async (req, res) => {
  if (!/^\d{5,22}$/.test(req.params.discordId)) throw fail(400, "Membro inválido.");
  const target = await findMember(req.params.discordId);
  if (!target) return res.status(404).json({ error: "Membro não encontrado." });

  const actor = req.member;
  const isSelf = actor.discord_id === target.discord_id;
  const officer = actor.role === "master" || actor.role === "admin";
  const master = actor.role === "master";
  if (!isSelf && !officer) throw fail(403, "Você só pode editar a própria ficha.");
  if ("dkp" in req.body && !officer) throw fail(403, "Só o mestre ou um admin altera DKP.");
  if ("role" in req.body && !master) throw fail(403, "Só o mestre altera cargos.");

  const patch = {};
  if ("characterName" in req.body) patch.characterName = readText(req.body.characterName, 32, "O nome");
  if ("className" in req.body) patch.className = readText(req.body.className, 32, "A classe");
  if ("level" in req.body) patch.level = readInt(req.body.level, { min: 1, max: 9999, label: "O nível" });
  if ("power" in req.body) patch.power = readInt(req.body.power, { min: 0, max: 2000000000, label: "O poder" });
  if ("dkp" in req.body && officer) {
    patch.dkp = readInt(req.body.dkp, { min: -1000000, max: 1000000, label: "O DKP" });
  }
  if ("role" in req.body && master) {
    if (!ROLES.has(req.body.role)) throw fail(400, "Cargo inválido.");
    if (target.role === "master" && req.body.role !== "master" && await countMasters() <= 1) {
      throw fail(400, "A guilda precisa de um mestre.");
    }
    patch.role = req.body.role;
  }

  const updated = await updateMember(target.discord_id, patch);
  res.json({ member: present(updated) });
}));

app.get("/api/auctions", requireUser, wrap(async (req, res) => {
  res.json({ auctions: await listAuctions(req.member) });
}));

app.get("/api/auctions/:id", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json(await getAuction(id, req.member));
}));

app.post("/api/auctions", requireUser, wrap(async (req, res) => {
  res.status(201).json({ auction: await createAuction(req.member, req.body || {}) });
}));

app.post("/api/auctions/:id/bid", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  const amount = Number(req.body?.amount);
  res.json({ auction: await placeBid(req.member, id, amount) });
}));

app.post("/api/auctions/:id/pause", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json({ auction: await setAuctionPaused(req.member, id, true) });
}));

app.post("/api/auctions/:id/resume", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json({ auction: await setAuctionPaused(req.member, id, false) });
}));

app.post("/api/auctions/:id/favorite", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json({ auction: await setAuctionFavorite(req.member, id, true) });
}));

app.delete("/api/auctions/:id/favorite", requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) throw fail(400, "Leilão inválido.");
  res.json({ auction: await setAuctionFavorite(req.member, id, false) });
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
app.listen(PORT, () => {
  console.log(`guildchapa api em :${PORT}`);
});
