/**
 * Push no navegador: liga e desliga os avisos de atividade neste aparelho.
 *
 * Nunca pede permissão ao abrir a página: o navegador pune site que pede sem
 * clique, e um "bloquear" só se desfaz nas configurações do site. Por isso
 * enablePush() tem que ser chamado direto de um clique.
 *
 * Estados (getPushState):
 * - "unsupported": navegador sem service worker ou push;
 * - "ios-install": iPhone ou iPad fora da Tela de Início (lá o push só existe no app instalado);
 * - "unconfigured": o servidor não tem as chaves VAPID;
 * - "denied": a pessoa bloqueou as notificações do site;
 * - "idle": dá para ligar;
 * - "subscribed": ligado neste aparelho.
 */

import { getLang } from "./i18n.js";
import { activeRegistration } from "./service-worker.js";

const OFF_KEY = "gc-push-off";

let api = null;
let configPromise = null;
let currentState = "loading";

export function configurePushClient(apiFn) {
  api = apiFn;
}

export function isIOS() {
  const ua = navigator.userAgent || "";
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

export function isStandalone() {
  return window.matchMedia?.("(display-mode: standalone)").matches === true || navigator.standalone === true;
}

function supported() {
  return window.isSecureContext
    && "serviceWorker" in navigator
    && "PushManager" in window
    && "Notification" in window;
}

function readOff() {
  try {
    return localStorage.getItem(OFF_KEY) === "1";
  } catch {
    return false;
  }
}

function writeOff(value) {
  try {
    if (value) localStorage.setItem(OFF_KEY, "1");
    else localStorage.removeItem(OFF_KEY);
  } catch {
    /* modo privado */
  }
}

/** Chave VAPID em base64url; o PushManager quer bytes. */
function keyBytes(base64) {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(subscription, publicKey) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return true; // navegador que não expõe a chave: confia na inscrição
  const a = new Uint8Array(current);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function serverConfig() {
  if (!configPromise) {
    configPromise = api("/api/push/config").catch(() => {
      configPromise = null;
      return { enabled: false };
    });
  }
  return configPromise;
}

function setState(state) {
  if (state !== currentState) {
    currentState = state;
    window.dispatchEvent(new CustomEvent("gc:push-state", { detail: state }));
  }
  return state;
}

/** Último estado conhecido, sem esperar rede (ex.: para não duplicar aviso na aba). */
export function pushStateNow() {
  return currentState;
}

export async function getPushState() {
  if (isIOS() && !isStandalone() && !supported()) return setState("ios-install");
  if (!supported()) return setState("unsupported");
  const config = await serverConfig();
  if (!config?.enabled || !config.publicKey) return setState("unconfigured");
  if (Notification.permission === "denied") return setState("denied");
  const registration = await activeRegistration(5000);
  if (!registration) return setState("unsupported");
  const subscription = await registration.pushManager.getSubscription();
  if (subscription && Notification.permission === "granted" && sameKey(subscription, config.publicKey)) {
    return setState("subscribed");
  }
  return setState("idle");
}

async function subscribeAndSave(registration, publicKey) {
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, publicKey)) {
    await subscription.unsubscribe().catch(() => {});
    subscription = null;
  }
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(publicKey),
    });
  }
  await api("/api/push/subscriptions", {
    method: "POST",
    body: JSON.stringify({ subscription: subscription.toJSON(), lang: getLang() }),
  });
}

/**
 * Liga o push neste aparelho. Chamar direto do clique.
 * Devolve { ok, reason } com reason = "denied" | "dismissed" | "unconfigured" | "error".
 */
export async function enablePush() {
  if (!supported()) return { ok: false, reason: "error" };
  // Antes de qualquer espera: o Safari só mostra o pedido em resposta direta ao toque.
  let permission;
  try {
    permission = await Notification.requestPermission();
  } catch {
    permission = Notification.permission;
  }
  if (permission !== "granted") {
    await getPushState();
    return { ok: false, reason: permission === "denied" ? "denied" : "dismissed" };
  }
  const config = await serverConfig();
  if (!config?.enabled || !config.publicKey) {
    await getPushState();
    return { ok: false, reason: "unconfigured" };
  }
  try {
    const registration = await activeRegistration(8000);
    if (!registration) throw new Error("service worker não ficou pronto");
    await subscribeAndSave(registration, config.publicKey);
    writeOff(false);
    await getPushState();
    return { ok: true };
  } catch (error) {
    await getPushState();
    return { ok: false, reason: "error", message: error?.message };
  }
}

/** Desliga neste aparelho: avisa o servidor antes, para ele não seguir mandando. */
export async function disablePush() {
  const registration = await activeRegistration(3000);
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (subscription) {
    await api("/api/push/subscriptions", {
      method: "DELETE",
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    await subscription.unsubscribe().catch(() => {});
  }
  writeOff(true);
  return getPushState();
}

export function sendTestPush() {
  return api("/api/push/test", { method: "POST", body: "{}" });
}

/**
 * Ao entrar no site: se este aparelho já deu permissão de notificação, garante
 * a inscrição na conta de quem está logado (e no idioma atual). Não pede nada:
 * só age quando a permissão já existe e a pessoa não desligou o push aqui.
 */
export async function syncPushSubscription() {
  try {
    if (!supported() || Notification.permission !== "granted" || readOff()) return getPushState();
    const config = await serverConfig();
    if (!config?.enabled || !config.publicKey) return getPushState();
    const registration = await activeRegistration(5000);
    if (!registration) return getPushState();
    await subscribeAndSave(registration, config.publicKey);
  } catch {
    /* sem rede ou navegador recusou: o botão continua disponível */
  }
  return getPushState();
}

/** Ao sair da conta: este aparelho para de receber avisos dela (a permissão fica). */
export async function detachPushOnLogout() {
  try {
    const registration = await activeRegistration(1500);
    const subscription = registration ? await registration.pushManager.getSubscription() : null;
    if (!subscription) return;
    await Promise.race([
      api("/api/push/subscriptions", {
        method: "DELETE",
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      }),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch {
    /* sair da conta não pode travar por causa do push */
  }
}
