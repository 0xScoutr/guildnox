import { activitiesView } from "./activities.js";
import {
  configureActivityAlert,
  resetActivityOpenWatch,
  startActivityOpenPoll,
  stopActivityOpenPoll,
} from "./activity-alert.js";
import { auctionImage, auctionsView } from "./auctions.js";
import { getLang, LANGS, setLang, t } from "./i18n.js";
import { rankingView } from "./ranking.js";

const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
configureActivityAlert(API);
const number = new Intl.NumberFormat("pt-BR");
const CLASSES = [
  "Carnage",
  "Viper",
  "Grim Reaper",
  "Akasha",
  "Bloodstained",
];

function roleLabel(role) {
  return t(`role.${role}`) || role;
}

function pageTitle(page) {
  return t(`title.${page}`) || "NOX";
}

function errorMessage(code) {
  return t(`error.${code}`) || t("auth.errorGeneric");
}

const state = {
  me: null,
  guilds: [],
  theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
  error: null,
};

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

function svgIcon(paths) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

const icons = {
  sun: () => svgIcon(["M12 3v2", "M12 19v2", "M4.2 4.2l1.4 1.4", "M18.4 18.4l1.4 1.4", "M3 12h2", "M19 12h2", "M4.2 19.8l1.4-1.4", "M18.4 5.6l1.4-1.4", "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"]),
  moon: () => svgIcon(["M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"]),
  grid: () => svgIcon(["M4 4h7v7H4z", "M13 4h7v7h-7z", "M4 13h7v7H4z", "M13 13h7v7h-7z"]),
  users: () => svgIcon(["M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2", "M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"]),
  gavel: () => svgIcon(["M14 13l7 7", "M8.5 8.5l3 3", "M5 21h7", "M14 4l6 6-4 4-6-6z", "M3 14l4 4"]),
  flag: () => svgIcon(["M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z", "M4 22v-7"]),
  trophy: () => svgIcon(["M8 21h8", "M12 17v4", "M7 4h10v5a5 5 0 0 1-10 0V4z", "M5 6H3a3 3 0 0 0 3 3", "M19 6h2a3 3 0 0 1-3 3"]),
  out: () => svgIcon(["M9 6H5v12h4", "M10 12h9", "M16 8l4 4-4 4"]),
};

function discordIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("fill", "currentColor");
  path.setAttribute("d", "M19.27 5.33A17 17 0 0 0 15 4l-.2.3a15 15 0 0 0-4.6 0L10 4a17 17 0 0 0-4.27 1.33C3.1 9.34 2.35 13.27 2.72 17.16A17.4 17.4 0 0 0 7.9 19.8l.4-.7a11 11 0 0 1-1.7-.82l.4-.3c3.4 1.57 7.1 1.57 10.5 0l.4.3c-.54.33-1.1.6-1.7.82l.4.7a17.4 17.4 0 0 0 5.18-2.64c.44-4.5-.73-8.4-3.1-11.83zM8.52 14.9c-1.03 0-1.88-.95-1.88-2.12s.83-2.12 1.88-2.12 1.9.95 1.88 2.12-.84 2.12-1.88 2.12zm6.96 0c-1.03 0-1.88-.95-1.88-2.12s.83-2.12 1.88-2.12 1.9.95 1.88 2.12-.83 2.12-1.88 2.12z");
  svg.append(path);
  return svg;
}

function displayName(member) {
  return member.characterName || member.globalName || member.username;
}

function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  try { localStorage.setItem("gc-theme", state.theme); } catch { /* ignore */ }
}

function syncThemeSwitch(root = document) {
  root.querySelectorAll(".switch[aria-label='Tema']").forEach((node) => {
    const light = state.theme === "light";
    node.dataset.index = light ? "0" : "1";
    node.querySelectorAll("[role='radio']").forEach((button, index) => {
      button.setAttribute("aria-checked", (light ? index === 0 : index === 1) ? "true" : "false");
    });
  });
}

function themeSwitch() {
  const light = state.theme === "light";
  const thumb = el("span", { className: "switch-thumb" });
  const button = (id, label, icon, checked) => el("button", {
    type: "button",
    role: "radio",
    "aria-checked": checked ? "true" : "false",
    onClick: () => {
      state.theme = id;
      applyTheme();
      syncThemeSwitch();
    },
  }, [icon(), el("span", { className: "switch-label", text: label })]);
  return el("div", {
    className: "switch",
    role: "radiogroup",
    "aria-label": t("theme.label"),
    "data-index": light ? "0" : "1",
  }, [
    thumb,
    button("light", t("theme.light"), icons.sun, light),
    button("dark", t("theme.dark"), icons.moon, !light),
  ]);
}

function languageSwitch() {
  const select = el("select", {
    className: "select lang-select",
    "aria-label": t("language"),
    onChange: async (event) => {
      setLang(event.target.value);
      document.querySelector(".shell")?.remove();
      await render();
    },
  }, LANGS.map((item) => el("option", {
    value: item.id,
    text: `${item.short} — ${item.label}`,
  })));
  select.value = getLang();
  return el("div", { className: "lang-switch" }, [
    el("span", { className: "muted lang-switch-label", text: t("language") }),
    select,
  ]);
}

function toolbarSwitches() {
  return el("div", { className: "toolbar-switches" }, [
    languageSwitch(),
    themeSwitch(),
  ]);
}

function medallion() {
  const wrap = el("div", { className: "medallion", "data-rune-ring": "spin" });
  const pathId = `gc-rune-${Math.random().toString(36).slice(2, 8)}`;
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("class", "rune-ring spin");
  ring.setAttribute("viewBox", "0 0 200 200");
  ring.setAttribute("aria-hidden", "true");
  ring.innerHTML = `
    <defs>
      <path id="${pathId}" d="M100,100 m-84,0 a84,84 0 1,1 168,0 a84,84 0 1,1 -168,0"></path>
    </defs>
    <circle cx="100" cy="100" r="98"></circle>
    <circle cx="100" cy="100" r="72"></circle>
    <text>
      <textPath href="#${pathId}" textLength="520" lengthAdjust="spacing">ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ</textPath>
    </text>
  `;
  wrap.append(
    ring,
    el("img", { className: "brand-logo", src: "/logo.jpg", alt: "NOX" }),
  );
  return wrap;
}

