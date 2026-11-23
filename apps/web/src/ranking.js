import { t } from "./i18n.js";

const number = new Intl.NumberFormat("pt-BR");
const memory = { tab: "dkp" };

function rankingTabs() {
  return [
    { id: "dkp", label: t("rank.tab.dkp") },
    { id: "participation", label: t("rank.tab.participation") },
    { id: "power", label: t("rank.tab.power") },
  ];
}

const PODIO = {
  1: { altura: 124, atraso: 560, avatar: 60 },
  2: { altura: 106, atraso: 280, avatar: 50 },
  3: { altura: 92, atraso: 0, avatar: 46 },
};

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child != null) node.append(child);
  return node;
}

function svg(paths, attrs = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", attrs.width || "1.7");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  if (attrs.className) node.setAttribute("class", attrs.className);
  if (attrs.size) {
    node.setAttribute("width", attrs.size);
    node.setAttribute("height", attrs.size);
  }
  for (const d of paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    node.append(path);
  }
  return node;
}

function tabIcon(id) {
  if (id === "dkp") {
    return svg([
      "M12 15a6.5 6.5 0 1 0 0.01 0Z",
      "M9.5 9.5 7 3M14.5 9.5 17 3M7 3h10",
    ], { size: 16, className: "tab-icon" });
  }
  if (id === "participation") {
    return svg([
      "M12 3.5l2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9 2.7-5.6Z",
    ], { size: 16, className: "tab-icon", width: "1.6" });
  }
  return svg([
    "M13 2 4 14h6l-1 8 9-12h-6l1-8Z",
  ], { size: 16, className: "tab-icon" });
}

function downloadIcon() {
  return svg([
    "M12 3v12",
    "M8 11l4 4 4-4",
    "M4 21h16",
  ], { size: 16 });
}

function filterIcon() {
  return svg([
    "M4 5h16l-6 7.5V19l-4 2v-8.5L4 5Z",
  ], { size: 16 });
}

function crownIcon() {
  return svg([
    "M3 18h18",
    "M4 18 7 8l5 5 5-5 3 10",
  ], { size: 18, className: "pod-coroa" });
}

