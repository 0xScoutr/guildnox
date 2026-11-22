import { t } from "./i18n.js";

const number = new Intl.NumberFormat("pt-BR");

function auctionStatusMap() {
  return {
    live: t("auc.status.live"),
    paused: t("auc.status.paused"),
    upcoming: t("auc.status.upcoming"),
    ended: t("auc.status.ended"),
  };
}

function auctionFilters() {
  return [
    { id: "live", label: t("auc.filter.live") },
    { id: "bid", label: t("auc.filter.bid") },
    { id: "upcoming", label: t("auc.filter.upcoming") },
    { id: "ended", label: t("auc.filter.ended") },
    { id: "won", label: t("auc.filter.won") },
    { id: "favorites", label: t("auc.filter.favorites") },
  ];
}

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
  if (ms <= 0) return t("auc.countdown.closing");
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
  if (filter === "favorites") return Boolean(auction.isFavorite);
  return true;
}

function favoriteButton(api, auction, onChanged) {
  let active = Boolean(auction.isFavorite);
  const button = el("button", {
    type: "button",
    className: `auction-favorite-btn${active ? " active" : ""}`,
    title: active ? t("auc.favorite.remove") : t("auc.favorite.add"),
    "aria-label": active ? t("auc.favorite.remove") : t("auc.favorite.add"),
    onClick: async (event) => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      const next = !active;
      try {
        await api(`/api/auctions/${auction.id}/favorite`, {
          method: active ? "DELETE" : "POST",
        });
        active = next;
        auction.isFavorite = next;
        button.classList.toggle("active", next);
        button.title = next ? t("auc.favorite.remove") : t("auc.favorite.add");
        button.setAttribute("aria-label", button.title);
        await onChanged();
      } catch {
        /* keep previous state */
      } finally {
        button.disabled = false;
      }
    },
  });
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 17.3l-6.18 3.73 1.64-7.03L2 9.24l7.19-.61L12 2l2.81 6.63 7.19.61-5.46 4.76 1.64 7.03z"/></svg>`;
  return button;
}

function matchesSearch(auction, query) {
  const q = fold(query.trim());
  if (!q) return true;
  return fold(auction.itemName).includes(q) || fold(auction.description).includes(q);
}

function statusBadge(auction) {
  return el("span", {
    className: `auction-status status-${auction.status}`,
    text: auctionStatusMap()[auction.status] || auction.status,
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
      ? t("auc.price.noBids")
      : t("auc.price.winner", {
        nick: auction.highestBidderNick || "—",
        amount: number.format(auction.currentBid),
      });
  }
  if (auction.currentBid == null) {
    return t("auc.price.startsAt", { amount: number.format(auction.startingBid) });
  }
  const bidder = auction.highestBidderNick
    ? t("auc.price.bidderSuffix", { nick: auction.highestBidderNick })
    : "";
  return t("auc.price.currentBid", {
    amount: number.format(auction.currentBid),
    bidder,
  });
}

function startWhenKey(auction) {
  const date = new Date(auction.startsAt);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 16);
}

function startWhenLine(auction) {
  if (!auction?.startsAt) return null;
  const when = formatWhen(auction.startsAt);
  if (when === "—") return null;
  return t("auc.card.startsWhen", { when });
}

function auctionMetaLines(auction, priceText = priceLine(auction)) {
  const when = startWhenLine(auction);
  return el("div", { className: "auction-card-meta" }, [
    el("div", { className: "muted", text: priceText }),
    when ? el("div", { className: "muted auction-card-when", text: when }) : null,
  ]);
}

function auctionGroupKey(auction) {
  return [
    fold(auction.itemName).trim(),
    String(auction.startingBid ?? ""),
    String(auction.quantity || 1),
    auction.status || "",
    startWhenKey(auction),
  ].join("|");
}

function groupAuctions(list) {
  const map = new Map();
  for (const auction of list) {
    const key = auctionGroupKey(auction);
    let group = map.get(key);
    if (!group) {
      group = { key, auctions: [] };
      map.set(key, group);
    }
    group.auctions.push(auction);
  }
  return [...map.values()].map((group) => {
    const auctions = group.auctions.slice().sort((a, b) => Number(a.id) - Number(b.id));
    const representative = auctions.find((a) => a.hasImage) || auctions[0];
    return { key: group.key, auctions, representative };
  });
}

