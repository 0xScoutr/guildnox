const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");
const number = new Intl.NumberFormat("pt-BR");
const ROLE = { master: "Mestre", admin: "Admin", member: "Membro" };
const ERRORS = {
  discord_denied: "Autorização cancelada. Tente novamente para entrar com o Discord.",
  invalid_state: "Sessão de login expirada. Tente novamente.",
  discord_unconfigured: "O login com Discord ainda não foi configurado neste hall.",
  discord: "Não foi possível entrar com o Discord. Tente novamente.",
};

const state = {
  me: null,
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
      render();
    },
  }, [icon(), el("span", { className: "switch-label", text: label })]);
  return el("div", {
    className: "switch",
    role: "radiogroup",
    "aria-label": "Tema",
    "data-index": light ? "0" : "1",
  }, [
    thumb,
    button("light", "Claro", icons.sun, light),
    button("dark", "Escuro", icons.moon, !light),
  ]);
}

function medallion() {
  const wrap = el("div", { className: "medallion" });
  wrap.innerHTML = `
    <svg class="spin" viewBox="0 0 200 200" aria-hidden="true">
      <defs><path id="gc-ring" d="M100,100 m-78,0 a78,78 0 1,1 156,0 a78,78 0 1,1 -156,0"></path></defs>
      <circle cx="100" cy="100" r="96" stroke-width="1"></circle>
      <circle cx="100" cy="100" r="64" stroke-width="1"></circle>
      <text><textPath href="#gc-ring" textLength="490" lengthAdjust="spacing">GUILDCHAPA · VAMPIR · GUILDCHAPA · VAMPIR · </textPath></text>
    </svg>`;
  wrap.append(el("span", { className: "medallion-mark", text: "GC" }));
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
    throw error;
  }
  return data;
}

function route() {
  if (!state.me) return "entrar";
  return location.hash.replace(/^#\/?/, "") === "membros" ? "membros" : "painel";
}

function brand() {
  return el("div", { className: "brand-lockup" }, [
    medallion(),
    el("div", {}, [
      el("p", { className: "brand-name", text: "guildchapa" }),
      el("p", { className: "brand-game", text: "Vampir" }),
    ]),
  ]);
}

function drawLogin(status) {
  document.title = "Entrar — guildchapa";
  const offline = status?.offline;
  const ready = status?.discord;
  const message = state.error ? (ERRORS[state.error] || "Não foi possível entrar. Tente novamente.") : "";
  const button = ready
    ? el("a", { className: "btn", href: `${API}/auth/discord` }, [discordIcon(), document.createTextNode("Entrar com Discord")])
    : el("button", { className: "btn", type: "button", disabled: "disabled" }, [discordIcon(), document.createTextNode("Entrar com Discord")]);
  const app = document.getElementById("app");
  app.replaceChildren(el("main", { className: "auth" }, [
    el("div", { className: "auth-tools" }, [themeSwitch()]),
    el("div", { className: "auth-card" }, [
      medallion(),
      el("p", { className: "kicker", text: "Hall da guilda" }),
      el("h1", { text: "guildchapa" }),
      el("p", { className: "lede", text: "Vampir" }),
      el("div", { className: "card" }, [
        message ? el("div", { className: "alert", text: message }) : null,
        button,
        el("p", {
          className: "note",
          text: offline
            ? "O hall está fora do ar agora."
            : ready
              ? "A primeira pessoa a entrar vira mestre da guilda."
              : "Falta ligar o aplicativo do Discord para o botão funcionar.",
        }),
      ]),
    ]),
  ]));
}

function personRow(member) {
  return el("div", { className: "person" }, [
    el("img", { src: member.avatarUrl, alt: "" }),
    el("div", {}, [
      el("strong", { text: displayName(member) }),
      el("span", { text: member.className || "Sem classe" }),
    ]),
    el("em", { text: number.format(member.power) }),
  ]);
}

function dashboardView(data) {
  const cards = [
    ["Membros", data.stats.total],
    ["DKP da guilda", data.stats.dkp],
    ["Poder médio", data.stats.powerAvg],
    ["Oficiais", data.stats.officers],
  ].map(([label, value]) => el("article", { className: "stat" }, [
    el("span", { text: label }),
    el("strong", { text: number.format(value) }),
  ]));
  return el("div", {}, [
    el("header", { className: "page-head" }, [
      el("p", { className: "kicker", text: "Vampir" }),
      el("h1", { text: "Painel" }),
    ]),
    el("section", { className: "stats" }, cards),
    el("section", { className: "split" }, [
      el("article", { className: "panel" }, [
        el("h2", { text: "Maiores poderes" }),
        ...data.top.map(personRow),
      ]),
      el("article", { className: "panel" }, [
        el("h2", { text: "Entraram por último" }),
        ...data.recent.map(personRow),
      ]),
    ]),
  ]);
}

function canEdit(member) {
  if (!state.me) return false;
  return state.me.discordId === member.discordId || state.me.role === "master" || state.me.role === "admin";
}

function membersView(members) {
  const rows = members.map((member) => el("tr", {}, [
    el("td", {}, [el("div", { className: "name-cell" }, [
      el("img", { className: "avatar", src: member.avatarUrl, alt: "" }),
      el("div", {}, [
        el("strong", { text: displayName(member) }),
        el("span", { text: member.globalName ? `@${member.username}` : `@${member.username}` }),
      ]),
    ])]),
    el("td", { text: member.className || "—" }),
    el("td", { text: number.format(member.level) }),
    el("td", { text: number.format(member.power) }),
    el("td", { text: number.format(member.dkp) }),
    el("td", {}, [el("span", { className: "badge", text: ROLE[member.role] || member.role })]),
    el("td", {}, [canEdit(member) ? el("button", {
      className: "btn btn-ghost btn-small",
      type: "button",
      onClick: () => openSheet(member),
    }, ["Editar"]) : null]),
  ]));
  return el("div", {}, [
    el("header", { className: "page-head" }, [
      el("p", { className: "kicker", text: "Guilda" }),
      el("h1", { text: "Membros" }),
    ]),
    el("div", { className: "table-wrap" }, [
      el("table", {}, [
        el("thead", {}, [el("tr", {}, ["Personagem", "Classe", "Nível", "Poder", "DKP", "Cargo", ""].map((label) => el("th", { text: label })))]),
        el("tbody", {}, rows),
      ]),
    ]),
  ]);
}

function field(label, control) {
  return el("label", {}, [label, control]);
}

function openSheet(member) {
  const officer = state.me.role === "master" || state.me.role === "admin";
  const master = state.me.role === "master";
  const error = el("div", { className: "alert", hidden: "hidden" });
  const name = el("input", { name: "characterName", maxlength: "32", value: member.characterName || "" });
  const className = el("input", { name: "className", maxlength: "32", value: member.className || "" });
  const level = el("input", { name: "level", type: "number", min: "1", max: "9999", value: String(member.level) });
  const power = el("input", { name: "power", type: "number", min: "0", max: "2000000000", value: String(member.power) });
  const dkp = el("input", { name: "dkp", type: "number", min: "-1000000", max: "1000000", value: String(member.dkp) });
  const role = el("select", { name: "role" }, ["master", "admin", "member"].map((value) => {
    const option = el("option", { value, text: ROLE[value] });
    if (value === member.role) option.selected = true;
    return option;
  }));
  const save = el("button", { className: "btn btn-small", type: "submit" }, ["Salvar"]);
  const form = el("form", {}, [
    el("h2", { text: "Ficha" }),
    error,
    field("Nome do personagem", name),
    field("Classe", className),
    field("Nível", level),
    field("Poder", power),
    officer ? field("DKP", dkp) : null,
    master ? field("Cargo", role) : null,
    el("div", { className: "sheet-actions" }, [
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, ["Cancelar"]),
      save,
    ]),
  ]);
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
    if (officer) body.dkp = Number(dkp.value);
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
}

