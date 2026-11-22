import {
  ensureNotificationPermission,
  getSoundVolume,
  isSoundEnabled,
  notifyActivityOpened,
  setSoundEnabled,
  setSoundVolume,
  unlockActivityAudio,
  watchActivityOpenings,
} from "./activity-alert.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

const number = new Intl.NumberFormat("pt-BR");
/** Mesma regra da API: DKP fixo + 0,0015% do power. */
const ACTIVITY_POWER_BONUS_RATE = 0.000015;

function estimatedActivityDkp(baseDkp, power) {
  const base = Math.max(0, Number(baseDkp) || 0);
  const rawPower = Math.max(0, Number(power) || 0);
  return Math.max(0, Math.round(base + rawPower * ACTIVITY_POWER_BONUS_RATE));
}

function activityFilters() {
  return [
    { id: "open", label: t("act.filter.open") },
    { id: "upcoming", label: t("act.filter.upcoming") },
    { id: "mine", label: t("act.filter.mine") },
    { id: "ended", label: t("act.filter.ended") },
    { id: "all", label: t("act.filter.all") },
  ];
}
const memory = { filter: "open", search: "" };

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

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function localDateTimeValue(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function openedAt(activity) {
  return activity.openedAt || activity.startsAt || activity.createdAt;
}

function situationLabel(activity) {
  if (activity.finalizedAt) return { text: t("act.situation.finalized"), className: "activity-status status-ended" };
  if (activity.isOpen) return { text: t("act.situation.open"), className: "activity-status status-live" };
  if (activity.isScheduled) return { text: t("act.situation.scheduled"), className: "activity-status status-upcoming" };
  return { text: t("act.situation.closed"), className: "activity-status status-ended" };
}

function matchesFilter(activity, filter) {
  if (filter === "open") return Boolean(activity.isOpen);
  if (filter === "upcoming") return Boolean(activity.isScheduled);
  if (filter === "mine") return Boolean(activity.participated);
  if (filter === "ended") return Boolean(activity.finalizedAt) || (!activity.isOpen && !activity.isScheduled);
  return true;
}

function matchesSearch(activity, search) {
  const q = fold(search).trim();
  if (!q) return true;
  return fold(`${activity.name} ${formatWhen(openedAt(activity))}`).includes(q);
}

function field(label, control) {
  return el("label", { className: "auction-field" }, [label, control]);
}

function availableCell(activity) {
  if (activity.isOpen) {
    return el("span", { text: t("act.untilTime", { time: formatTime(activity.expiresAt) }) });
  }
  if (activity.isScheduled) {
    return el("span", { text: t("act.opens", { when: formatWhen(activity.scheduledAt) }) });
  }
  return el("span", { className: "muted", text: "—" });
}

function isEnded(activity) {
  return Boolean(activity.finalizedAt) || (!activity.isOpen && !activity.isScheduled);
}

function selfStatus(activity, { onParticipate }) {
  if (activity.participated) {
    return el("span", { className: "activity-badge", text: t("act.participated") });
  }
  if (activity.isOpen) {
    return el("button", {
      className: "btn btn-small",
      type: "button",
      onClick: (event) => onParticipate(activity, event.currentTarget),
    }, [t("act.participate")]);
  }
  if (activity.finalizedAt) {
    return el("span", { className: "activity-badge muted", text: t("act.didNot") });
  }
  if (activity.isScheduled) {
    return el("span", { className: "activity-badge pending", text: t("act.opens", { when: formatWhen(activity.scheduledAt) }) });
  }
  return el("span", { className: "activity-badge muted", text: t("act.deadline") });
}

function statusCell(activity, { officer, onParticipate, onReopen, onDelete }) {
  const status = selfStatus(activity, { onParticipate });
  if (!officer) return status;
  const actions = [status];
  if (isEnded(activity)) {
    actions.push(el("button", {
      className: "btn btn-ghost btn-small",
      type: "button",
      title: t("act.reopen"),
      onClick: (event) => onReopen(activity, event.currentTarget),
    }, [t("act.reopen")]));
  }
  actions.push(el("button", {
    className: "btn btn-ghost btn-small btn-danger",
    type: "button",
    title: t("act.delete"),
    onClick: (event) => onDelete(activity, event.currentTarget),
  }, [t("act.delete")]));
  return el("div", { className: "activity-status-actions" }, actions);
}

async function openParticipants(api, activity) {
  const body = el("div", { className: "activity-detail" }, [
    el("p", { className: "muted", text: t("loading") }),
  ]);
  const dialog = el("dialog", { className: "sheet activity-sheet" }, [
    el("div", { className: "sheet-head" }, [
      el("h2", { text: t("act.participantsTitle", { name: activity.name }) }),
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("close")]),
    ]),
    body,
  ]);
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();

  try {
    const data = await api(`/api/activities/${activity.id}/participants`);
    const list = data.participants || [];
    if (!list.length) {
      body.replaceChildren(el("p", { className: "muted", text: t("act.noParticipants") }));
      return;
    }
    body.replaceChildren(el("ul", { className: "participants-list" }, list.map((person) => {
      const row = el("li", { className: "participant-row" });
      if (person.avatarUrl) {
        row.append(el("img", { className: "participant-avatar", src: person.avatarUrl, alt: "" }));
      }
      row.append(el("span", { text: person.nick }));
      if (person.className) row.append(el("span", { className: "muted", text: person.className }));
      return row;
    })));
  } catch (err) {
    body.replaceChildren(el("div", { className: "alert", text: err.message }));
  }
}

