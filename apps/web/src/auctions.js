const number = new Intl.NumberFormat("pt-BR");
const STATUS = {
  live: "Ao vivo",
  paused: "Pausado",
  upcoming: "Em breve",
  ended: "Encerrado",
};

const FILTERS = [
  { id: "live", label: "Ao vivo" },
  { id: "bid", label: "Bidados" },
  { id: "upcoming", label: "Em breve" },
  { id: "ended", label: "Encerrados" },
  { id: "won", label: "Ganhos" },
];

const memory = { filter: "live", search: "" };

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

function fold(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function formatWhen(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function formatCountdown(ms) {
  if (ms <= 0) return "Encerrando…";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function tickCountdowns(root = document) {
  const now = Date.now();
  root.querySelectorAll("[data-countdown-until]").forEach((node) => {
    const left = new Date(node.dataset.countdownUntil).getTime() - now;
    const text = formatCountdown(left);
    if (node.textContent !== text) node.textContent = text;
  });
}

function isOutbid(auction) {
  return auction.hasYourBid && !auction.youAreHighestBidder && (auction.status === "live" || auction.status === "paused");
}

function isBidInPlay(auction) {
  return auction.hasYourBid && (auction.status === "live" || auction.status === "paused");
}

function matchesFilter(auction, filter) {
  if (filter === "live") return auction.status === "live" || auction.status === "paused";
  if (filter === "bid") return isBidInPlay(auction);
  if (filter === "upcoming") return auction.status === "upcoming";
  if (filter === "ended") return auction.status === "ended";
  if (filter === "won") return auction.status === "ended" && auction.youAreHighestBidder;
  return true;
}

function matchesSearch(auction, query) {
  const q = fold(query.trim());
  if (!q) return true;
  return fold(auction.itemName).includes(q) || fold(auction.description).includes(q);
}

function statusBadge(auction) {
  return el("span", {
    className: `auction-status status-${auction.status}`,
    text: STATUS[auction.status] || auction.status,
  });
}

function countdownBadge(auction) {
  if (auction.status !== "live") return null;
  return el("span", { className: "countdown-badge" }, [
    el("span", { "data-countdown-until": new Date(auction.effectiveExpiresAt).toISOString() }),
  ]);
}

function priceLine(auction) {
  if (auction.status === "ended") {
    return auction.currentBid == null
      ? "Sem lances"
      : `Vencedor: ${auction.highestBidderNick || "—"} · ${number.format(auction.currentBid)} DKP`;
  }
  if (auction.currentBid == null) return `Começa em ${number.format(auction.startingBid)} DKP`;
  return `Lance atual ${number.format(auction.currentBid)} DKP${auction.highestBidderNick ? ` · ${auction.highestBidderNick}` : ""}`;
}

function auctionCard(auction, onOpen) {
  const classes = ["auction-card"];
  if (isOutbid(auction)) classes.push("outbid");
  else if (auction.youAreHighestBidder && isBidInPlay(auction)) classes.push("winning");

  const card = el("button", {
    type: "button",
    className: classes.join(" "),
    onClick: () => onOpen(auction.id),
  }, [
    el("div", { className: "auction-card-header" }, [
      el("div", { className: "auction-card-body" }, [
        el("div", { className: "auction-card-title", text: auction.quantity > 1 ? `${auction.itemName} ×${auction.quantity}` : auction.itemName }),
        el("div", { className: "muted", text: priceLine(auction) }),
      ]),
      el("div", { className: "auction-card-status-stack" }, [
        countdownBadge(auction),
        statusBadge(auction),
      ]),
    ]),
  ]);

  if (isOutbid(auction)) {
    card.append(el("div", {
      className: "auction-card-bid-status",
      text: `Superado! Lance atual: ${number.format(auction.currentBid)} DKP${auction.highestBidderNick ? ` (${auction.highestBidderNick})` : ""}`,
    }));
  } else if (auction.youAreHighestBidder && isBidInPlay(auction)) {
    card.append(el("div", {
      className: "auction-card-bid-status",
      text: `Você está na frente — ${number.format(auction.currentBid)} DKP`,
    }));
  }

  return card;
}

function field(label, control) {
  return el("label", { className: "auction-field" }, [label, control]);
}

function localDateTimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function openCreateAuction(api, onDone) {
  const error = el("div", { className: "alert", hidden: "hidden" });
  const itemName = el("input", { maxlength: "80", required: "required", placeholder: "Nome do item" });
  const description = el("input", { maxlength: "500", placeholder: "Descrição (opcional)" });
  const startingBid = el("input", { type: "number", min: "1", value: "10" });
  const quantity = el("input", { type: "number", min: "1", value: "1" });
  const startsAt = el("input", { type: "datetime-local", required: "required", value: localDateTimeValue() });
  const durationMinutes = el("input", { type: "number", min: "1", value: "30" });
  const resetMinutes = el("input", { type: "number", min: "0", max: "120", value: "2" });
  const save = el("button", { className: "btn btn-small", type: "submit" }, ["Criar leilão"]);

  const form = el("form", {}, [
    el("h2", { text: "Novo leilão" }),
    error,
    field("Item", itemName),
    field("Descrição", description),
    field("Lance inicial (DKP)", startingBid),
    field("Quantidade", quantity),
    field("Começa em", startsAt),
    el("p", { className: "muted auction-hint", text: "Ex.: hoje às 22:00. Se deixar a hora atual, começa na hora." }),
    field("Duração (minutos)", durationMinutes),
    field("Extensão anti-snipe (minutos)", resetMinutes),
    el("div", { className: "sheet-actions" }, [
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, ["Cancelar"]),
      save,
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    const start = new Date(startsAt.value);
    if (Number.isNaN(start.getTime())) {
      error.hidden = false;
      error.textContent = "Informe a data e o horário de início.";
      save.disabled = false;
      return;
    }
    try {
      await api("/api/auctions", {
        method: "POST",
        body: JSON.stringify({
          itemName: itemName.value,
          description: description.value,
          startingBid: Number(startingBid.value),
          quantity: Number(quantity.value),
          startsAt: start.toISOString(),
          durationMinutes: Number(durationMinutes.value),
          resetMinutes: Number(resetMinutes.value),
        }),
      });
      dialog.close();
      await onDone();
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

export function openAuctionDetail(api, auctionId, me, onChanged) {
  const body = el("div", { className: "auction-detail" }, [el("p", { className: "muted", text: "Carregando…" })]);
  const dialog = el("dialog", { className: "sheet auction-sheet" }, [
    el("div", { className: "sheet-head" }, [
      el("h2", { text: "Leilão" }),
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, ["Fechar"]),
    ]),
    body,
  ]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => {
    clearInterval(poll);
    clearInterval(tick);
    dialog.remove();
  });
  dialog.showModal();

  let lastMin = null;

  async function load() {
    try {
      const detail = await api(`/api/auctions/${auctionId}`);
      render(detail);
    } catch (err) {
      body.replaceChildren(el("div", { className: "alert", text: err.message }));
    }
  }

  function render(detail) {
    const prev = body.querySelector("#bid-amount");
    const edited = prev && lastMin != null && prev.value !== String(lastMin);
    const preserved = edited ? prev.value : null;

    const bids = detail.bids.length
      ? el("div", { className: "auction-bids" }, [
        el("h3", { text: "Últimos lances" }),
        ...detail.bids.slice(0, 10).map((bid) => el("div", { className: "auction-bid-row" }, [
          el("span", { text: bid.nick }),
          el("strong", { text: `${number.format(bid.amount)} DKP` }),
        ])),
      ])
      : null;

    let action = el("p", { className: "muted", text: STATUS[detail.status] || detail.status });
    if (detail.status === "live") {
      if (detail.youAreHighestBidder) {
        action = el("p", { className: "muted", text: "Você já está com o lance mais alto. Aguarde alguém cobrir para poder aumentar." });
      } else {
        const amount = el("input", {
          id: "bid-amount",
          type: "number",
          min: String(detail.minNextBid),
          value: preserved || String(detail.minNextBid),
        });
        const error = el("div", { className: "alert", hidden: "hidden" });
        const submit = el("button", { className: "btn", type: "submit" }, ["Dar lance"]);
        const form = el("form", { id: "bid-form" }, [
          error,
          field(`Seu lance (mínimo ${number.format(detail.minNextBid)} DKP)`, amount),
          submit,
        ]);
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          error.hidden = true;
          submit.disabled = true;
          try {
            await api(`/api/auctions/${auctionId}/bid`, {
              method: "POST",
              body: JSON.stringify({ amount: Number(amount.value) }),
            });
            await onChanged();
            await load();
          } catch (err) {
            error.hidden = false;
            error.textContent = err.message;
            submit.disabled = false;
          }
        });
        amount.addEventListener("input", () => {
          const insufficient = Number(amount.value) > detail.yourAvailableDkp;
          submit.disabled = insufficient;
          submit.textContent = insufficient ? "Sem DKP suficiente" : "Dar lance";
        });
        action = form;
      }
    } else if (detail.status === "upcoming") {
      action = el("p", { className: "muted", text: `Começa em ${formatWhen(detail.startsAt)}.` });
    } else if (detail.status === "ended") {
      action = el("p", {
        className: "muted",
        text: detail.highestBidderNick
          ? `Encerrado — vencedor: ${detail.highestBidderNick} (${number.format(detail.currentBid)} DKP).`
          : "Encerrado sem lances.",
      });
    }

    const officer = me.role === "master" || me.role === "admin";
    const adminRow = officer && detail.status !== "ended"
      ? el("div", { className: "sheet-actions" }, [
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: async () => {
            await api(`/api/auctions/${auctionId}/${detail.status === "paused" ? "resume" : "pause"}`, { method: "POST" });
            await onChanged();
            await load();
          },
        }, [detail.status === "paused" ? "Retomar" : "Pausar"]),
      ])
      : null;

    lastMin = detail.minNextBid;
    body.replaceChildren(
      el("div", { className: "auction-detail-top" }, [
        el("div", {}, [
          el("h3", { text: detail.quantity > 1 ? `${detail.itemName} ×${detail.quantity}` : detail.itemName }),
          el("p", { className: "muted", text: detail.description || "Sem descrição." }),
        ]),
        el("div", { className: "auction-card-status-stack" }, [
          countdownBadge(detail),
          statusBadge(detail),
        ]),
      ]),
      el("div", { className: "auction-stats" }, [
        el("div", { className: "stat" }, [
          el("span", { text: "Lance atual" }),
          el("strong", { text: detail.currentBid == null ? "Nenhum" : `${number.format(detail.currentBid)} DKP` }),
          detail.highestBidderNick ? el("em", { className: "muted", text: detail.highestBidderNick }) : null,
        ]),
        el("div", { className: "stat" }, [
          el("span", { text: "Seu DKP disponível" }),
          el("strong", { text: number.format(detail.yourAvailableDkp) }),
        ]),
      ]),
      action,
      adminRow,
      bids,
    );
    tickCountdowns(body);
  }

  const poll = setInterval(load, 4000);
  const tick = setInterval(() => tickCountdowns(body), 1000);
  load();
}

export function auctionsView({ api, me }) {
  const root = el("div", { className: "auctions-page" });
  let auctions = [];
  let filter = memory.filter;
  let search = memory.search;
  let timer = null;
  let tick = null;
  let booted = false;

  async function refresh() {
    const data = await api("/api/auctions");
    auctions = data.auctions;
    if (!booted) {
      booted = true;
      draw();
    } else {
      const active = root.querySelector(".filter-chip.active");
      if (active) {
        // atualiza só contagens dos chips e a grade
        FILTERS.forEach((item) => {
          const count = auctions.filter((auction) => matchesFilter(auction, item.id)).length;
          const chip = [...root.querySelectorAll(".filter-chip")].find((node) => node.textContent.startsWith(item.label));
          if (chip) chip.textContent = `${item.label}${count ? ` (${count})` : ""}`;
        });
      }
      drawResults();
      tickCountdowns(root);
    }
  }

  function visible() {
    return auctions
      .filter((auction) => matchesFilter(auction, filter))
      .filter((auction) => matchesSearch(auction, search))
      .sort((a, b) => {
        if (filter === "bid") return Number(isOutbid(b)) - Number(isOutbid(a));
        return String(a.effectiveExpiresAt).localeCompare(String(b.effectiveExpiresAt));
      });
  }

  function draw() {
    memory.filter = filter;
    memory.search = search;
    const officer = me.role === "master" || me.role === "admin";
    const list = visible();

    const chips = FILTERS.map((item) => {
      const count = auctions.filter((auction) => matchesFilter(auction, item.id)).length;
      return el("button", {
        type: "button",
        className: `filter-chip${filter === item.id ? " active" : ""}`,
        onClick: () => { filter = item.id; draw(); },
      }, [`${item.label}${count ? ` (${count})` : ""}`]);
    });

    const searchInput = el("input", {
      className: "input",
      type: "search",
      placeholder: "Pesquisar…",
      value: search,
      onInput: (event) => {
        search = event.target.value;
        memory.search = search;
        drawResults();
      },
    });

    root.replaceChildren(
      el("header", { className: "page-head auctions-head" }, [
        el("div", {}, [
          el("p", { className: "kicker", text: "Guilda" }),
          el("h1", { text: "Leilão" }),
          el("p", { className: "lede", text: "Leilões de itens da guilda." }),
        ]),
        officer
          ? el("button", {
            className: "btn btn-small",
            type: "button",
            onClick: () => openCreateAuction(api, refresh),
          }, ["Novo leilão"])
          : null,
      ]),
      el("div", { className: "panel auction-toolbar" }, [
        searchInput,
        el("div", { className: "filter-chip-row" }, chips),
      ]),
      el("div", { className: "auctions-results" }),
    );

    drawResults(list);
    tickCountdowns(root);
  }

  function drawResults(list = visible()) {
    const box = root.querySelector(".auctions-results");
    if (!box) return;
    if (!list.length) {
      box.replaceChildren(el("p", { className: "muted", text: "Nada encontrado com esse filtro." }));
      return;
    }
    box.replaceChildren(el("div", { className: "auction-grid" }, list.map((auction) => auctionCard(auction, (id) => {
      openAuctionDetail(api, id, me, refresh);
    }))));
  }

  refresh().catch((err) => {
    root.replaceChildren(el("div", { className: "alert", text: err.message }));
  });

  timer = setInterval(() => {
    refresh().catch(() => {});
  }, 8000);
  tick = setInterval(() => tickCountdowns(root), 1000);

  root.cleanup = () => {
    clearInterval(timer);
    clearInterval(tick);
  };

  return root;
}