function profile() {
  const member = state.me;
  const facts = [
    ["Classe", member.className || "—"],
    ["Nível", number.format(member.level)],
    ["Poder", number.format(member.power)],
    ["DKP", number.format(member.dkp)],
  ].map(([label, value]) => el("div", {}, [el("span", { text: label }), el("strong", { text: value })]));
  return el("aside", { className: "profile" }, [
    el("div", { className: "profile-card" }, [
      el("img", { className: "avatar", src: member.avatarUrl, alt: "" }),
      el("h2", { text: displayName(member) }),
      el("span", { className: "muted", text: `@${member.username}` }),
      el("span", { className: "badge", text: ROLE[member.role] || member.role }),
      el("div", { className: "facts" }, facts),
      el("button", { className: "btn", type: "button", onClick: () => openSheet(member) }, ["Editar ficha"]),
    ]),
  ]);
}

function shell(active, content) {
  document.title = active === "membros" ? "Membros — guildchapa" : "Painel — guildchapa";
  const link = (id, label, icon) => el("button", {
    type: "button",
    "aria-current": active === id ? "page" : null,
    onClick: () => { location.hash = `#/${id}`; },
  }, [icon(), document.createTextNode(label)]);
  document.getElementById("app").replaceChildren(el("div", { className: "shell" }, [
    el("aside", { className: "sidebar" }, [
      brand(),
      el("nav", { className: "nav", "aria-label": "Seções" }, [
        link("painel", "Painel", icons.grid),
        link("membros", "Membros", icons.users),
      ]),
      el("button", {
        className: "logout",
        type: "button",
        onClick: async () => {
          await api("/auth/logout", { method: "POST" }).catch(() => {});
          state.me = null;
          location.hash = "";
          await render();
        },
      }, [icons.out(), document.createTextNode("Sair")]),
    ]),
    el("main", { className: "main" }, [
      el("div", { className: "topbar-tools" }, [themeSwitch()]),
      content,
    ]),
    profile(),
  ]));
}

async function render() {
  const page = route();
  if (page === "entrar") {
    let status = { offline: true };
    try { status = await api("/api/status"); } catch { status = { offline: true }; }
    drawLogin(status);
    return;
  }
  document.getElementById("app").replaceChildren(el("p", { className: "loading", text: "Abrindo o hall…" }));
  if (page === "membros") {
    const data = await api("/api/members");
    shell("membros", membersView(data.members));
    return;
  }
  shell("painel", dashboardView(await api("/api/dashboard")));
}

async function boot() {
  applyTheme();
  const params = new URLSearchParams(location.search);
  state.error = params.get("error");
  if (state.error) history.replaceState({}, "", location.pathname);
  try {
    state.me = (await api("/api/me")).member;
  } catch {
    state.me = null;
  }
  if (state.me && !location.hash) location.hash = "#/painel";
  window.addEventListener("hashchange", () => {
    render().catch((error) => {
      document.getElementById("app").replaceChildren(el("p", { className: "loading", text: error.message }));
    });
  });
  await render();
}

boot().catch((error) => {
  document.getElementById("app").textContent = error.message;
});