function soundControls() {
  const wrap = el("div", {
    className: "som-atividade-linha",
    id: "som-atividade",
    title: isSoundEnabled() ? t("act.sound.titleOn") : t("act.sound.titleOff"),
  });

  function paint() {
    const on = isSoundEnabled();
    const volume = getSoundVolume();
    wrap.title = on ? t("act.sound.titleOn") : t("act.sound.titleOff");

    const select = el("select", {
      className: "select",
      id: "som-atividade-select",
      "aria-label": t("act.sound"),
      onChange: async (event) => {
        await setSoundEnabled(event.target.value === "1");
      },
    }, [
      el("option", { value: "1", text: t("act.soundOn") }),
      el("option", { value: "0", text: t("act.soundOff") }),
    ]);
    select.value = on ? "1" : "0";

    const range = el("input", {
      type: "range",
      id: "som-atividade-volume",
      min: "0",
      max: "100",
      step: "5",
      value: String(volume),
      "aria-label": t("act.sound.volumeAria"),
      disabled: on ? undefined : "disabled",
      onInput: (event) => {
        setSoundVolume(event.target.value);
        const pct = wrap.querySelector("#som-atividade-pct");
        if (pct) pct.textContent = `${getSoundVolume()}%`;
      },
      onChange: async () => {
        await unlockActivityAudio();
        notifyActivityOpened();
      },
    });

    const listen = el("button", {
      type: "button",
      className: `btn btn-ghost btn-small${on ? "" : " is-invisivel"}`,
      id: "som-atividade-ouvir",
      disabled: on ? undefined : "disabled",
      onClick: async () => {
        await unlockActivityAudio();
        await ensureNotificationPermission();
        notifyActivityOpened();
      },
    });
    listen.append(document.createTextNode(t("act.listen")));

    wrap.replaceChildren(
      el("label", { className: "filtro-inline" }, [
        el("span", { text: t("act.sound") }),
        select,
      ]),
      el("label", { className: `som-volume${on ? "" : " is-invisivel"}`, title: "Volume" }, [
        range,
        el("span", { className: "som-volume-pct", id: "som-atividade-pct", text: `${volume}%` }),
      ]),
      listen,
    );
  }

  function onPref() {
    if (!document.body.contains(wrap)) {
      window.removeEventListener("gc:som-atividade", onPref);
      return;
    }
    paint();
  }
  window.addEventListener("gc:som-atividade", onPref);
  paint();
  return wrap;
}

function readAudioAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const type = String(file?.type || "");
    const name = String(file?.name || "").toLowerCase();
    const byExt = /\.(mp3|wav|ogg|m4a|aac|webm)$/i.test(name);
    if (!file || (type && !type.startsWith("audio/") && !byExt) || (!type && !byExt)) {
      reject(new Error(t("act.audio.errorType")));
      return;
    }
    if (file.size > 1.3 * 1024 * 1024) {
      reject(new Error(t("act.audio.errorSize")));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error(t("act.audio.errorRead")));
    reader.readAsDataURL(file);
  });
}