async function api(path, options = {}) {
  const response = await fetch(API + path, {
    credentials: "include",
    cache: "no-store",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || "Não foi possível concluir.");
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function isOfficer(member = state.me) {
  return member?.role === "master" || member?.role === "admin";
}

function isPiloting(member = state.me) {
  return Boolean(member?.piloting?.owner);
}

function needsGuild(member = state.me) {
  return Boolean(member) && !member.currentGuild;
}

function hasPendingApplication(member = state.me) {
  return Boolean(member?.pendingApplication?.guildId);
}

function route() {
  if (!state.me) return "entrar";
  if (needsGuild()) return hasPendingApplication() ? "aguardando" : "guilda";
  const page = location.hash.replace(/^#\/?/, "");
  if (page === "membros") return isOfficer() ? "membros" : "painel";
  if (page === "leilao" || page === "atividades" || page === "ranking") return page;
  return "painel";
}

function uniqueGuilds(list = state.guilds) {
  const seen = new Set();
  return (list || []).filter((guild) => {
    const id = Number(guild.id);
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function brand() {
  const guildName = state.me?.currentGuild?.name;
  return el("div", { className: "sidebar-brand" }, [
    medallion(),
    el("div", { className: "brand-text" }, [
      el("span", { className: "brand-name", text: "NOX" }),
      guildName ? el("span", { className: "brand-guild", text: guildName }) : null,
    ]),
  ]);
}

async function switchManagedGuild(guildId, select) {
  const previous = String(state.me?.currentGuild?.id || "");
  if (select) select.disabled = true;
  try {
    const data = await api("/api/guilds/select", {
      method: "POST",
      body: JSON.stringify({ guildId }),
    });
    state.me = data.member;
    resetActivityOpenWatch();
    syncGuildChrome();
    await render();
  } catch (err) {
    alert(err.message || t("members.switchGuildFail"));
    if (select) select.value = previous;
  } finally {
    if (select) select.disabled = false;
  }
}

function syncActivitySoundPoll() {
  if (state.me && !needsGuild(state.me)) {
    startActivityOpenPoll(api);
  } else {
    stopActivityOpenPoll();
    resetActivityOpenWatch();
  }
}

function guildSwitcher() {
  const guilds = uniqueGuilds();
  if (!isOfficer() || guilds.length < 2) return null;
  const currentId = String(state.me?.currentGuild?.id || "");
  const select = el("select", {
    className: "select guild-select",
    "aria-label": t("members.manageGuildLabel"),
    onChange: (event) => switchManagedGuild(Number(event.target.value), event.currentTarget),
  }, guilds.map((guild) => {
    const option = el("option", { value: String(guild.id), text: guild.name });
    if (String(guild.id) === currentId) option.selected = true;
    return option;
  }));
  return el("div", { className: "sidebar-guild-switcher" }, [
    el("label", { text: t("members.manageGuildLabel") }),
    select,
  ]);
}

function syncGuildChrome() {
  const root = document.querySelector(".shell");
  if (!root || !state.me) return;

  const brandText = root.querySelector(".brand-text");
  let guildLabel = root.querySelector(".brand-guild");
  const guildName = state.me.currentGuild?.name || "";
  if (brandText) {
    if (guildName) {
      if (guildLabel) guildLabel.textContent = guildName;
      else brandText.append(el("span", { className: "brand-guild", text: guildName }));
    } else if (guildLabel) {
      guildLabel.remove();
    }
  }

  const guilds = uniqueGuilds();
  let switcher = root.querySelector(".sidebar-guild-switcher");
  if (isOfficer() && guilds.length >= 2) {
    const next = guildSwitcher();
    if (switcher) switcher.replaceWith(next);
    else root.querySelector(".sidebar-brand")?.after(next);
  } else if (switcher) {
    switcher.remove();
  }
}

function drawPendingGuild() {
  document.title = pageTitle("aguardando");
  const pending = state.me?.pendingApplication;
  const error = el("div", { className: "alert", hidden: "hidden" });
  let timer = null;
  document.getElementById("app").replaceChildren(el("main", { className: "auth" }, [
    el("div", { className: "auth-tools" }, [toolbarSwitches()]),
    el("div", { className: "auth-card" }, [
      medallion(),
      pilotBanner(),
      el("p", { className: "kicker", text: t("guild.pendingKicker") }),
      el("h1", { text: t("guild.pendingTitle") }),
      el("p", {
        className: "lede",
        text: pending?.guildName
          ? t("guild.pendingLedeNamed", { name: pending.guildName })
          : t("guild.pendingLede"),
      }),
      el("div", { className: "card" }, [
        error,
        el("button", {
          className: "btn btn-ghost",
          type: "button",
          onClick: async () => {
            error.hidden = true;
            try {
              clearInterval(timer);
              const data = await api("/api/guilds/apply", { method: "DELETE" });
              state.me = data.member;
              await render();
            } catch (err) {
              error.hidden = false;
              error.textContent = err.message;
            }
          },
        }, [t("guild.cancelRequest")]),
        el("button", {
          className: "btn btn-ghost",
          type: "button",
          onClick: async () => {
            clearInterval(timer);
            await api("/auth/logout", { method: "POST" }).catch(() => {});
            state.me = null;
            stopActivityOpenPoll();
            resetActivityOpenWatch();
            location.hash = "";
            await render();
          },
        }, [t("logout")]),
      ]),
    ]),
  ]));
  timer = setInterval(async () => {
    try {
      const data = await api("/api/me");
      state.me = data.member;
      state.guilds = uniqueGuilds(data.guilds || []);
      if (!needsGuild(state.me) || !hasPendingApplication(state.me)) {
        clearInterval(timer);
        if (!needsGuild(state.me)) location.hash = "#/painel";
        await render();
      }
    } catch {
      /* keep waiting */
    }
  }, 8000);
}

function drawChooseGuild() {
  document.title = pageTitle("guilda");
  const error = el("div", { className: "alert", hidden: "hidden" });
  const list = el("div", { className: "guild-pick-list" });
  const createWrap = el("div", { className: "guild-create-wrap" });
  const isMaster = state.me.role === "master";

  async function load() {
    try {
      const data = await api("/api/guilds/active");
      state.guilds = data.guilds || [];
      if (!state.guilds.length) {
        list.replaceChildren(el("p", {
          className: "muted",
          text: isMaster ? t("guild.noneMaster") : t("guild.noneMember"),
        }));
      } else {
        list.replaceChildren(...state.guilds.map((guild) => el("button", {
          className: "btn guild-pick-btn",
          type: "button",
          onClick: async () => {
            error.hidden = true;
            try {
              if (isMaster) {
                const result = await api("/api/guilds/select", {
                  method: "POST",
                  body: JSON.stringify({ guildId: guild.id }),
                });
                state.me = result.member;
                location.hash = "#/painel";
              } else {
                const result = await api("/api/guilds/apply", {
                  method: "POST",
                  body: JSON.stringify({ guildId: guild.id }),
                });
                state.me = result.member;
              }
              await render();
            } catch (err) {
              error.hidden = false;
              error.textContent = err.message;
            }
          },
        }, [document.createTextNode(guild.name)])));
      }

      createWrap.replaceChildren();
      if (isMaster && state.guilds.length < 5) {
        const name = el("input", {
          className: "input",
          maxlength: "60",
          placeholder: t("guild.placeholderName"),
        });
        createWrap.append(
          el("p", { className: "muted", text: t("guild.allianceCount", { n: state.guilds.length }) }),
          el("form", {
            className: "guild-create-form",
            onSubmit: async (event) => {
              event.preventDefault();
              error.hidden = true;
              try {
                await api("/api/guilds", {
                  method: "POST",
                  body: JSON.stringify({ name: name.value }),
                });
                await load();
              } catch (err) {
                error.hidden = false;
                error.textContent = err.message;
              }
            },
          }, [
            name,
            el("button", { className: "btn btn-small", type: "submit" }, [t("guild.create")]),
          ]),
        );
      }
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
    }
  }

  document.getElementById("app").replaceChildren(el("main", { className: "auth" }, [
    el("div", { className: "auth-tools" }, [toolbarSwitches()]),
    el("div", { className: "auth-card" }, [
      medallion(),
      pilotBanner(),
      el("p", { className: "kicker", text: t("guild.chooseKicker") }),
      el("h1", { text: t("guild.chooseTitle") }),
      el("p", {
        className: "lede",
        text: isMaster ? t("guild.chooseLedeMaster") : t("guild.chooseLedeMember"),
      }),
      el("div", { className: "card" }, [
        error,
        list,
        createWrap,
        el("button", {
          className: "btn btn-ghost",
          type: "button",
          onClick: async () => {
            await api("/auth/logout", { method: "POST" }).catch(() => {});
            state.me = null;
            stopActivityOpenPoll();
            resetActivityOpenWatch();
            location.hash = "";
            await render();
          },
        }, [t("logout")]),
      ]),
    ]),
  ]));
  load();
}

function drawLogin(status) {
  document.title = pageTitle("entrar");
  const offline = status?.offline;
  const ready = status?.discord;
  const message = state.error ? errorMessage(state.error) : "";
  const button = ready
    ? el("a", { className: "btn", href: `${API}/auth/discord` }, [discordIcon(), document.createTextNode(t("auth.loginDiscord"))])
    : el("button", { className: "btn", type: "button", disabled: "disabled" }, [discordIcon(), document.createTextNode(t("auth.loginDiscord"))]);
  const app = document.getElementById("app");
  app.replaceChildren(el("main", { className: "auth" }, [
    el("div", { className: "auth-tools" }, [toolbarSwitches()]),
    el("div", { className: "auth-card" }, [
      medallion(),
      el("p", { className: "kicker", text: t("auth.kicker") }),
      el("h1", { text: t("auth.title") }),
      el("p", { className: "lede", text: t("auth.game") }),
      el("div", { className: "card" }, [
        message ? el("div", { className: "alert", text: message }) : null,
        button,
        !ready
          ? el("p", {
            className: "note",
            text: offline ? t("auth.noteOffline") : t("auth.noteNoDiscord"),
          })
          : null,
      ]),
    ]),
  ]));
}

function personRow(member) {
  return el("div", { className: "person" }, [
    el("img", { src: member.avatarUrl, alt: "" }),
    el("div", {}, [
      el("strong", { text: displayName(member) }),
      el("span", { text: member.className || t("noClass") }),
    ]),
    el("em", { text: number.format(member.power) }),
  ]);
}

function formatShortWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function characterStat(label, value, display = false) {
  return el("article", { className: "stat-card" }, [
    el("div", { className: "stat-label", text: label }),
    el("div", { className: display ? "stat-value display" : "stat-value", text: value }),
  ]);
}

function dashboardView(data) {
  const me = state.me;
  const history = data.auctionHistory || [];
  const historyRows = history.length
    ? history.map((item) => {
      const won = item.kind === "won";
      const thumb = auctionImage(API, item, { className: "history-thumb" })
        || el("span", { className: `history-mark ${won ? "gavel" : "check"}`, "aria-hidden": "true" });
      return el("div", { className: `history-row ${won ? "loss" : ""}` }, [
        thumb,
        el("div", { className: "history-body" }, [
          el("strong", { text: won ? `Leilão vencido: ${item.itemName}` : `Lance em: ${item.itemName}` }),
          el("span", { text: formatShortWhen(item.at) }),
        ]),
        el("em", {
          className: won ? "dkp-loss" : "dkp-gain",
          text: won ? `−${number.format(item.amount)} DKP` : `${number.format(item.amount)} DKP`,
        }),
      ]);
    })
    : [el("p", { className: "muted", text: t("dash.noHistory") })];

  return el("div", { className: "dashboard" }, [
    el("header", { className: "page-header" }, [
      el("div", {}, [
        el("h2", { text: t("dash.welcome", { name: displayName(me) }) }),
        el("p", { className: "page-sub" }, [
          document.createTextNode(t("dash.sub")),
          el("span", { className: "badge", text: "NOX" }),
        ]),
      ]),
    ]),
    el("div", { className: "rune-rule", "aria-hidden": "true" }),

    el("section", { className: "section-block" }, [
      el("div", { className: "section-head" }, [
        el("h3", { text: t("dash.character") }),
        el("div", { className: "section-head-actions" }, [
          isPiloting(me)
            ? null
            : el("button", {
              className: "btn btn-ghost btn-small",
              type: "button",
              onClick: () => openSheet(me),
            }, [t("dash.editCharacter")]),
          characterSwitcher(),
        ]),
      ]),
      el("div", { className: "stat-grid" }, [
        characterStat(t("dash.nick"), displayName(me), true),
        characterStat(t("dash.class"), me.className || "—", true),
        characterStat(t("dash.level"), number.format(me.level)),
        characterStat(t("dash.power"), number.format(me.power)),
        characterStat(t("dash.dkpAvailable"), number.format(me.dkp)),
        el("article", { className: "stat-card" }, [
          el("div", { className: "stat-label", text: t("dash.liveAuctions") }),
          el("div", { className: "stat-value", text: number.format(data.stats.liveAuctions || 0) }),
          el("button", {
            className: "linkish",
            type: "button",
            onClick: () => { location.hash = "#/leilao"; },
          }, [t("dash.openAuction")]),
        ]),
      ]),
    ]),

    el("section", { className: "panel history-panel" }, [
      el("div", { className: "section-head" }, [
        el("h3", { text: t("dash.history") }),
        el("span", { className: "muted", text: t("dash.wins", { n: history.filter((item) => item.kind === "won").length }) }),
      ]),
      el("div", { className: "history-list" }, historyRows),
    ]),

    el("section", { className: "split" }, [
      el("article", { className: "panel" }, [
        el("h3", { text: t("dash.power") }),
        ...data.top.map(personRow),
      ]),
      el("article", { className: "panel" }, [
        el("h3", { text: t("dash.guildSummary") }),
        el("div", { className: "guild-summary" }, [
          [t("nav.membros"), data.stats.total],
          [t("role.admin"), data.stats.officers],
          [t("dash.guildDkp"), data.stats.dkp],
          [t("dash.power"), data.stats.powerAvg],
        ].map(([label, value]) => el("div", {}, [
          el("span", { text: label }),
          el("strong", { text: number.format(value) }),
        ]))),
      ]),
    ]),
  ]);
}

function canEdit(member) {
  if (!state.me) return false;
  return state.me.discordId === member.discordId || state.me.role === "master" || state.me.role === "admin";
}

function canExpel(member) {
  if (!state.me || state.me.discordId === member.discordId) return false;
  if (member.role === "master") return false;
  if (state.me.role === "master") return true;
  return state.me.role === "admin" && member.role === "member";
}

async function expelMember(member, onDone) {
  const nick = displayName(member);
  if (!confirm(t("sheet.expelConfirm", { nick }))) {
    return;
  }
  try {
    await api(`/api/members/${member.discordId}`, { method: "DELETE" });
    await onDone?.();
  } catch (err) {
    alert(err.message || t("members.expelFail"));
  }
}

async function refreshGuildList() {
  const data = await api("/api/guilds");
  state.guilds = uniqueGuilds((data.guilds || []).filter((guild) => guild.active !== false));
  const active = await api("/api/guilds/active");
  state.guilds = uniqueGuilds(active.guilds || state.guilds);
  syncGuildChrome();
}

function openCreateGuild(onDone) {
  const error = el("div", { className: "alert", hidden: "hidden" });
  const name = el("input", { maxlength: "60", required: "required", placeholder: t("guild.placeholderName") });
  const save = el("button", { className: "btn btn-small", type: "submit" }, [t("members.registerShort")]);
  const form = el("form", {}, [
    el("h2", { text: t("members.newGuild") }),
    el("p", { className: "muted auction-hint", text: t("guild.allianceCount", { n: uniqueGuilds().length }) }),
    error,
    el("label", { className: "auction-field" }, [t("guild.name"), name]),
    el("div", { className: "sheet-actions" }, [
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("cancel")]),
      save,
    ]),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    try {
      await api("/api/guilds", {
        method: "POST",
        body: JSON.stringify({ name: name.value }),
      });
      dialog.close();
      await onDone?.();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  const dialog = el("dialog", { className: "sheet" }, [form]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
}

function openManageGuilds(onDone) {
  const body = el("div", { className: "guild-manage" }, [
    el("p", { className: "muted", text: t("loading") }),
  ]);
  const dialog = el("dialog", { className: "sheet" }, [
    el("div", { className: "sheet-head" }, [
      el("h2", { text: t("members.manageTitle") }),
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("close")]),
    ]),
    body,
  ]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();

  async function load() {
    try {
      const data = await api("/api/guilds");
      const guilds = data.guilds || [];
      if (!guilds.length) {
        body.replaceChildren(el("p", { className: "muted", text: t("members.noGuildsRegistered") }));
        return;
      }
      body.replaceChildren(el("div", { className: "guild-manage-list" }, guilds.map((guild) => (
        el("div", { className: "guild-manage-row" }, [
          el("div", {}, [
            el("strong", { text: guild.name }),
            el("span", {
              className: "muted",
              text: `${t("members.memberCount", { n: number.format(guild.memberCount || 0) })}${guild.active ? "" : t("members.guildInactive")}`,
            }),
          ]),
          el("div", { className: "guild-manage-actions" }, [
            el("button", {
              className: "btn btn-ghost btn-small",
              type: "button",
              onClick: async (event) => {
                const button = event.currentTarget;
                const next = prompt(t("members.renameGuildPrompt"), guild.name);
                if (next == null) return;
                const name = String(next).trim();
                if (!name || name === guild.name) return;
                button.disabled = true;
                try {
                  await api(`/api/guilds/${guild.id}`, {
                    method: "PATCH",
                    body: JSON.stringify({ name }),
                  });
                  await refreshMe();
                  await refreshGuildList();
                  await load();
                  await onDone?.();
                } catch (err) {
                  alert(err.message || t("members.renameFail"));
                  button.disabled = false;
                }
              },
            }, [t("members.guildRename")]),
            el("button", {
              className: "btn btn-ghost btn-small",
              type: "button",
              disabled: guilds.length <= 1 ? "disabled" : undefined,
              onClick: async (event) => {
                const button = event.currentTarget;
                if (!confirm(t("guild.deleteConfirm", { name: guild.name }))) {
                  return;
                }
                button.disabled = true;
                try {
                  await api(`/api/guilds/${guild.id}`, { method: "DELETE" });
                  await refreshMe();
                  await refreshGuildList();
                  await load();
                  await onDone?.();
                } catch (err) {
                  alert(err.message || t("members.deleteFail"));
                  button.disabled = false;
                }
              },
            }, [t("members.guildDelete")]),
          ]),
        ])
      ))));
    } catch (err) {
      body.replaceChildren(el("div", { className: "alert", text: err.message }));
    }
  }

  load();
}

function foldText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function membersView(allMembers, pendingApps = []) {
  const root = el("div", { className: "members-page" });
  let members = [...allMembers];
  let applications = [...pendingApps];
  let guildFilter = "";
  let search = "";

  async function refreshApplications() {
    try {
      const data = await api("/api/guilds/applications");
      applications = data.applications || [];
    } catch {
      applications = [];
    }
    drawApplications();
  }

  async function decideApplication(app, decision, button) {
    button.disabled = true;
    try {
      await api(`/api/guilds/applications/${app.id}/${decision}`, { method: "POST" });
      if (decision === "accept") {
        const data = await api("/api/members");
        members = data.members || [];
        drawRows();
      }
      await refreshApplications();
    } catch (err) {
      button.disabled = false;
      alert(err.message || t("members.applicationFail"));
    }
  }

  function drawApplications() {
    const box = root.querySelector(".guild-applications");
    if (!box) return;
    if (!applications.length) {
      box.hidden = true;
      box.replaceChildren();
      return;
    }
    box.hidden = false;
    box.replaceChildren(
      el("div", { className: "section-head" }, [
        el("h3", { text: t("members.entryRequests") }),
        el("span", { className: "muted", text: t("members.pending", { n: applications.length }) }),
      ]),
      el("div", { className: "guild-app-list" }, applications.map((app) => {
        const accept = el("button", {
          className: "btn btn-small",
          type: "button",
          onClick: () => decideApplication(app, "accept", accept),
        }, [t("members.accept")]);
        const reject = el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: () => decideApplication(app, "reject", reject),
        }, [t("members.reject")]);
        return el("div", { className: "guild-app-row" }, [
          el("div", { className: "name-cell" }, [
            el("img", { className: "avatar", src: app.member.avatarUrl, alt: "" }),
            el("div", {}, [
              el("strong", { text: app.member.nick }),
              el("span", { text: `@${app.member.username} · ${app.guildName}` }),
            ]),
          ]),
          el("div", { className: "guild-app-actions" }, [reject, accept]),
        ]);
      })),
    );
  }

  function guildNames() {
    return [...new Set(
      members.map((member) => member.guildName).filter(Boolean),
    )].sort((a, b) => a.localeCompare(b, "pt-BR"));
  }

  function visible() {
    return members.filter((member) => {
      if (guildFilter && member.guildName !== guildFilter) return false;
      const q = foldText(search).trim();
      if (!q) return true;
      return foldText([
        displayName(member),
        member.username,
        member.className,
        member.guildName,
        roleLabel(member.role),
      ].join(" ")).includes(q);
    });
  }

  function drawRows() {
    const list = visible();
    const box = root.querySelector(".members-results");
    if (!box) return;
    if (!list.length) {
      box.replaceChildren(el("p", { className: "muted", text: t("members.noFilter") }));
      return;
    }
    const rows = list.map((member) => el("tr", {}, [
      el("td", {}, [el("div", { className: "name-cell" }, [
        el("img", { className: "avatar", src: member.avatarUrl, alt: "" }),
        el("div", {}, [
          el("strong", { text: displayName(member) }),
          el("span", { text: `@${member.username}` }),
        ]),
      ])]),
      el("td", {}, [
        member.guildName
          ? el("span", { className: "badge guild-badge", text: member.guildName })
          : el("span", { className: "muted", text: t("members.noGuild") }),
      ]),
      el("td", { text: member.className || "—" }),
      el("td", { text: number.format(member.level) }),
      el("td", { text: number.format(member.power) }),
      el("td", { text: number.format(member.dkp) }),
      el("td", {}, [el("span", { className: "badge", text: roleLabel(member.role) })]),
      el("td", { className: "members-actions" }, [
        canEdit(member)
          ? el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => openSheet(member),
          }, [t("edit")])
          : null,
        canEdit(member)
          ? el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => openPilotDialog(member),
          }, [t("sheet.pilot")])
          : null,
        canExpel(member)
          ? el("button", {
            className: "btn btn-ghost btn-small btn-danger",
            type: "button",
            onClick: () => expelMember(member, async () => {
              members = members.filter((row) => row.discordId !== member.discordId);
              drawRows();
            }),
          }, [t("members.expel")])
          : null,
      ]),
    ]));
    box.replaceChildren(el("div", { className: "table-wrap" }, [
      el("table", {}, [
        el("thead", {}, [el("tr", {}, [
          t("members.col.character"),
          t("members.col.guild"),
          t("members.col.class"),
          t("members.col.level"),
          t("members.col.power"),
          t("members.col.dkp"),
          t("members.col.role"),
          "",
        ].map((label) => el("th", { text: label })))]),
        el("tbody", {}, rows),
      ]),
    ]));
  }

  const masterActions = state.me.role === "master"
    ? el("div", { className: "page-head-actions" }, [
      el("button", {
        className: "btn btn-ghost btn-small",
        type: "button",
        onClick: () => openManageGuilds(async () => {
          await render();
        }),
      }, [t("members.manageGuilds")]),
      uniqueGuilds().length < 5
        ? el("button", {
          className: "btn btn-small",
          type: "button",
          onClick: () => openCreateGuild(async () => {
            await refreshGuildList();
            await render();
          }),
        }, [t("members.newGuild")])
        : null,
    ])
    : null;

  const guildSelect = el("select", {
    className: "select members-guild-filter",
    onChange: (event) => {
      guildFilter = event.target.value;
      drawRows();
    },
  }, [
    el("option", { value: "", text: t("members.allGuilds") }),
    ...guildNames().map((name) => el("option", { value: name, text: name })),
  ]);

  const searchInput = el("input", {
    className: "input",
    type: "search",
    placeholder: t("members.searchPlaceholder"),
    onInput: (event) => {
      search = event.target.value;
      drawRows();
    },
  });

  root.replaceChildren(
    el("header", { className: "page-head auctions-head" }, [
      el("div", {}, [
        el("p", { className: "kicker", text: t("members.alliance") }),
        el("h1", { text: t("members.title") }),
      ]),
      masterActions,
    ]),
    el("section", { className: "panel guild-applications", hidden: applications.length ? undefined : "hidden" }),
    el("div", { className: "panel auction-toolbar members-toolbar" }, [
      searchInput,
      el("label", { className: "members-filter-field" }, [
        el("span", { className: "muted", text: t("members.guild") }),
        guildSelect,
      ]),
    ]),
    el("div", { className: "members-results" }),
  );

  drawApplications();
  drawRows();
  return root;
}

function field(label, control) {
  return el("label", {}, [label, control]);
}

function openPilotDialog(member) {
  const officer = state.me.role === "master" || state.me.role === "admin";
  const isSelf = state.me.loginDiscordId === member.discordId || state.me.discordId === member.discordId;
  if (!isSelf && !officer) return;
  if (isPiloting() && isSelf) {
    alert(t("sheet.cannotEditWhilePiloting"));
    return;
  }

  const error = el("div", { className: "alert", hidden: "hidden" });
  const body = el("div", { className: "pilot-sheet" });
  let pilotCandidates = [];
  let selectedPilotId = "";
  let searchQuery = "";
  let dialog;
  let listEl = null;

  function fold(text) {
    return String(text || "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  }

  function filteredCandidates() {
    const q = fold(searchQuery).trim();
    if (!q) return pilotCandidates;
    return pilotCandidates.filter((row) => fold(`${row.nick} ${row.username}`).includes(q));
  }

  function fillPilotList() {
    if (!listEl) return;
    listEl.replaceChildren();
    if (!pilotCandidates.length) {
      listEl.append(el("div", {
        className: "pilot-picker-empty",
        text: t("sheet.loadingMembers"),
      }));
      return;
    }
    const rows = filteredCandidates();
    if (!rows.length) {
      listEl.append(el("div", {
        className: "pilot-picker-empty",
        text: t("sheet.pilotNoMatch"),
      }));
      return;
    }
    for (const row of rows) {
      const active = selectedPilotId === row.discordId;
      listEl.append(el("button", {
        type: "button",
        className: `pilot-picker-option${active ? " is-active" : ""}`,
        role: "option",
        "aria-selected": active ? "true" : "false",
        "data-discord-id": row.discordId,
        onClick: (event) => {
          selectedPilotId = row.discordId;
          for (const option of listEl.querySelectorAll(".pilot-picker-option")) {
            const on = option.dataset.discordId === selectedPilotId;
            option.classList.toggle("is-active", on);
            option.setAttribute("aria-selected", on ? "true" : "false");
          }
          event.currentTarget.focus({ preventScroll: true });
        },
      }, [
        el("img", { src: row.avatarUrl, alt: "" }),
        el("div", {}, [
          el("strong", { text: row.nick }),
          el("span", { text: `@${row.username}` }),
        ]),
      ]));
    }
  }

  function drawPilotBox() {
    const link = isSelf ? state.me.pilot : null;
    const children = [
      el("p", { className: "muted", text: t("sheet.pilotHint") }),
    ];
    if (link?.member) {
      children.push(el("p", {
        text: link.status === "active"
          ? t("sheet.pilotActive", { nick: link.member.nick, user: link.member.username })
          : t("sheet.pilotPending", { nick: link.member.nick, user: link.member.username }),
      }));
      children.push(el("button", {
        className: "btn btn-ghost btn-small btn-danger",
        type: "button",
        onClick: async () => {
          if (!confirm(t("sheet.removePilot") + "?")) return;
          try {
            const data = await api(`/api/pilots/${link.linkId}`, { method: "DELETE" });
            if (isSelf) state.me = data.member;
            dialog.close();
            await render();
          } catch (err) {
            error.hidden = false;
            error.textContent = err.message;
          }
        },
      }, [t("sheet.removePilot")]));
      listEl = null;
    } else {
      listEl = el("div", {
        className: "pilot-picker-list",
        role: "listbox",
        "aria-label": t("sheet.linkPilot"),
      });
      const search = el("input", {
        type: "search",
        className: "pilot-picker-search",
        placeholder: t("search"),
        value: searchQuery,
        "aria-label": t("search"),
        onInput: (event) => {
          searchQuery = event.target.value;
          fillPilotList();
        },
      });
      fillPilotList();
      children.push(el("div", { className: "pilot-picker" }, [
        el("span", { className: "muted", text: t("sheet.linkPilot") }),
        search,
        listEl,
      ]));
      children.push(el("button", {
        className: "btn",
        type: "button",
        onClick: async () => {
          error.hidden = true;
          if (!selectedPilotId) {
            error.hidden = false;
            error.textContent = t("sheet.selectDiscord");
            return;
          }
          try {
            const payload = { discordId: selectedPilotId };
            if (!isSelf) payload.ownerDiscordId = member.discordId;
            if (officer && !isSelf) payload.activate = true;
            await api("/api/pilots", { method: "POST", body: JSON.stringify(payload) });
            if (isSelf) {
              const me = await api("/api/me");
              state.me = me.member;
            }
            dialog.close();
            await render();
          } catch (err) {
            error.hidden = false;
            error.textContent = err.message;
          }
        },
      }, [officer && !isSelf ? t("sheet.linkActivate") : t("sheet.sendInvite")]));
    }
    body.replaceChildren(...children);
  }

  async function loadPilotCandidates() {
    if (isSelf && state.me.pilot?.member) return;
    try {
      const ownerId = member.discordId;
      const qs = !isSelf ? `?ownerDiscordId=${encodeURIComponent(ownerId)}` : "";
      const data = await api(`/api/pilots/candidates${qs}`);
      pilotCandidates = (data.members || []).filter((row) => row.discordId !== ownerId);
      drawPilotBox();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || t("sheet.pilotLoadFail");
    }
  }

  dialog = el("dialog", { className: "sheet pilot-dialog" }, [
    el("form", { className: "sheet-form", method: "dialog" }, [
      el("h2", { text: t("sheet.pilot") }),
      error,
      body,
      el("div", { className: "sheet-actions" }, [
        el("button", { className: "btn btn-ghost btn-small", type: "submit" }, [t("close")]),
      ]),
    ]),
  ]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  drawPilotBox();
  loadPilotCandidates();
}

function openSheet(member) {
  if (isPiloting() && member.discordId === state.me.discordId) {
    alert(t("sheet.cannotEditWhilePiloting"));
    return;
  }
  const officer = state.me.role === "master" || state.me.role === "admin";
  const master = state.me.role === "master";
  const isSelf = state.me.loginDiscordId === member.discordId || state.me.discordId === member.discordId;
  const error = el("div", { className: "alert", hidden: "hidden" });
  const name = el("input", { name: "characterName", maxlength: "32", value: member.characterName || "" });
  const currentClass = member.className || "";
  const classOptions = [
    el("option", { value: "", text: t("sheet.selectClass") }),
    ...CLASSES.map((value) => el("option", { value, text: value })),
  ];
  if (currentClass && !CLASSES.includes(currentClass)) {
    classOptions.push(el("option", { value: currentClass, text: t("sheet.classLegacy", { name: currentClass }) }));
  }
  const className = el("select", { name: "className", className: "select" }, classOptions);
  className.value = currentClass && (CLASSES.includes(currentClass) || currentClass)
    ? currentClass
    : "";
  const level = el("input", { name: "level", type: "number", min: "1", max: "9999", value: String(member.level) });
  const power = el("input", {
    name: "power",
    type: "number",
    min: "0",
    max: "2000000000",
    value: String(member.power),
  });
  // Na própria ficha, member.dkp é o disponível (sem o reservado em lance); o campo
  // precisa mostrar e comparar com o saldo total.
  const initialDkp = Number(member.dkpTotal ?? member.dkp);
  const dkp = el("input", { name: "dkp", type: "number", min: "-1000000", max: "1000000", value: String(initialDkp) });
  const role = el("select", { name: "role" }, ["master", "admin", "member"].map((value) => {
    const option = el("option", { value, text: roleLabel(value) });
    if (value === member.role) option.selected = true;
    return option;
  }));
  const currentGuildId = member.guildId ?? member.homeGuild?.id ?? "";
  const guildSelect = el("select", { name: "guildId", className: "select" }, [
    el("option", { value: "", text: t("members.loadingGuilds") }),
  ]);
  const save = el("button", { className: "btn btn-small", type: "submit" }, [t("save")]);

  const form = el("form", {}, [
    el("h2", { text: t("sheet.title") }),
    error,
    field(t("sheet.characterName"), name),
    field(t("sheet.class"), className),
    field(t("sheet.level"), level),
    field(t("sheet.power"), power),
    officer ? field(t("sheet.dkp"), dkp) : null,
    officer ? field(t("sheet.guild"), guildSelect) : null,
    master ? field(t("sheet.role"), role) : null,
    el("div", { className: "sheet-actions" }, [
      canExpel(member)
        ? el("button", {
          className: "btn btn-ghost btn-small btn-danger",
          type: "button",
          onClick: async () => {
            await expelMember(member, async () => {
              dialog.close();
              await render();
            });
          },
        }, [t("delete")])
        : null,
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("cancel")]),
      save,
    ]),
  ]);

  async function fillGuildOptions() {
    if (!officer) return;
    let guilds = uniqueGuilds();
    if (!guilds.length) {
      try {
        const data = await api("/api/guilds/active");
        state.guilds = uniqueGuilds(data.guilds || []);
        guilds = state.guilds;
      } catch {
        guilds = [];
      }
    }
    guildSelect.replaceChildren(
      ...guilds.map((guild) => {
        const option = el("option", { value: String(guild.id), text: guild.name });
        if (String(guild.id) === String(currentGuildId)) option.selected = true;
        return option;
      }),
    );
    if (!guilds.length) {
      guildSelect.replaceChildren(el("option", {
        value: String(currentGuildId || ""),
        text: member.guildName || t("members.noGuildOption"),
        selected: "selected",
      }));
    } else if (currentGuildId && ![...guildSelect.options].some((opt) => opt.value === String(currentGuildId))) {
      guildSelect.append(el("option", {
        value: String(currentGuildId),
        text: member.guildName || `Guilda #${currentGuildId}`,
        selected: "selected",
      }));
    }
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    const body = {
      characterName: name.value,
      className: className.value,
      level: Number(level.value),
      power: Number(power.value),
    };
    // Só manda o DKP se o oficial mexeu nele, junto com o valor que estava na tela.
    if (officer && Number(dkp.value) !== initialDkp) {
      body.dkp = Number(dkp.value);
      body.expectedDkp = initialDkp;
    }
    if (officer && guildSelect.value) body.guildId = Number(guildSelect.value);
    if (master) body.role = role.value;
    try {
      const result = await api(`/api/members/${member.discordId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      if (state.me.discordId === result.member.discordId) state.me = result.member;
      dialog.close();
      await render();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message;
      save.disabled = false;
    }
  });
  const dialog = el("dialog", { className: "sheet" }, [form]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  fillGuildOptions();
}

function faixaParticipacao(percent) {
  if (percent == null) return "neutro";
  if (percent >= 60) return "alta";
  if (percent >= 40) return "media";
  return "baixa";
}

function guildParticipationWidget() {
  const wrap = el("section", {
    id: "guild-participation-widget",
    className: "guild-participation",
    "aria-label": t("dash.participation.aria"),
  }, [
    el("p", { className: "muted", text: t("loading") }),
  ]);

  async function load() {
    try {
      const data = await api("/api/guilds/participation-average");
      const guilds = data.guilds || [];
      if (!guilds.length) {
        wrap.replaceChildren();
        return;
      }
      const myId = state.me?.homeGuild?.id || state.me?.guildId || state.me?.currentGuild?.id;
      wrap.replaceChildren(
        el("h3", {
          className: "guild-participation-title",
          title: `Média do percentual de participação de cada guild nas atividades dos últimos ${data.dias} dias, sobre as 50 vagas do clã: vaga sem membro conta como 0%. Cada membro só é cobrado a partir de quando entrou na guild.`,
          text: t("dash.participation.title"),
        }),
        el("p", { className: "guild-part-sub", text: t("dash.participation.sub", { n: data.dias }) }),
        el("ul", { className: "guild-part-lista" }, guilds.map((guild) => {
          const minha = Number(guild.id) === Number(myId);
          const sem = guild.percent == null;
          const membros = guild.slots && guild.memberCount < guild.slots
            ? t("dash.participation.slots", { count: guild.memberCount, slots: guild.slots })
            : t("dash.participation.members", { n: guild.memberCount });
          return el("li", {
            className: `guild-part-item guild-part-${faixaParticipacao(guild.percent)}${minha ? " is-minha" : ""}`,
          }, [
            el("div", { className: "guild-part-topo" }, [
              el("span", { className: "guild-part-nome" }, [
                document.createTextNode(guild.name),
                minha ? el("span", { className: "guild-part-sua", text: t("dash.participation.yourGuild") }) : null,
              ]),
              el("span", {
                className: "guild-part-pct num",
                text: sem ? "—" : `${guild.percent}%`,
              }),
            ]),
            el("span", {
              className: "progress guild-part-barra",
              "aria-hidden": "true",
            }, [
              el("i", { style: `width:${sem ? 0 : guild.percent}%` }),
            ]),
            el("span", {
              className: "guild-part-info",
              text: sem ? t("dash.participation.noneInPeriod") : membros,
            }),
          ]);
        })),
      );
    } catch {
      // Mantém o que já estava na tela (ou vazio na 1ª carga).
    }
  }

  load();
  setInterval(load, 5 * 60 * 1000);
  return wrap;
}

async function switchActingCharacter(actAs) {
  const data = await api("/api/pilots/acting", {
    method: "POST",
    body: JSON.stringify({ actAs }),
  });
  state.me = data.member;
  if (!needsGuild(state.me)) {
    if (!location.hash || location.hash === "#/") location.hash = "#/painel";
  }
  await render();
}

function characterSwitcher() {
  const me = state.me;
  const seat = me?.pilotSeat;
  if (!seat?.owner) return null;
  const acting = me.actingAs === "self" ? "self" : "owner";
  const mine = me.loginNick || me.loginUsername || "meu personagem";
  const select = el("select", {
    className: "select character-switch-select",
    "aria-label": "Personagem em uso",
    onChange: async (event) => {
      const next = event.target.value === "self" ? "self" : "owner";
      select.disabled = true;
      try {
        await switchActingCharacter(next);
      } catch (err) {
        select.value = acting;
        alert(err.message || t("char.switchFail"));
        select.disabled = false;
      }
    },
  }, [
    el("option", { value: "self", text: t("char.mine", { name: mine }) }),
    el("option", { value: "owner", text: t("char.pilot", { name: seat.owner.nick }) }),
  ]);
  select.value = acting;
  return el("div", { className: "character-switch" }, [
    el("span", { className: "muted", text: t("char.use") }),
    select,
  ]);
}

function pilotBanner() {
  const me = state.me;
  if (!me) return null;
  if (me.pilotInvite?.linkId) {
    return el("div", { className: "pilot-banner" }, [
      el("p", {
        text: t("pilot.invite", { nick: me.pilotInvite.owner.nick }),
      }),
      el("div", { className: "pilot-banner-actions" }, [
        el("button", {
          className: "btn btn-small",
          type: "button",
          onClick: async () => {
            try {
              const data = await api(`/api/pilots/${me.pilotInvite.linkId}/accept`, { method: "POST" });
              state.me = data.member;
              await render();
            } catch (err) {
              alert(err.message || t("pilot.accept"));
            }
          },
        }, [t("pilot.accept")]),
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: async () => {
            try {
              const data = await api(`/api/pilots/${me.pilotInvite.linkId}`, { method: "DELETE" });
              state.me = data.member;
              await render();
            } catch (err) {
              alert(err.message || t("pilot.decline"));
            }
          },
        }, [t("pilot.decline")]),
      ]),
    ]);
  }
  if (isPiloting(me)) {
    return el("div", { className: "pilot-banner is-active" }, [
      el("p", { text: t("pilot.using", { nick: me.piloting.owner.nick }) }),
    ]);
  }
  return null;
}

function dkpReasonLabel(reason) {
  return t(`dkp.reason.${reason}`) || reason;
}

function formatWhenShort(value) {
  if (!value) return "—";
  const locale = getLang() === "en" ? "en-US" : getLang() === "es" ? "es-ES" : "pt-BR";
  return new Date(value).toLocaleString(locale, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

async function openDkpHistory() {
  const body = el("div", { className: "dkp-history-body" }, [
    el("p", { className: "loading", text: t("loading") }),
  ]);
  const dialog = el("dialog", { className: "sheet dkp-history-sheet" }, [
    el("form", { className: "sheet-form", method: "dialog" }, [
      el("h2", { text: t("dash.dkpHistoryTitle") }),
      body,
      el("div", { className: "sheet-actions" }, [
        el("button", { className: "btn btn-ghost", type: "submit" }, [t("close")]),
      ]),
    ]),
  ]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();

  try {
    const data = await api("/api/me/dkp-history");
    const entries = data.entries || [];
    if (!entries.length) {
      body.replaceChildren(el("p", { className: "muted", text: t("dash.dkpHistoryEmpty") }));
      return;
    }
    body.replaceChildren(el("ul", { className: "dkp-history-list" }, entries.map((entry) => {
      const gain = Number(entry.amount) >= 0;
      return el("li", { className: `dkp-history-item${gain ? " is-gain" : " is-loss"}` }, [
        el("div", { className: "dkp-history-top" }, [
          el("strong", { text: `${gain ? "+" : ""}${number.format(entry.amount)} DKP` }),
          el("span", { className: "muted", text: formatWhenShort(entry.createdAt) }),
        ]),
        el("p", {
          className: "dkp-history-label",
          text: entry.label
            ? `${dkpReasonLabel(entry.reason)} · ${entry.label}`
            : dkpReasonLabel(entry.reason),
        }),
        el("p", {
          className: "muted dkp-history-balance",
          text: t("dash.dkpHistoryBalance", { n: number.format(entry.balanceAfter) }),
        }),
      ]);
    })));
  } catch (err) {
    body.replaceChildren(el("div", {
      className: "alert",
      text: err.message || t("dash.dkpHistoryFail"),
    }));
  }
}

function profile() {
  const member = state.me;
  const piloting = isPiloting(member);
  return el("div", { className: "profile-stack" }, [
    pilotBanner(),
    el("div", { className: "profile-card" }, [
      el("div", { className: "profile-avatar-wrap" }, [
        el("img", { className: "avatar", src: member.avatarUrl, alt: "" }),
        el("span", { className: "level-pill", text: String(member.level) }),
      ]),
      el("h2", { text: displayName(member) }),
      el("span", {
        className: "badge",
        text: piloting
          ? t("pilot.badge", { class: member.className || t("pilot.ownerAccount") })
          : (member.className || roleLabel(member.role)),
      }),
      el("div", { className: "profile-metrics" }, [
        el("span", { text: `${number.format(member.dkp)} DKP` }),
        el("span", { text: `${number.format(member.power)} ${t("dash.power").toLowerCase()}` }),
      ]),
      member.reservedDkp > 0
        ? el("p", { className: "muted profile-reserved", text: t("pilot.reserved", { n: number.format(member.reservedDkp) }) })
        : null,
      member.pilot?.member
        ? el("p", {
          className: "muted profile-reserved",
          text: member.pilot.status === "active"
            ? t("pilot.linkActive", { nick: member.pilot.member.nick })
            : t("pilot.linkPending", { nick: member.pilot.member.nick }),
        })
        : null,
      el("div", { className: "profile-actions" }, [
        piloting
          ? el("p", { className: "muted", text: t("sheet.ownerLocked") })
          : el("button", { className: "btn", type: "button", onClick: () => openSheet(member) }, [t("dash.editCharacter")]),
        !piloting
          ? el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => openPilotDialog(member),
          }, [member.pilot?.member ? t("sheet.managePilot") : t("sheet.linkPilot")])
          : null,
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: () => openDkpHistory(),
        }, [t("dash.dkpHistory")]),
      ]),
      characterSwitcher(),
    ]),
    guildParticipationWidget(),
  ]);
}

function ensureShell() {
  let root = document.querySelector(".shell");
  if (root) return root;

  const link = (id, label, icon) => el("button", {
    type: "button",
    "data-nav": id,
    onClick: () => { location.hash = `#/${id}`; },
  }, [icon(), document.createTextNode(label)]);

  root = el("div", { className: "shell" }, [
    el("aside", { className: "sidebar" }, [
      brand(),
      guildSwitcher(),
      el("nav", { className: "nav", "aria-label": t("nav.sections") }, [
        link("painel", t("nav.painel"), icons.grid),
        link("leilao", t("nav.leilao"), icons.gavel),
        link("atividades", t("nav.atividades"), icons.flag),
        link("ranking", t("nav.ranking"), icons.trophy),
        link("membros", t("nav.membros"), icons.users),
      ].map((button) => {
        if (button.dataset.nav === "membros" && !isOfficer()) button.hidden = true;
        return button;
      })),
      el("div", { className: "sidebar-foot" }, [
        toolbarSwitches(),
        el("button", {
          className: "logout",
          type: "button",
          onClick: async () => {
            await api("/auth/logout", { method: "POST" }).catch(() => {});
            state.me = null;
            state.guilds = [];
            stopActivityOpenPoll();
            resetActivityOpenWatch();
            location.hash = "";
            await render();
          },
        }, [icons.out(), document.createTextNode(t("logout"))]),
      ]),
    ]),
    el("main", { className: "main" }, [
      el("div", { className: "page-slot" }),
    ]),
    el("aside", { className: "profile profile-slot" }),
  ]);
  document.getElementById("app").replaceChildren(root);
  return root;
}

function setActiveNav(active) {
  document.title = pageTitle(active);
  document.querySelectorAll(".nav [data-nav]").forEach((button) => {
    if (button.dataset.nav === "membros") button.hidden = !isOfficer();
    if (button.dataset.nav === active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function setPageContent(content) {
  const slot = document.querySelector(".page-slot");
  if (!slot) return;
  const invite = pilotBanner();
  if (invite && state.me?.pilotInvite?.linkId) {
    slot.replaceChildren(el("div", { className: "page-with-pilot" }, [invite, content]));
  } else {
    slot.replaceChildren(content);
  }
}

function refreshProfile() {
  const slot = document.querySelector(".profile-slot");
  if (!slot || !state.me) return;
  slot.replaceChildren(profile());
}

async function refreshMe() {
  try {
    const data = await api("/api/me");
    const next = data.member;
    state.guilds = uniqueGuilds(data.guilds || state.guilds || []);
    const changed = !state.me
      || state.me.dkp !== next.dkp
      || state.me.dkpTotal !== next.dkpTotal
      || state.me.reservedDkp !== next.reservedDkp
      || state.me.power !== next.power
      || state.me.level !== next.level
      || state.me.characterName !== next.characterName
      || state.me.className !== next.className
      || state.me.role !== next.role
      || state.me.currentGuild?.id !== next.currentGuild?.id;
    state.me = next;
    if (changed) refreshProfile();
    return next;
  } catch {
    return state.me;
  }
}

function cleanupPages() {
  document.querySelector(".auctions-page")?.cleanup?.();
  document.querySelector(".activities-page")?.cleanup?.();
  document.querySelector(".ranking-page")?.cleanup?.();
}

async function showPage(active, loader) {
  cleanupPages();

  ensureShell();
  await refreshMe();
  syncGuildChrome();
  setActiveNav(active);
  refreshProfile();
  setPageContent(el("p", { className: "loading page-loading", text: t("loading") }));

  const content = await loader();
  if (route() !== active) return;
  setPageContent(content);
}

async function render() {
  const page = route();
  if (page === "entrar") {
    cleanupPages();
    stopActivityOpenPoll();
    resetActivityOpenWatch();
    let status = { offline: true };
    try { status = await api("/api/status"); } catch { status = { offline: true }; }
    drawLogin(status);
    return;
  }

  if (page === "guilda") {
    cleanupPages();
    stopActivityOpenPoll();
    resetActivityOpenWatch();
    drawChooseGuild();
    return;
  }

  if (page === "aguardando") {
    cleanupPages();
    stopActivityOpenPoll();
    resetActivityOpenWatch();
    drawPendingGuild();
    return;
  }

  if (page === "membros") {
    if (!isOfficer()) {
      location.hash = "#/painel";
      return;
    }
    await showPage("membros", async () => {
      const [membersData, appsData] = await Promise.all([
        api("/api/members"),
        api("/api/guilds/applications").catch(() => ({ applications: [] })),
      ]);
      return membersView(membersData.members, appsData.applications || []);
    });
    syncActivitySoundPoll();
    return;
  }
  if (page === "leilao") {
    await showPage("leilao", async () => auctionsView({
      api,
      apiBase: API,
      me: state.me,
      onMemberUpdate: refreshMe,
    }));
    syncActivitySoundPoll();
    return;
  }
  if (page === "atividades") {
    await showPage("atividades", async () => activitiesView({
      api,
      me: state.me,
      onMemberUpdate: refreshMe,
    }));
    syncActivitySoundPoll();
    return;
  }
  if (page === "ranking") {
    await showPage("ranking", async () => rankingView({ api }));
    syncActivitySoundPoll();
    return;
  }
  await showPage("painel", async () => dashboardView(await api("/api/dashboard")));
  syncActivitySoundPoll();
}

async function boot() {
  applyTheme();
  const params = new URLSearchParams(location.search);
  state.error = params.get("error");
  if (state.error) history.replaceState({}, "", location.pathname);
  try {
    const data = await api("/api/me");
    state.me = data.member;
    state.guilds = uniqueGuilds(data.guilds || []);
  } catch {
    state.me = null;
    state.guilds = [];
  }
  if (state.me && !needsGuild() && !location.hash) location.hash = "#/painel";
  window.addEventListener("hashchange", () => {
    render().catch((error) => {
      document.getElementById("app").replaceChildren(el("p", { className: "loading", text: error.message }));
    });
  });
  await render();
  syncActivitySoundPoll();
}

boot().catch((error) => {
  document.getElementById("app").textContent = error.message;
});