function groupPriceLine(group) {
  const { auctions, representative } = group;
  if (auctions.length === 1) return priceLine(representative);

  const bids = auctions.map((a) => a.currentBid).filter((v) => v != null);
  if (bids.length === 0) {
    return t("auc.group.startsAt", {
      count: auctions.length,
      amount: number.format(representative.startingBid),
    });
  }
  const minBid = Math.min(...bids.map(Number));
  const open = auctions.filter((a) => a.currentBid == null).length;
  if (open > 0) {
    return t("auc.group.fromBidOpen", {
      count: auctions.length,
      amount: number.format(Math.min(minBid, representative.startingBid)),
      open,
    });
  }
  return t("auc.group.fromBid", {
    count: auctions.length,
    amount: number.format(minBid),
  });
}

function openAuctionGroupPicker(group, { api, apiBase, onChanged, onOpen }) {
  const dialog = el("dialog", { className: "sheet auction-group-sheet" });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const title = group.representative.quantity > 1
    ? `${group.representative.itemName} ×${group.representative.quantity}`
    : group.representative.itemName;

  const rows = group.auctions.map((auction, index) => {
    const classes = ["auction-group-row"];
    if (isOutbid(auction)) classes.push("outbid");
    else if (auction.youAreHighestBidder && isBidInPlay(auction)) classes.push("winning");

    const fav = favoriteButton(api, auction, async () => {
      await onChanged?.();
    });
    fav.addEventListener("click", (event) => event.stopPropagation());

    return el("div", {
      className: classes.join(" "),
      role: "button",
      tabindex: "0",
      onClick: () => {
        dialog.close();
        onOpen(auction.id);
      },
      onKeydown: (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          dialog.close();
          onOpen(auction.id);
        }
      },
    }, [
      el("div", { className: "auction-group-row-main" }, [
        el("strong", { text: t("auc.group.unit", { n: index + 1 }) }),
        el("span", { className: "muted", text: priceLine(auction) }),
        (() => {
          const when = startWhenLine(auction);
          return when ? el("span", { className: "muted auction-card-when", text: when }) : null;
        })(),
      ]),
      el("div", { className: "auction-group-row-side" }, [
        fav,
        statusBadge(auction),
      ]),
    ]);
  });

  dialog.replaceChildren(
    el("div", { className: "sheet-head" }, [
      el("h2", { text: title }),
      el("button", {
        className: "btn btn-ghost btn-small",
        type: "button",
        onClick: () => dialog.close(),
      }, [t("close")]),
    ]),
    el("p", {
      className: "muted auction-hint",
      text: t("auc.group.pickHint", { count: group.auctions.length }),
    }),
    el("div", { className: "auction-group-list" }, rows),
  );
  dialog.showModal();
}

function auctionCard(auction, { onOpen, api, apiBase, onChanged }) {
  const classes = ["auction-card"];
  if (isOutbid(auction)) classes.push("outbid");
  else if (auction.youAreHighestBidder && isBidInPlay(auction)) classes.push("winning");

  const card = el("div", {
    className: classes.join(" "),
    role: "button",
    tabindex: "0",
    onClick: () => onOpen(auction.id),
    onKeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onOpen(auction.id);
      }
    },
  }, [
    el("div", { className: "auction-card-header" }, [
      auctionImage(apiBase, auction),
      el("div", { className: "auction-card-body" }, [
        el("div", { className: "auction-card-title-row" }, [
          el("div", { className: "auction-card-title", text: auction.quantity > 1 ? `${auction.itemName} ×${auction.quantity}` : auction.itemName }),
          favoriteButton(api, auction, onChanged),
        ]),
        auctionMetaLines(auction),
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
      text: t("auc.card.outbid", {
        amount: number.format(auction.currentBid),
        bidder: auction.highestBidderNick
          ? t("auc.card.outbidBidder", { nick: auction.highestBidderNick })
          : "",
      }),
    }));
  } else if (auction.youAreHighestBidder && isBidInPlay(auction)) {
    card.append(el("div", {
      className: "auction-card-bid-status",
      text: t("auc.card.leading", { amount: number.format(auction.currentBid) }),
    }));
  }

  return card;
}

