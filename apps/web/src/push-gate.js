/**
 * Aviso no topo de todas as páginas até as notificações estarem ligadas neste aparelho.
 *
 * Some sozinho quando o push liga (inclusive se a pessoa liberou nas configurações
 * do navegador e voltou para a aba). "Agora não" esconde só até a próxima visita.
 * No iPhone fora da Tela de Início, abre o passo a passo para instalar o NOX.
 */

import { t } from "./i18n.js";
import {
  enablePush,
  getPushState,
  isIOS,
  pushStateNow,
  sendTestPush,
  syncPushSubscription,
} from "./push.js";
import { showToast } from "./toast.js";

const LATER_KEY = "gc-push-gate-later";
const GATE_STATES = new Set(["idle", "ios-install", "denied"]);

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function svg(paths, className = "gate-icon") {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.8");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  node.setAttribute("class", className);
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    node.append(path);
  }
  return node;
}

const ICONS = {
  bell: ["M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9", "M10.3 21a1.94 1.94 0 0 0 3.4 0"],
  bellOff: ["M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5", "M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7", "M10.3 21a1.94 1.94 0 0 0 3.4 0", "m2 2 20 20"],
  phone: ["M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z", "M11 18h2"],
  share: ["M12 3v12", "m8 7 4-4 4 4", "M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"],
  addHome: ["M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z", "M12 8v8", "M8 12h8"],
  safari: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z", "m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"],
  login: ["M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4", "m10 17 5-5-5-5", "M15 12H3"],
  check: ["M20 6 9 17l-5-5"],
};

function laterThisVisit() {
  try {
    return sessionStorage.getItem(LATER_KEY) === "1";
  } catch {
    return false;
  }
}

function setLater() {
  try {
    sessionStorage.setItem(LATER_KEY, "1");
  } catch {
    /* modo privado: só esconde até recarregar */
  }
}

function openSheet(title, body) {
  const close = () => dialog.close();
  const dialog = el("dialog", { className: "sheet gate-sheet", "aria-label": title }, [
    el("div", { className: "gate-sheet-body" }, [
      el("h2", { text: title }),
      ...body,
      el("div", { className: "sheet-actions" }, [
        el("button", { type: "button", className: "btn", onClick: close }, [t("guide.close")]),
      ]),
    ]),
  ]);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) close();
  });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

function step(index, icon, text) {
  return el("li", { className: "gate-step" }, [
    el("span", { className: "gate-step-num", text: String(index) }),
    svg(ICONS[icon], "gate-step-icon"),
    el("p", { text }),
  ]);
}

/** Passo a passo para instalar o NOX na Tela de Início do iPhone. */
export function openIosGuide() {
  openSheet(t("guide.ios.title"), [
    el("p", { className: "gate-sheet-lede", text: t("guide.ios.why") }),
    el("ol", { className: "gate-steps" }, [
      step(1, "safari", t("guide.ios.s1")),
      step(2, "share", t("guide.ios.s2")),
      step(3, "addHome", t("guide.ios.s3")),
      step(4, "login", t("guide.ios.s4")),
      step(5, "bell", t("guide.ios.s5")),
    ]),
    el("p", { className: "gate-sheet-note", text: t("guide.ios.need") }),
  ]);
}

function deniedSteps() {
  const ua = navigator.userAgent || "";
  const items = [];
  if (isIOS()) items.push("guide.denied.iosApp");
  else if (/Android/i.test(ua)) items.push("guide.denied.android");
  else if (/Firefox\//.test(ua)) items.push("guide.denied.firefox");
  else if (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\//.test(ua)) items.push("guide.denied.safari");
  else items.push("guide.denied.chrome");
  const others = ["guide.denied.chrome", "guide.denied.android", "guide.denied.iosApp", "guide.denied.safari", "guide.denied.firefox"]
    .filter((key) => !items.includes(key));
  return { mine: items[0], others };
}

/** Como tirar o bloqueio das notificações, começando pelo aparelho atual. */
export function openDeniedGuide() {
  const { mine, others } = deniedSteps();
  openSheet(t("guide.denied.title"), [
    el("p", { className: "gate-sheet-lede", text: t(mine) }),
    el("details", { className: "gate-other" }, [
      el("summary", { text: t("guide.denied.others") }),
      el("ul", {}, others.map((key) => el("li", { text: t(key) }))),
    ]),
    el("p", { className: "gate-sheet-note", text: t("guide.denied.after") }),
  ]);
}

async function enableFromGate(button) {
  button.disabled = true;
  const result = await enablePush();
  button.disabled = false;
  if (result.ok) {
    try {
      await sendTestPush();
      showToast(t("gate.done"));
    } catch {
      showToast(t("gate.testFail"), { tone: "error" });
    }
    return null;
  }
  if (result.reason === "dismissed") return t("push.dismissed");
  if (result.reason === "error") return t("push.error");
  return null;
}

/** Monta o aviso dentro de `slot`. Chamar uma vez por montagem do layout. */
export function mountPushGate(slot) {
  let note = "";

  function paint(state = pushStateNow()) {
    if (!GATE_STATES.has(state) || laterThisVisit()) {
      slot.hidden = true;
      slot.replaceChildren();
      return;
    }
    slot.hidden = false;
    const later = el("button", {
      type: "button",
      className: "btn btn-ghost btn-small",
      onClick: () => {
        setLater();
        paint();
      },
    }, [t("gate.later")]);

    let icon = "bell";
    let title = t("gate.idle.title");
    let body = t("gate.idle.body");
    let primary;
    if (state === "ios-install") {
      icon = "phone";
      title = t("gate.ios.title");
      body = t("gate.ios.body");
      primary = el("button", { type: "button", className: "btn btn-small", onClick: openIosGuide }, [t("gate.ios.cta")]);
    } else if (state === "denied") {
      icon = "bellOff";
      title = t("gate.denied.title");
      body = t("gate.denied.body");
      primary = el("button", { type: "button", className: "btn btn-small", onClick: openDeniedGuide }, [t("gate.denied.cta")]);
    } else {
      primary = el("button", {
        type: "button",
        className: "btn btn-small",
        onClick: async (event) => {
          note = (await enableFromGate(event.currentTarget)) || "";
          paint();
        },
      }, [t("gate.enable")]);
    }

    slot.replaceChildren(el("section", {
      className: `push-gate is-${state}`,
      role: "region",
      "aria-label": title,
    }, [
      el("span", { className: "push-gate-badge" }, [svg(ICONS[icon])]),
      el("div", { className: "push-gate-text" }, [
        el("strong", { text: title }),
        el("p", { text: body }),
        note ? el("p", { className: "push-gate-note", text: note }) : null,
      ]),
      el("div", { className: "push-gate-actions" }, [primary, later]),
    ]));
  }

  function onState() {
    if (!slot.isConnected) {
      window.removeEventListener("gc:push-state", onState);
      document.removeEventListener("visibilitychange", onVisible);
      return;
    }
    paint();
  }

  // Voltou para a aba (talvez depois de liberar nas configurações): confere de novo.
  function onVisible() {
    if (document.visibilityState !== "visible" || !slot.isConnected) return;
    if (pushStateNow() !== "subscribed") syncPushSubscription();
  }

  window.addEventListener("gc:push-state", onState);
  document.addEventListener("visibilitychange", onVisible);
  paint();
  getPushState().then(() => paint()).catch(() => {});
}
