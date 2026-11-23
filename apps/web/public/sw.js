/*
 * Service worker do Guildnox.
 *
 * - Mostra os avisos de atividade da página (no Android o navegador só mostra
 *   notificação pelo service worker; new Notification() dá erro lá).
 * - Recebe o push do servidor com o site fechado: 5 min antes, quando a atividade
 *   abre e 10 min depois para quem ainda não fez check-in.
 * - O botão "Fazer check-in" da notificação faz o check-in sem abrir o site.
 *
 * Não faz cache de nada, então nunca serve uma versão velha do site.
 */

const ICON = "/icons/icon-192.png";
const BADGE = "/icons/badge-96.png";

// Endereço da API, passado pela página no registro (/sw.js?api=...). Vazio = mesmo site.
const API_BASE = (() => {
  try {
    const raw = new URL(self.location.href).searchParams.get("api") || "";
    if (!raw) return "";
    const url = new URL(raw);
    if (url.origin === self.location.origin) return "";
    const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    return url.protocol === "https:" || local ? url.origin : "";
  } catch {
    return "";
  }
})();

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function safeHash(hash) {
  return typeof hash === "string" && /^#\/[a-z-]*$/.test(hash) ? hash : "#/atividades";
}

function fill(template, vars = {}) {
  return String(template || "").replace(/\{(\w+)\}/g, (_, key) => (vars[key] == null ? "" : String(vars[key])));
}

function text(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

/** Traz o site para a frente (ou abre) já na página certa. */
async function openSite(hash) {
  const target = safeHash(hash);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const mine = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (mine) {
    try {
      await mine.focus();
    } catch {
      /* alguns navegadores só deixam focar a partir do clique */
    }
    mine.postMessage({ type: "gc:open", hash: target });
    return;
  }
  await self.clients.openWindow(`/${target}`);
}

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(showPush(data));
});

async function showPush(data) {
  const kind = text(data.kind, 20);
  const activityId = Number(data.activityId) || null;
  const actions = activityId && Array.isArray(data.actions)
    ? data.actions
      .filter((item) => item && item.action === "checkin" && typeof item.title === "string")
      .slice(0, 1)
      .map((item) => ({ action: "checkin", title: text(item.title, 40) }))
    : [];
  const strings = data.strings && typeof data.strings === "object"
    ? {
      busy: text(data.strings.busy),
      done: text(data.strings.done),
      already: text(data.strings.already),
      fail: text(data.strings.fail),
    }
    : null;

  await self.registration.showNotification(text(data.title, 120) || "Guildnox", {
    body: text(data.body, 240),
    icon: ICON,
    badge: BADGE,
    tag: text(data.tag, 80) || "guildnox",
    renotify: true,
    // Abriu ou faltou check-in: no PC o aviso fica na tela até a pessoa mexer nele.
    requireInteraction: kind === "open" || kind === "reminder" || kind === "reopen",
    vibrate: [200, 100, 200],
    actions,
    data: {
      hash: safeHash(data.hash),
      activityId,
      activityName: text(data.activityName, 80),
      strings,
    },
  });
}

// Check-ins em andamento, para um segundo toque no botão não mandar outro pedido.
const checkingIn = new Set();

/** Check-in pelo botão da notificação, sem abrir o site. */
async function checkIn(note, data) {
  const strings = data.strings || {};
  const name = data.activityName || "";
  const activityId = Number(data.activityId);
  if (checkingIn.has(activityId)) return;
  checkingIn.add(activityId);
  let message = strings.fail || "Guildnox";
  let ok = false;
  // Resposta na hora, com a mesma tag: o botão some e a pessoa vê que está andando.
  note.close();
  await self.registration.showNotification(strings.busy || "…", {
    icon: ICON,
    badge: BADGE,
    tag: note.tag,
    renotify: false,
    silent: true,
    data: { hash: "#/atividades" },
  }).catch(() => {});
  try {
    const response = await fetch(`${API_BASE}/api/activities/${Number(data.activityId)}/participate`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok) {
      ok = true;
      message = fill(strings.done, { name, dkp: Number(body.awardedDkp) || 0 });
    } else if (body.error === "already_participated") {
      ok = true;
      message = fill(strings.already, { name });
    }
  } catch {
    /* sem rede: cai na mensagem de falha, que abre o site no toque */
  } finally {
    checkingIn.delete(activityId);
  }
  await self.registration.showNotification(message || "Guildnox", {
    icon: ICON,
    badge: BADGE,
    tag: note.tag,
    renotify: false,
    silent: ok,
    data: { hash: "#/atividades" },
  });
  if (ok) {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) client.postMessage({ type: "gc:checkin", activityId: Number(data.activityId) });
  }
}

self.addEventListener("notificationclick", (event) => {
  const note = event.notification;
  const data = note.data || {};
  if (event.action === "checkin" && data.activityId) {
    event.waitUntil(checkIn(note, data));
    return;
  }
  note.close();
  event.waitUntil(openSite(data.hash));
});

// O navegador trocou a inscrição (acontece no Firefox): cadastra a nova no servidor.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    try {
      let subscription = event.newSubscription;
      if (!subscription) {
        const key = event.oldSubscription?.options?.applicationServerKey;
        if (!key) return;
        subscription = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      }
      await fetch(`${API_BASE}/api/push/subscriptions`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON() }),
      });
    } catch {
      /* a página cadastra de novo na próxima visita */
    }
  })());
});