function auctionGroupCard(group, { onOpen, api, apiBase, onChanged }) {
  if (group.auctions.length === 1) {
    return auctionCard(group.representative, { onOpen, api, apiBase, onChanged });
  }

  const anyOutbid = group.auctions.some(isOutbid);
  const anyWinning = group.auctions.some((a) => a.youAreHighestBidder && isBidInPlay(a));
  const classes = ["auction-card", "auction-card-group"];
  if (anyOutbid) classes.push("outbid");
  else if (anyWinning) classes.push("winning");

  const openGroup = () => openAuctionGroupPicker(group, { api, apiBase, onChanged, onOpen });

  const card = el("div", {
    className: classes.join(" "),
    role: "button",
    tabindex: "0",
    onClick: openGroup,
    onKeydown: (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openGroup();
      }
    },
  }, [
    el("div", { className: "auction-card-header" }, [
      auctionImage(apiBase, group.representative),
      el("div", { className: "auction-card-body" }, [
        el("div", { className: "auction-card-title-row" }, [
          el("div", { className: "auction-card-title", text: group.representative.quantity > 1
            ? `${group.representative.itemName} ×${group.representative.quantity}`
            : group.representative.itemName }),
          el("span", {
            className: "auction-group-count",
            text: `×${group.auctions.length}`,
            title: t("auc.group.countTitle", { count: group.auctions.length }),
          }),
        ]),
        auctionMetaLines(group.representative, groupPriceLine(group)),
      ]),
      el("div", { className: "auction-card-status-stack" }, [
        statusBadge(group.representative),
      ]),
    ]),
  ]);

  if (anyOutbid) {
    card.append(el("div", {
      className: "auction-card-bid-status",
      text: t("auc.group.someOutbid"),
    }));
  } else if (anyWinning) {
    card.append(el("div", {
      className: "auction-card-bid-status",
      text: t("auc.group.someLeading"),
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

const imageUrlCache = new Map();

async function compressImageFile(file) {
  if (!file || !String(file.type || "").startsWith("image/")) {
    throw new Error(t("auc.error.imageType"));
  }
  if (file.size > 8 * 1024 * 1024) {
    throw new Error(t("auc.error.imageSize"));
  }
  const bitmap = await createImageBitmap(file);
  const max = 720;
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  let quality = 0.76;
  let dataUrl = canvas.toDataURL("image/jpeg", quality);
  while (dataUrl.length > 380_000 && quality > 0.42) {
    quality -= 0.08;
    dataUrl = canvas.toDataURL("image/jpeg", quality);
  }
  if (dataUrl.length > 450_000) {
    throw new Error(t("auc.error.imageCompress"));
  }
  return dataUrl;
}

async function auctionImageSrc(apiBase, auctionId) {
  if (!apiBase) return null;
  if (imageUrlCache.has(auctionId)) return imageUrlCache.get(auctionId);
  const response = await fetch(`${apiBase}/api/auctions/${auctionId}/image`, {
    credentials: "include",
    cache: "force-cache",
  });
  if (!response.ok) return null;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  imageUrlCache.set(auctionId, url);
  return url;
}

export function auctionImage(apiBase, auction, { className = "auction-thumb", eager = false } = {}) {
  if (!auction?.hasImage) return null;
  const img = el("img", {
    className,
    alt: auction.itemName || t("auc.itemAlt"),
    loading: eager ? "eager" : "lazy",
  });
  auctionImageSrc(apiBase, auction.id).then((src) => {
    if (src) img.src = src;
  }).catch(() => {});
  return img;
}

let catalogCache = null;
let catalogPromise = null;

async function loadItemCatalog() {
  if (catalogCache) return catalogCache;
  if (!catalogPromise) {
    catalogPromise = fetch("/items/catalog.json")
      .then(async (response) => {
        if (!response.ok) throw new Error(`catalog ${response.status}`);
        const data = await response.json();
        catalogCache = Array.isArray(data?.items) ? data.items : [];
        return catalogCache;
      })
      .catch((err) => {
        catalogPromise = null;
        throw err;
      });
  }
  return catalogPromise;
}

async function compressImageFromUrl(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(t("auc.error.imageRead"));
  const blob = await response.blob();
  const type = blob.type || "image/png";
  const file = new File([blob], "catalog-item.png", { type });
  return compressImageFile(file);
}

function itemCatalogPicker({ onSelect }) {
  let items = [];
  let query = "";
  let selectedId = null;
  const listEl = el("div", {
    className: "item-picker-list",
    role: "listbox",
    "aria-label": t("auc.catalog.search"),
  });
  const search = el("input", {
    type: "search",
    className: "item-picker-search",
    placeholder: t("auc.catalog.search"),
    "aria-label": t("auc.catalog.search"),
    onInput: (event) => {
      query = event.target.value;
      renderList();
    },
  });

  function filtered() {
    const q = fold(query).trim();
    if (!q) return items;
    return items.filter((item) => fold(item.name).includes(q));
  }

  function renderList() {
    listEl.replaceChildren();
    if (!items.length) {
      listEl.append(el("div", { className: "item-picker-empty", text: t("auc.catalog.empty") }));
      return;
    }
    const rows = filtered();
    if (!rows.length) {
      listEl.append(el("div", { className: "item-picker-empty", text: t("auc.catalog.empty") }));
      return;
    }
    for (const item of rows) {
      const active = selectedId === item.id;
      listEl.append(el("button", {
        type: "button",
        className: `item-picker-option${active ? " is-active" : ""}`,
        role: "option",
        "aria-selected": active ? "true" : "false",
        "data-item-id": item.id,
        onClick: (event) => {
          event.preventDefault();
          selectedId = item.id;
          for (const option of listEl.querySelectorAll(".item-picker-option")) {
            const on = option.dataset.itemId === selectedId;
            option.classList.toggle("is-active", on);
            option.setAttribute("aria-selected", on ? "true" : "false");
          }
          onSelect?.(item);
        },
      }, [
        el("img", { src: item.image, alt: "", loading: "lazy" }),
        el("strong", { text: item.name }),
      ]));
    }
  }

  listEl.append(el("div", { className: "item-picker-empty", text: t("loading") }));
  loadItemCatalog()
    .then((loaded) => {
      items = loaded;
      renderList();
    })
    .catch(() => {
      items = [];
      listEl.replaceChildren(el("div", { className: "item-picker-empty", text: t("auc.catalog.empty") }));
    });

  return el("div", { className: "item-picker" }, [
    el("span", { className: "item-picker-label", text: t("auc.catalog.hint") }),
    search,
    listEl,
  ]);
}

function imagePickerField(state, { initialSrc = null } = {}) {
  const preview = el("div", { className: "auction-image-preview muted", text: t("auc.image.none") });
  if (state.touched == null) state.touched = false;

  function showEmpty(message = t("auc.image.none")) {
    preview.className = "auction-image-preview muted";
    preview.replaceChildren(document.createTextNode(message));
    clearBtn.hidden = true;
  }

  function showImage(src) {
    preview.className = "auction-image-preview has-image";
    preview.replaceChildren(el("img", { src, alt: t("auc.image.previewAlt") }));
    clearBtn.hidden = false;
  }

  const clearBtn = el("button", {
    className: "btn btn-ghost btn-small",
    type: "button",
    hidden: "hidden",
    onClick: () => {
      state.touched = true;
      state.imageData = null;
      state.catalogImageUrl = null;
      fileInput.value = "";
      showEmpty();
    },
  }, [t("auc.image.remove")]);
  const fileInput = el("input", {
    type: "file",
    accept: "image/jpeg,image/png,image/webp,image/*",
    onChange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      state.touched = true;
      state.catalogImageUrl = null;
      showEmpty(t("auc.image.compressing"));
      try {
        state.imageData = await compressImageFile(file);
        showImage(state.imageData);
      } catch (err) {
        state.imageData = null;
        fileInput.value = "";
        showEmpty(err.message || t("auc.error.imageRead"));
      }
    },
  });
  const root = el("div", { className: "auction-image-field" }, [
    el("span", { className: "auction-image-label", text: t("auc.field.photo") }),
    preview,
    el("div", { className: "auction-image-actions" }, [fileInput, clearBtn]),
  ]);
  root.setFromCatalogUrl = (url) => {
    state.touched = true;
    state.imageData = null;
    state.catalogImageUrl = url || null;
    fileInput.value = "";
    if (url) showImage(url);
    else showEmpty();
  };
  if (initialSrc) showImage(initialSrc);
  return root;
}

function openEditAuction(api, apiBase, detail, onDone) {
  const dialog = el("dialog", { className: "sheet" });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  const error = el("div", { className: "alert", hidden: "hidden" });
  const hasBids = detail.currentBid != null;
  const canEditStart = detail.status === "upcoming";
  const durationMs = new Date(detail.expiresAt).getTime() - new Date(detail.startsAt).getTime();
  const durationValue = Math.max(1, Math.round(durationMs / 60000));

  const itemName = el("input", {
    maxlength: "80",
    required: "required",
    value: detail.itemName || "",
  });
  const description = el("input", {
    maxlength: "500",
    placeholder: t("auc.placeholder.description"),
    value: detail.description || "",
  });
  const startingBid = el("input", {
    type: "number",
    min: "1",
    value: String(detail.startingBid || 1),
    ...(hasBids ? { disabled: "disabled" } : {}),
  });
  const quantity = el("input", { type: "number", min: "1", value: String(detail.quantity || 1) });
  const startsAt = el("input", {
    type: "datetime-local",
    required: "required",
    value: localDateTimeValue(new Date(detail.startsAt)),
    ...(canEditStart ? {} : { disabled: "disabled" }),
  });
  const durationMinutes = el("input", { type: "number", min: "1", value: String(durationValue) });
  const resetMinutes = el("input", {
    type: "number",
    min: "0",
    max: "120",
    value: String(detail.resetMinutes ?? 2),
  });
  const imageState = { imageData: null, catalogImageUrl: null, touched: false };
  const imageField = imagePickerField(imageState);
  if (detail.hasImage) {
    auctionImageSrc(apiBase, detail.id).then((src) => {
      if (src && !imageState.touched) {
        imageField.querySelector(".auction-image-preview")?.replaceChildren(
          el("img", { src, alt: t("auc.image.previewAlt") }),
        );
        const preview = imageField.querySelector(".auction-image-preview");
        if (preview) preview.className = "auction-image-preview has-image";
        const clearBtn = imageField.querySelector(".auction-image-actions .btn");
        if (clearBtn) clearBtn.hidden = false;
      }
    }).catch(() => {});
  }

  const save = el("button", { className: "btn btn-small", type: "submit" }, [t("save")]);
  const form = el("form", {}, [
    el("h2", { text: t("auc.edit") }),
    error,
    field(t("auc.field.item"), itemName),
    imageField,
    field(t("auc.field.description"), description),
    field(t("auc.field.startingBid"), startingBid),
    hasBids ? el("p", { className: "muted auction-hint", text: t("auc.edit.startingBidLocked") }) : null,
    field(t("auc.field.quantity"), quantity),
    field(t("auc.field.startsAt"), startsAt),
    canEditStart
      ? el("p", { className: "muted auction-hint", text: t("auc.hint.startsAt") })
      : el("p", { className: "muted auction-hint", text: t("auc.edit.startsAtLocked") }),
    field(t("auc.field.duration"), durationMinutes),
    field(t("auc.field.reset"), resetMinutes),
    el("div", { className: "sheet-actions" }, [
      el("button", {
        className: "btn btn-ghost btn-small",
        type: "button",
        onClick: () => dialog.close(),
      }, [t("cancel")]),
      save,
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    try {
      const payload = {
        itemName: String(itemName.value || "").trim(),
        description: description.value,
        quantity: Number(quantity.value),
        durationMinutes: Number(durationMinutes.value),
        resetMinutes: Number(resetMinutes.value),
      };
      if (!hasBids) payload.startingBid = Number(startingBid.value);
      if (canEditStart) {
        const start = new Date(startsAt.value);
        if (Number.isNaN(start.getTime())) {
          error.hidden = false;
          error.textContent = t("auc.error.startsAt");
          save.disabled = false;
          return;
        }
        payload.startsAt = start.toISOString();
      }
      if (imageState.touched) {
        if (imageState.catalogImageUrl) {
          payload.imageData = await compressImageFromUrl(imageState.catalogImageUrl);
        } else {
          payload.imageData = imageState.imageData || null;
        }
      }
      await api(`/api/auctions/${detail.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (imageState.touched) {
        const old = imageUrlCache.get(detail.id);
        if (old) URL.revokeObjectURL(old);
        imageUrlCache.delete(detail.id);
      }
      dialog.close();
      await onDone();
    } catch (err) {
      error.hidden = false;
      error.textContent = err.message || t("auc.editFail");
      save.disabled = false;
    }
  });

  dialog.replaceChildren(form);
  dialog.showModal();
}

export function openCreateAuction(api, onDone) {
  const dialog = el("dialog", { className: "sheet" });
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());

  function showChooser() {
    dialog.replaceChildren(
      el("div", { className: "auction-create-chooser" }, [
        el("h2", { text: t("auc.new") }),
        el("p", { className: "muted auction-hint", text: t("auc.create.chooseHint") }),
        el("button", {
          type: "button",
          className: "auction-create-option",
          onClick: () => showForm("catalog"),
        }, [
          el("strong", { text: t("auc.create.modeCatalog") }),
          el("span", { text: t("auc.create.modeCatalogHint") }),
        ]),
        el("button", {
          type: "button",
          className: "auction-create-option",
          onClick: () => showForm("manual"),
        }, [
          el("strong", { text: t("auc.create.modeManual") }),
          el("span", { text: t("auc.create.modeManualHint") }),
        ]),
        el("div", { className: "sheet-actions" }, [
          el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => dialog.close(),
          }, [t("cancel")]),
        ]),
      ]),
    );
  }

  function showForm(mode) {
    const useCatalog = mode === "catalog";
    const error = el("div", { className: "alert", hidden: "hidden" });
    const selected = { name: "", imageUrl: null };
    const description = el("input", {
      maxlength: "500",
      placeholder: t("auc.placeholder.description"),
    });
    const imageState = { imageData: null, catalogImageUrl: null };
    const startingBid = el("input", { type: "number", min: "1", value: "10" });
    const copies = el("input", { type: "number", min: "1", max: "50", value: "1" });
    const quantity = el("input", { type: "number", min: "1", value: "1" });
    const startsAt = el("input", {
      type: "datetime-local",
      required: "required",
      value: localDateTimeValue(),
    });
    const durationMinutes = el("input", { type: "number", min: "1", value: "30" });
    const resetMinutes = el("input", { type: "number", min: "0", max: "120", value: "2" });
    const save = el("button", { className: "btn btn-small", type: "submit" }, [t("auc.create.submit")]);

    function refreshSubmitLabel() {
      const n = Number(copies.value) || 1;
      save.textContent = n > 1 ? t("auc.create.submitMany", { count: n }) : t("auc.create.submit");
    }
    copies.addEventListener("input", refreshSubmitLabel);

    const children = [
      el("h2", { text: useCatalog ? t("auc.create.modeCatalog") : t("auc.create.modeManual") }),
      error,
    ];

    const itemName = el("input", {
      maxlength: "80",
      required: "required",
      placeholder: t("auc.placeholder.itemName"),
    });
    let imageField = null;
    let selectedPreview = null;

    if (useCatalog) {
      selectedPreview = el("div", {
        className: "auction-catalog-selected muted",
        text: t("auc.catalog.noneSelected"),
      });
      children.push(
        itemCatalogPicker({
          onSelect: (item) => {
            selected.name = String(item.name || "").slice(0, 80);
            selected.imageUrl = item.image || null;
            itemName.value = selected.name;
            itemName.dispatchEvent(new Event("input", { bubbles: true }));
            selectedPreview.className = "auction-catalog-selected has-item";
            selectedPreview.replaceChildren(
              el("img", { src: item.image, alt: "", loading: "lazy" }),
              el("span", { text: t("auc.catalog.photoLocked") }),
            );
          },
        }),
        field(t("auc.field.item"), itemName),
        el("div", { className: "auction-field" }, [
          el("span", { text: t("auc.field.photo") }),
          selectedPreview,
        ]),
      );
    } else {
      imageField = imagePickerField(imageState);
      children.push(field(t("auc.field.item"), itemName), imageField);
    }

    children.push(
      field(t("auc.field.description"), description),
      field(t("auc.field.startingBid"), startingBid),
      field(t("auc.field.copies"), copies),
      el("p", { className: "muted auction-hint", text: t("auc.hint.copies") }),
      field(t("auc.field.quantity"), quantity),
      el("p", { className: "muted auction-hint", text: t("auc.hint.quantity") }),
      field(t("auc.field.startsAt"), startsAt),
      el("p", { className: "muted auction-hint", text: t("auc.hint.startsAt") }),
      field(t("auc.field.duration"), durationMinutes),
      field(t("auc.field.reset"), resetMinutes),
      el("div", { className: "sheet-actions" }, [
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: () => showChooser(),
        }, [t("auc.create.back")]),
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: () => dialog.close(),
        }, [t("cancel")]),
        save,
      ]),
    );

    const form = el("form", {}, children);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      save.disabled = true;
      const start = new Date(startsAt.value);
      if (Number.isNaN(start.getTime())) {
        error.hidden = false;
        error.textContent = t("auc.error.startsAt");
        save.disabled = false;
        return;
      }
      try {
        let imageData = null;
        if (useCatalog) {
          if (!selected.imageUrl) {
            error.hidden = false;
            error.textContent = t("auc.catalog.required");
            save.disabled = false;
            return;
          }
          imageData = await compressImageFromUrl(selected.imageUrl);
        } else {
          imageData = imageState.imageData || null;
        }
        const name = String(itemName.value || "").trim();
        const copiesCount = Number(copies.value);
        if (!Number.isInteger(copiesCount) || copiesCount < 1 || copiesCount > 50) {
          error.hidden = false;
          error.textContent = t("auc.error.copies");
          save.disabled = false;
          return;
        }
        await api("/api/auctions", {
          method: "POST",
          body: JSON.stringify({
            itemName: name,
            description: description.value,
            imageData,
            startingBid: Number(startingBid.value),
            copies: copiesCount,
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

    dialog.replaceChildren(form);
  }

  showChooser();
  dialog.showModal();
}

export function openAuctionDetail(api, apiBase, auctionId, me, onChanged, onMemberUpdate) {
  const body = el("div", { className: "auction-detail" }, [el("p", { className: "muted", text: t("loading") })]);
  const dialog = el("dialog", { className: "sheet auction-sheet" }, [
    el("div", { className: "sheet-head" }, [
      el("h2", { text: t("auc.title") }),
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("close")]),
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

  let lastStatus = null;

  async function load() {
    try {
      const detail = await api(`/api/auctions/${auctionId}`);
      if (lastStatus && lastStatus !== "ended" && detail.status === "ended") {
        await onMemberUpdate?.();
      }
      lastStatus = detail.status;
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
        el("h3", { text: t("auc.bids.latest") }),
        ...detail.bids.slice(0, 10).map((bid) => el("div", { className: "auction-bid-row" }, [
          el("span", { text: bid.nick }),
          el("strong", { text: `${number.format(bid.amount)} DKP` }),
        ])),
      ])
      : null;

    let action = el("p", { className: "muted", text: auctionStatusMap()[detail.status] || detail.status });
    if (detail.status === "live") {
      if (detail.youAreHighestBidder) {
        action = el("p", { className: "muted", text: t("auc.bid.highestWait") });
      } else {
        const amount = el("input", {
          id: "bid-amount",
          type: "number",
          min: String(detail.minNextBid),
          value: preserved || String(detail.minNextBid),
        });
        const error = el("div", { className: "alert", hidden: "hidden" });
        const submit = el("button", { className: "btn", type: "submit" }, [t("auc.bid.submit")]);
        const form = el("form", { id: "bid-form" }, [
          error,
          field(t("auc.bid.fieldMin", { min: number.format(detail.minNextBid) }), amount),
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
            await onMemberUpdate?.();
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
          submit.textContent = insufficient ? t("auc.bid.insufficient") : t("auc.bid.submit");
        });
        action = form;
      }
    } else if (detail.status === "upcoming") {
      action = el("p", { className: "muted", text: t("auc.startsAtMsg", { when: formatWhen(detail.startsAt) }) });
    } else if (detail.status === "ended") {
      action = el("p", {
        className: "muted",
        text: detail.highestBidderNick
          ? t("auc.ended.winner", {
            nick: detail.highestBidderNick,
            amount: number.format(detail.currentBid),
          })
          : t("auc.ended.noBids"),
      });
    }

    const officer = me.role === "master" || me.role === "admin";
    const adminRow = officer
      ? el("div", { className: "sheet-actions" }, [
        detail.status !== "ended"
          ? el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: () => openEditAuction(api, apiBase, detail, async () => {
              await onChanged();
              await load();
            }),
          }, [t("edit")])
          : null,
        detail.status !== "ended"
          ? el("button", {
            className: "btn btn-ghost btn-small",
            type: "button",
            onClick: async () => {
              await api(`/api/auctions/${auctionId}/${detail.status === "paused" ? "resume" : "pause"}`, { method: "POST" });
              await onChanged();
              await load();
            },
          }, [detail.status === "paused" ? t("auc.resume") : t("auc.pause")])
          : null,
        el("button", {
          className: "btn btn-ghost btn-small",
          type: "button",
          onClick: async () => {
            if (!confirm(t("auc.deleteConfirm", { name: detail.itemName }))) return;
            try {
              await api(`/api/auctions/${auctionId}`, { method: "DELETE" });
              dialog.close();
              await onMemberUpdate?.();
              await onChanged();
            } catch (err) {
              alert(err.message || t("auc.deleteFail"));
            }
          },
        }, [t("auc.delete")]),
      ])
      : null;

    lastMin = detail.minNextBid;
    body.replaceChildren(
      auctionImage(apiBase, detail, { className: "auction-detail-image", eager: true }),
      el("div", { className: "auction-detail-top" }, [
        el("div", {}, [
          el("div", { className: "auction-card-title-row" }, [
            el("h3", { text: detail.quantity > 1 ? `${detail.itemName} ×${detail.quantity}` : detail.itemName }),
            favoriteButton(api, detail, async () => {
              await onChanged();
              await load();
            }),
          ]),
          el("p", { className: "muted", text: detail.description || t("auc.noDescription") }),
        ]),
        el("div", { className: "auction-card-status-stack" }, [
          countdownBadge(detail),
          statusBadge(detail),
        ]),
      ]),
      el("div", { className: "auction-stats" }, [
        el("div", { className: "stat" }, [
          el("span", { text: t("auc.stat.currentBid") }),
          el("strong", { text: detail.currentBid == null ? t("auc.stat.none") : `${number.format(detail.currentBid)} DKP` }),
          detail.highestBidderNick ? el("em", { className: "muted", text: detail.highestBidderNick }) : null,
        ]),
        el("div", { className: "stat" }, [
          el("span", { text: t("auc.stat.yourDkp") }),
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

export function auctionsView({ api, apiBase, me, onMemberUpdate }) {
  const root = el("div", { className: "auctions-page" });
  let auctions = [];
  let filter = memory.filter;
  let search = memory.search;
  let timer = null;
  let tick = null;
  let booted = false;
  let knownStatus = new Map();
  let knownLeading = new Map();

  async function refresh() {
    const data = await api("/api/auctions");
    const next = data.auctions;
    let walletChanged = false;
    for (const auction of next) {
      const previous = knownStatus.get(auction.id);
      const wasLeading = knownLeading.get(auction.id);
      if (previous && previous !== "ended" && auction.status === "ended") walletChanged = true;
      if (wasLeading === true && !auction.youAreHighestBidder) walletChanged = true;
      if (wasLeading === false && auction.youAreHighestBidder) walletChanged = true;
      knownStatus.set(auction.id, auction.status);
      knownLeading.set(auction.id, Boolean(auction.youAreHighestBidder));
    }
    auctions = next;
    if (walletChanged) await onMemberUpdate?.();
    if (!booted) {
      booted = true;
      draw();
    } else {
      auctionFilters().forEach((item) => {
        const count = auctions.filter((auction) => matchesFilter(auction, item.id)).length;
        const chip = root.querySelector(`.filter-chip[data-filter="${item.id}"]`);
        if (chip) chip.textContent = `${item.label}${count ? ` (${count})` : ""}`;
      });
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

    const chips = auctionFilters().map((item) => {
      const count = auctions.filter((auction) => matchesFilter(auction, item.id)).length;
      return el("button", {
        type: "button",
        className: `filter-chip${filter === item.id ? " active" : ""}`,
        "data-filter": item.id,
        onClick: () => { filter = item.id; draw(); },
      }, [`${item.label}${count ? ` (${count})` : ""}`]);
    });

    const searchInput = el("input", {
      className: "input",
      type: "search",
      placeholder: t("search"),
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
          el("p", { className: "kicker", text: t("act.kicker") }),
          el("h1", { text: t("auc.title") }),
          el("p", { className: "lede", text: t("auc.lede") }),
        ]),
        officer
          ? el("button", {
            className: "btn btn-small",
            type: "button",
            onClick: () => openCreateAuction(api, refresh),
          }, [t("auc.new")])
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
      box.replaceChildren(el("p", { className: "muted", text: t("act.noneFilter") }));
      return;
    }
    const openDetail = (id) => openAuctionDetail(api, apiBase, id, me, refresh, onMemberUpdate);
    box.replaceChildren(el("div", { className: "auction-grid" }, groupAuctions(list).map((group) => auctionGroupCard(group, {
      api,
      apiBase,
      onChanged: refresh,
      onOpen: openDetail,
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