function toInputDay(value) {
  // Os dias do ranking são os de Brasília; mostrar no fuso do navegador deslocava a data
  // para quem está em outro fuso.
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(date);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function semComoMedir(member) {
  return member.percent === null;
}

function valorBruto(member, tab) {
  if (tab === "dkp") return member.dkp ?? 0;
  if (tab === "power") return member.power ?? 0;
  return member.percent ?? 0;
}

function metricValue(member, tab) {
  if (tab === "dkp") return number.format(member.dkp);
  if (tab === "power") return number.format(member.power);
  return semComoMedir(member) ? "—" : `${member.percent}%`;
}

function sortedMembers(members, tab) {
  const list = [...members];
  if (tab === "dkp") {
    return list.sort((a, b) => b.dkp - a.dkp
      || (b.power ?? 0) - (a.power ?? 0)
      || a.nick.localeCompare(b.nick, "pt-BR"));
  }
  if (tab === "power") return list.sort((a, b) => b.power - a.power || a.nick.localeCompare(b.nick, "pt-BR"));
  return list.sort((a, b) => {
    if (semComoMedir(a) && semComoMedir(b)) return a.nick.localeCompare(b.nick, "pt-BR");
    if (semComoMedir(a)) return 1;
    if (semComoMedir(b)) return -1;
    return b.percent - a.percent
      || b.participatedCount - a.participatedCount
      || (b.power ?? 0) - (a.power ?? 0)
      || a.nick.localeCompare(b.nick, "pt-BR");
  });
}

function characterHint(member) {
  return `${member.className || "—"} · Lv. ${member.level}`;
}

function avatar(member, size) {
  if (member.photo) {
    return el("img", {
      className: "avatar ranking-avatar",
      src: member.photo,
      alt: "",
      width: String(size),
      height: String(size),
      style: `width:${size}px;height:${size}px`,
    });
  }
  return el("span", {
    className: "avatar ranking-avatar-fallback",
    style: `width:${size}px;height:${size}px`,
  });
}

function animarContagem(raiz) {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  raiz.querySelectorAll("[data-contar]").forEach((node) => {
    const alvo = Number(node.dataset.contar);
    if (!Number.isInteger(alvo) || alvo <= 0) return;
    const final = node.textContent;
    const pct = node.dataset.formato === "pct";
    const inicio = performance.now() + Number(node.dataset.atraso || 0);
    const duracao = 1100;
    const escreve = (n) => {
      node.textContent = pct ? `${n}%` : number.format(n);
    };
    escreve(0);
    const quadro = (agora) => {
      if (!node.isConnected) return;
      const k = Math.min(1, Math.max(0, (agora - inicio) / duracao));
      if (k >= 1) {
        node.textContent = final;
        return;
      }
      escreve(Math.round(alvo * (1 - Math.pow(1 - k, 3))));
      requestAnimationFrame(quadro);
    };
    requestAnimationFrame(quadro);
  });
}

function podiumCard(member, position, tab) {
  const p = PODIO[position];
  const value = el("div", { className: "ranking-podium-value", text: metricValue(member, tab) });
  if (!semComoMedir(member) || tab !== "participation") {
    value.dataset.contar = String(valorBruto(member, tab));
    value.dataset.formato = tab === "participation" ? "pct" : "num";
    value.dataset.atraso = String(p.atraso + 350);
  }

  const extra = tab === "participation"
    ? el("div", {
      className: "field-hint",
      text: semComoMedir(member)
        ? t("rank.joinedLater")
        : t("rank.activitiesRatio", {
          participated: member.participatedCount,
          total: member.totalCount,
        }),
    })
    : null;

  return el("div", {
    className: `ranking-podium-card rank-${position}`,
    style: `--h:${p.altura}px; --atraso:${p.atraso}ms`,
  }, [
    el("div", { className: "pod-pessoa" }, [
      position === 1 ? crownIcon() : null,
      el("span", { className: "pod-avatar" }, [
        avatar(member, p.avatar),
        el("span", { className: "pod-medalha", text: String(position) }),
      ]),
    ]),
    el("div", { className: "pod-degrau" }, [
      el("div", { className: "ranking-podium-nick", title: member.nick, text: member.nick }),
      el("div", { className: "field-hint pod-classe", text: characterHint(member) }),
      value,
      extra,
    ]),
  ]);
}

function rankRow(member, position, tab, indice, maior) {
  const comBarra = tab === "participation" && !semComoMedir(member);
  const proporcao = maior ? (valorBruto(member, tab) / maior) : 0;
  const extra = tab === "participation"
    ? el("div", {
      className: "field-hint",
      text: semComoMedir(member)
        ? t("rank.joinedLater")
        : `${member.participatedCount}/${member.totalCount}`,
    })
    : null;

  const row = el("div", {
    className: `ranking-row${comBarra ? "" : " sem-barra"}`,
    style: `--i:${Math.min(indice, 14)}`,
    title: `${member.nick} — ${characterHint(member)}`,
  }, [
    el("div", { className: "rank-position", text: `${position}º` }),
    avatar(member, 24),
    el("div", { className: "ranking-row-info" }, [
      el("div", { className: "ranking-row-nick", text: member.nick }),
    ]),
    el("div", { className: "ranking-row-value" }, [
      el("strong", { text: metricValue(member, tab) }),
      extra,
    ]),
  ]);

  if (comBarra) {
    const bar = el("span", {
      className: `progress rel-${faixaDe(member.percent)}`,
      style: `--p:${proporcao.toFixed(4)}`,
      "aria-hidden": "true",
    }, [el("i")]);
    row.append(bar);
  }
  return row;
}

function faixaDe(percent) {
  if (percent >= 80) return "alta";
  if (percent >= 50) return "media";
  return "baixa";
}

function linhasDoRanking(members, tab, range) {
  const rotulo = rankingTabs().find((item) => item.id === tab)?.label ?? tab;
  const sorted = sortedMembers(members, tab);
  const cabecalho = [t("rank.export.header", { tab: rotulo })];
  if (tab === "participation" && range) {
    cabecalho.push(t("rank.export.period", {
      from: toInputDay(range.weekStart),
      to: toInputDay(range.weekEnd),
    }));
  }
  cabecalho.push("");
  const largura = Math.max(8, ...sorted.map((m) => m.nick.length));
  const larguraValor = Math.max(4, ...sorted.map((m) => metricValue(m, tab).length));
  const linhas = sorted.map((m, i) => {
    const posicao = `${String(i + 1).padStart(2, " ")}º`;
    const nick = m.nick.padEnd(largura, " ");
    const valor = metricValue(m, tab).padStart(larguraValor, " ");
    const extra = tab === "participation"
      ? (semComoMedir(m)
        ? `  ${t("rank.joinedLaterExport")}`
        : `  (${t("rank.activitiesRatio", { participated: m.participatedCount, total: m.totalCount })})`)
      : `  ${m.className} · Lv. ${m.level}`;
    return `${posicao}  ${nick}  ${valor}${extra}`;
  });
  return [...cabecalho, ...linhas].join("\n");
}

function baixarTxt(nome, texto) {
  const blob = new Blob([texto], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = el("a", { href: url, download: nome });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function rankingView({ api }) {
  const root = el("div", { className: "ranking-page" });
  let members = [];
  let range = null;
  let activeTab = memory.tab;
  let filterOpen = false;
  let booted = false;
  let timer = null;
  let lastFrom;
  let lastTo;

  const results = el("div", { className: "ranking-results" }, [
    el("p", { className: "muted", text: t("rank.loading") }),
  ]);
  const dateWrap = el("div", { className: "ranking-date-wrap" });

  function renderResults({ animate = true } = {}) {
    memory.tab = activeTab;
    root.querySelectorAll("[data-tab]").forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === activeTab);
    });
    const filterBtn = root.querySelector("#ranking-filter-toggle");
    if (filterBtn) {
      filterBtn.hidden = activeTab !== "participation";
      filterBtn.classList.toggle("active", filterOpen);
    }

    dateWrap.replaceChildren();
    if (activeTab === "participation" && filterOpen && range) {
      const from = el("input", {
        className: "input",
        type: "date",
        id: "ranking-date-from",
        value: toInputDay(range.weekStart),
      });
      const to = el("input", {
        className: "input",
        type: "date",
        id: "ranking-date-to",
        value: toInputDay(range.weekEnd),
      });
      dateWrap.append(
        el("div", { className: "ranking-date-filter" }, [
          el("label", { className: "auction-field" }, [t("rank.date.from"), from]),
          el("label", { className: "auction-field" }, [t("rank.date.to"), to]),
          el("button", {
            className: "btn btn-small",
            type: "button",
            onClick: async () => {
              if (!from.value || !to.value) return;
              await refresh(from.value, to.value);
            },
          }, [t("rank.filter.apply")]),
          el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => {
              lastFrom = undefined;
              lastTo = undefined;
              refresh();
            },
          }, [t("rank.filter.last10")]),
        ]),
      );
    }

    if (!members.length) {
      results.replaceChildren(el("div", { className: "empty-state" }, [
        el("h3", { text: t("rank.empty.title") }),
        el("p", { className: "muted", text: t("rank.empty.lede") }),
      ]));
      return;
    }

    const sorted = sortedMembers(members, activeTab);
    const maior = sorted.length ? valorBruto(sorted[0], activeTab) : 0;
    const top3 = sorted.slice(0, 3);
    const rest = sorted.slice(3);
    const podium = el("div", { className: "ranking-podium" }, [
      top3[1] ? podiumCard(top3[1], 2, activeTab) : el("div"),
      top3[0] ? podiumCard(top3[0], 1, activeTab) : el("div"),
      top3[2] ? podiumCard(top3[2], 3, activeTab) : el("div"),
    ]);

    const list = rest.length
      ? el("div", { className: "ranking-list stagger" }, rest.map((member, index) => (
        rankRow(member, index + 4, activeTab, index, maior)
      )))
      : null;

    results.replaceChildren(el("div", { className: "ranking-tela" }, [podium, list]));
    if (animate) animarContagem(results);
  }

  async function refresh(from, to) {
    if (arguments.length >= 1) {
      lastFrom = from;
      lastTo = to;
    }
    try {
      const query = lastFrom && lastTo
        ? `?from=${encodeURIComponent(lastFrom)}&to=${encodeURIComponent(lastTo)}`
        : "";
      const data = await api(`/api/ranking${query}`);
      const next = data.members || [];
      const changed = JSON.stringify(next.map((m) => [m.discordId, m.dkp, m.power, m.percent]))
        !== JSON.stringify(members.map((m) => [m.discordId, m.dkp, m.power, m.percent]));
      members = next;
      range = { weekStart: data.weekStart, weekEnd: data.weekEnd };
      if (!booted) {
        booted = true;
        renderResults({ animate: true });
      } else if (changed) {
        renderResults({ animate: false });
      }
    } catch (err) {
      if (!booted) {
        results.replaceChildren(el("div", { className: "alert", text: err.message || t("rank.error.load") }));
      }
    }
  }

  const chips = rankingTabs().map((tab) => el("button", {
    type: "button",
    className: `filter-chip${activeTab === tab.id ? " active" : ""}`,
    "data-tab": tab.id,
    onClick: () => {
      activeTab = tab.id;
      renderResults();
    },
  }, [tabIcon(tab.id), document.createTextNode(tab.label)]));

  root.replaceChildren(
    el("header", { className: "page-head" }, [
      el("p", { className: "kicker", text: t("act.kicker") }),
      el("h1", { text: t("rank.title") }),
      el("p", { className: "lede", text: t("rank.lede") }),
    ]),
    el("div", { className: "panel ranking-panel" }, [
      el("div", { className: "ranking-toolbar" }, [
        el("div", { className: "filter-chip-row", id: "ranking-tabs" }, chips),
        el("div", { className: "ranking-toolbar-actions" }, [
          el("button", {
            className: "btn btn-ghost btn-small icon-btn",
            type: "button",
            id: "ranking-export",
            title: t("rank.export.title"),
            onClick: () => {
              if (!members.length) return;
              baixarTxt(`ranking-${activeTab}-${stamp()}.txt`, linhasDoRanking(members, activeTab, range));
            },
          }, [downloadIcon()]),
          el("button", {
            className: "btn btn-ghost btn-small icon-btn",
            type: "button",
            id: "ranking-filter-toggle",
            title: t("rank.filter.title"),
            hidden: activeTab !== "participation" ? "hidden" : undefined,
            onClick: () => {
              filterOpen = !filterOpen;
              renderResults();
            },
          }, [filterIcon()]),
        ]),
      ]),
      dateWrap,
      results,
    ]),
  );

  refresh();
  timer = setInterval(() => {
    refresh().catch(() => {});
  }, 8000);
  root.cleanup = () => clearInterval(timer);
  return root;
}