export function openCreateActivity(api, onDone) {
  const error = el("div", { className: "alert", hidden: "hidden" });
  const name = el("input", { maxlength: "80", required: "required", placeholder: t("act.placeholder.name") });
  const dkpValue = el("input", { type: "number", min: "0", value: "20" });
  const durationMinutes = el("input", { type: "number", min: "1", max: "1440", value: "30" });
  const startsAt = el("input", { type: "datetime-local", value: localDateTimeValue() });
  const soundState = { soundData: null, fileName: null };
  const soundPreview = el("div", { className: "activity-sound-preview muted", text: t("act.audio.default") });
  const soundFile = el("input", {
    type: "file",
    accept: "audio/*,.mp3,.wav,.ogg,.m4a,.aac",
    onChange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        soundState.soundData = await readAudioAsDataUrl(file);
        soundState.fileName = file.name;
        soundPreview.className = "activity-sound-preview";
        soundPreview.replaceChildren(document.createTextNode(file.name));
        clearSound.hidden = false;
      } catch (err) {
        soundState.soundData = null;
        soundState.fileName = null;
        soundFile.value = "";
        soundPreview.className = "activity-sound-preview muted";
        soundPreview.replaceChildren(document.createTextNode(err.message || t("act.audio.errorRead")));
        clearSound.hidden = true;
      }
    },
  });
  const clearSound = el("button", {
    className: "btn btn-ghost btn-small",
    type: "button",
    hidden: "hidden",
    onClick: () => {
      soundState.soundData = null;
      soundState.fileName = null;
      soundFile.value = "";
      soundPreview.className = "activity-sound-preview muted";
      soundPreview.replaceChildren(document.createTextNode(t("act.audio.default")));
      clearSound.hidden = true;
    },
  });
  clearSound.append(document.createTextNode(t("act.audio.remove")));
  const save = el("button", { className: "btn btn-small", type: "submit" });
  save.append(document.createTextNode(t("act.create.submit")));

  const form = el("form", {}, [
    el("h2", { text: t("act.new") }),
    error,
    field(t("act.field.name"), name),
    field("DKP", dkpValue),
    field(t("act.field.duration"), durationMinutes),
    field(t("act.field.opensAt"), startsAt),
    el("div", { className: "activity-sound-field" }, [
      el("span", { className: "activity-sound-label", text: t("act.audio.label") }),
      soundPreview,
      el("div", { className: "activity-sound-actions" }, [soundFile, clearSound]),
      el("p", {
        className: "muted auction-hint",
        text: t("act.audio.hint"),
      }),
    ]),
    el("p", {
      className: "muted auction-hint",
      text: t("act.hint.opensNow"),
    }),
    el("div", { className: "sheet-actions" }, [
      el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("cancel")]),
      save,
    ]),
  ]);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    error.hidden = true;
    save.disabled = true;
    const start = startsAt.value ? new Date(startsAt.value) : new Date();
    if (Number.isNaN(start.getTime())) {
      error.hidden = false;
      error.textContent = t("act.error.opensAt");
      save.disabled = false;
      return;
    }
    try {
      await api("/api/activities", {
        method: "POST",
        body: JSON.stringify({
          name: name.value,
          dkpValue: Number(dkpValue.value),
          durationMinutes: Number(durationMinutes.value),
          startsAt: start.toISOString(),
          soundData: soundState.soundData || null,
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

export function activitiesView({ api, me, onMemberUpdate }) {
  const root = el("div", { className: "activities-page" });
  let activities = [];
  let filter = memory.filter;
  let search = memory.search;
  let timer = null;
  let booted = false;

  async function refresh() {
    const data = await api("/api/activities");
    activities = data.activities || [];
    watchActivityOpenings(activities);
    if (!booted) {
      booted = true;
      draw();
    } else {
      activityFilters().forEach((item) => {
        const count = activities.filter((activity) => matchesFilter(activity, item.id)).length;
        const chip = [...root.querySelectorAll(".filter-chip")].find((node) => (
          node.dataset.filter === item.id || node.textContent.startsWith(item.label)
        ));
        if (chip) {
          chip.dataset.filter = item.id;
          chip.textContent = `${item.label}${count ? ` (${count})` : ""}`;
        }
      });
      drawResults();
    }
  }

  function visible() {
    return activities
      .filter((activity) => matchesFilter(activity, filter))
      .filter((activity) => matchesSearch(activity, search));
  }

  async function participate(activity, button) {
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = t("act.participating");
    try {
      const data = await api(`/api/activities/${activity.id}/participate`, { method: "POST" });
      await Promise.all([refresh(), onMemberUpdate?.()]);
      if (typeof data.awardedDkp === "number") {
        const extra = typeof data.alsoAwardedDkp === "number"
          ? t("act.awardAlso", { n: number.format(data.alsoAwardedDkp) })
          : "";
        showToast(`${t("act.awardAlert", { n: number.format(data.awardedDkp) })}${extra}`, { tone: "ok" });
      }
    } catch (err) {
      if (err.message?.includes("já participou") || err.data?.error === "already_participated") {
        await refresh();
        return;
      }
      button.disabled = false;
      button.textContent = previous;
      showToast(err.message || t("act.participateFail"), { tone: "error" });
    }
  }

  async function remove(activity, button) {
    if (!confirm(t("act.deleteConfirm", { name: activity.name }))) {
      return;
    }
    button.disabled = true;
    try {
      await api(`/api/activities/${activity.id}`, { method: "DELETE" });
      await refresh();
    } catch (err) {
      button.disabled = false;
      alert(err.message || t("act.deleteFail"));
    }
  }

  async function reopen(activity, button) {
    const raw = prompt(t("act.reopenPrompt", { name: activity.name }), "15");
    if (raw == null) return;
    const extraMinutes = Number(String(raw).trim());
    if (!Number.isInteger(extraMinutes) || extraMinutes < 1 || extraMinutes > 1440) {
      alert(t("act.reopenMinutes"));
      return;
    }
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = t("act.reopening");
    try {
      await api(`/api/activities/${activity.id}/reopen`, {
        method: "POST",
        body: JSON.stringify({ extraMinutes }),
      });
      await refresh();
    } catch (err) {
      button.disabled = false;
      button.textContent = previous;
      alert(err.message || t("act.reopenFail"));
    }
  }

  function draw() {
    memory.filter = filter;
    memory.search = search;
    const officer = me.role === "master" || me.role === "admin";

    const chips = activityFilters().map((item) => {
      const count = activities.filter((activity) => matchesFilter(activity, item.id)).length;
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
          el("h1", { text: t("act.title") }),
          el("p", {
            className: "lede",
            text: me?.piloting?.owner ? t("act.ledePilot") : t("act.lede"),
          }),
        ]),
        officer
          ? el("button", {
            className: "btn btn-small",
            type: "button",
            onClick: () => openCreateActivity(api, refresh),
          }, [t("act.new")])
          : null,
      ]),
      el("div", { className: "panel auction-toolbar" }, [
        searchInput,
        el("div", { className: "filter-chip-row" }, chips),
        soundControls(),
      ]),
      el("div", { className: "activities-results" }),
    );

    drawResults();
  }

  function drawResults(list = visible()) {
    const box = root.querySelector(".activities-results");
    if (!box) return;
    const officer = me.role === "master" || me.role === "admin";
    if (!list.length) {
      box.replaceChildren(el("p", {
        className: "muted",
        text: activities.length ? t("act.noneFilter") : t("act.noneYet"),
      }));
      return;
    }

    const table = el("table", { className: "activity-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: t("act.col.name") }),
          el("th", { text: t("act.col.opened") }),
          el("th", { text: t("act.col.dkp") }),
          el("th", { text: t("act.col.participants") }),
          el("th", { text: t("act.col.available") }),
          el("th", { text: t("act.col.situation") }),
          el("th", { text: t("act.col.status") }),
        ]),
      ]),
      el("tbody", {}, list.map((activity) => {
        const sit = situationLabel(activity);
        const mine = estimatedActivityDkp(activity.dkpValue, me?.power);
        const dkpLabel = mine === activity.dkpValue
          ? number.format(activity.dkpValue)
          : `${number.format(activity.dkpValue)} → ${number.format(mine)}`;
        return el("tr", {}, [
          el("td", { className: "activity-name", text: activity.name }),
          el("td", { text: formatWhen(openedAt(activity)) }),
          el("td", {
            className: "col-dkp num",
            title: t("act.dkpTitle", { base: number.format(activity.dkpValue) }),
            text: dkpLabel,
          }),
          el("td", { className: "col-participantes" }, [
            el("button", {
              type: "button",
              className: "link-btn num",
              title: t("act.viewParticipants"),
              onClick: () => openParticipants(api, activity),
            }, [String(activity.participantsCount || 0)]),
          ]),
          el("td", {}, [availableCell(activity)]),
          el("td", {}, [el("span", { className: sit.className, text: sit.text })]),
          el("td", {}, [
            statusCell(activity, {
              officer,
              onParticipate: participate,
              onReopen: reopen,
              onDelete: remove,
            }),
          ]),
        ]);
      })),
    ]);

    box.replaceChildren(el("div", { className: "panel activity-table-wrap" }, [table]));
  }

  refresh().catch((err) => {
    root.replaceChildren(el("div", { className: "alert", text: err.message }));
  });

  timer = setInterval(() => {
    refresh().catch(() => {});
  }, 10000);

  root.cleanup = () => {
    clearInterval(timer);
  };

  return root;
}
