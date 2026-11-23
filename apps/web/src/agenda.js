/** Agenda automática de bosses: os oficiais cadastram uma vez e o site cria as atividades sozinho. */

import { t } from "./i18n.js";

const DAY_KEYS = ["agenda.day.0", "agenda.day.1", "agenda.day.2", "agenda.day.3", "agenda.day.4", "agenda.day.5", "agenda.day.6"];
const TIMEZONES = [
  { id: "America/Sao_Paulo", key: "agenda.tz.brt" },
  { id: "Etc/GMT+5", key: "agenda.tz.server" },
  { id: "America/New_York", key: "agenda.tz.serverDst" },
];
const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];

// Horários de Geena no Rust 1 (servidor da América do Norte, UTC-5), já em Brasília.
// Entram pausados para os oficiais conferirem o DKP antes de ativar.
const GEENA_RUST1 = [
  { name: "Geena: chefes 1 estrela", dkpValue: 10, durationMinutes: 30, weekdays: EVERY_DAY, times: ["15:00", "19:00", "23:00"] },
  { name: "Geena: chefes 2 estrelas", dkpValue: 20, durationMinutes: 30, weekdays: EVERY_DAY, times: ["15:00", "23:00"] },
  { name: "Geena: Enoch e Mashumid (3 estrelas)", dkpValue: 40, durationMinutes: 30, weekdays: [0], times: ["00:00"] },
];

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

function daysLabel(weekdays) {
  if (weekdays.length === 7) return t("agenda.everyDay");
  return weekdays.map((day) => t(DAY_KEYS[day])).join(" ");
}

export function openAgenda(api, onChange) {
  const error = el("div", { className: "alert", hidden: "hidden" });
  const list = el("div", { className: "agenda-list" }, [el("p", { className: "muted", text: t("loading") })]);
  const formSlot = el("div", { className: "agenda-form-slot" });
  let schedules = [];

  function showError(message) {
    error.hidden = !message;
    error.textContent = message || "";
  }

  async function reload() {
    try {
      const data = await api("/api/activity-schedules");
      schedules = data.schedules || [];
      drawList();
    } catch (err) {
      showError(err.message);
    }
  }

  async function changed() {
    await reload();
    await onChange?.();
  }

  function drawList() {
    if (!schedules.length) {
      list.replaceChildren(el("p", { className: "muted agenda-empty", text: t("agenda.empty") }));
      return;
    }
    list.replaceChildren(...schedules.map((item) => el("div", { className: `agenda-row${item.active ? "" : " is-paused"}` }, [
      el("div", { className: "agenda-row-main" }, [
        el("strong", { text: item.name }),
        el("span", { className: "muted", text: `${item.dkpValue} DKP · ${item.durationMinutes} min${item.active ? "" : ` · ${t("agenda.paused")}`}` }),
        el("span", { className: "agenda-when" }, [
          el("span", { className: "agenda-days", text: daysLabel(item.weekdays) }),
          el("span", { className: "agenda-times", text: item.times.join(" · ") }),
          item.timezone && item.timezone !== "America/Sao_Paulo"
            ? el("span", { className: "agenda-days", text: t(TIMEZONES.find((tz) => tz.id === item.timezone)?.key || "agenda.tz.brt") })
            : null,
        ]),
      ]),
      el("div", { className: "agenda-row-actions" }, [
        el("button", {
          type: "button",
          className: "btn btn-ghost btn-small",
          onClick: async (event) => {
            event.currentTarget.disabled = true;
            try {
              await api(`/api/activity-schedules/${item.id}`, { method: "PATCH", body: JSON.stringify({ active: !item.active }) });
              await changed();
            } catch (err) {
              showError(err.message);
            }
          },
        }, [item.active ? t("agenda.pause") : t("agenda.resume")]),
        el("button", { type: "button", className: "btn btn-ghost btn-small", onClick: () => drawForm(item) }, [t("agenda.edit")]),
        el("button", {
          type: "button",
          className: "btn btn-ghost btn-small",
          onClick: async () => {
            if (!confirm(t("agenda.deleteConfirm", { name: item.name }))) return;
            try {
              await api(`/api/activity-schedules/${item.id}`, { method: "DELETE" });
              await changed();
            } catch (err) {
              showError(err.message);
            }
          },
        }, [t("agenda.delete")]),
      ]),
    ])));
  }

  function drawForm(item = null) {
    showError("");
    const name = el("input", { maxlength: "80", required: "required", value: item?.name || "", placeholder: t("agenda.placeholder.name") });
    const dkp = el("input", { type: "number", min: "0", max: "1000000", value: String(item?.dkpValue ?? 20) });
    const duration = el("input", { type: "number", min: "1", max: "1440", value: String(item?.durationMinutes ?? 30) });
    const times = el("input", { value: item?.times?.join(", ") || "", placeholder: "15:00, 19:00, 23:00" });
    const timezone = el("select", { className: "select" }, TIMEZONES.map((tz) => el("option", { value: tz.id, text: t(tz.key) })));
    timezone.value = item?.timezone || "America/Sao_Paulo";
    const selected = new Set(item?.weekdays ?? [0, 1, 2, 3, 4, 5, 6]);
    const days = el("div", { className: "agenda-day-picker", role: "group", "aria-label": t("agenda.field.days") },
      DAY_KEYS.map((key, day) => {
        const button = el("button", {
          type: "button",
          className: `agenda-day${selected.has(day) ? " is-on" : ""}`,
          "aria-pressed": selected.has(day) ? "true" : "false",
          onClick: () => {
            if (selected.has(day)) selected.delete(day);
            else selected.add(day);
            button.classList.toggle("is-on", selected.has(day));
            button.setAttribute("aria-pressed", selected.has(day) ? "true" : "false");
          },
        }, [t(key)]);
        return button;
      }));
    const save = el("button", { className: "btn btn-small", type: "submit" }, [t("agenda.save")]);
    const form = el("form", { className: "agenda-form" }, [
      el("h3", { text: item ? t("agenda.editTitle", { name: item.name }) : t("agenda.add") }),
      el("label", { className: "auction-field" }, [t("agenda.field.name"), name]),
      el("div", { className: "agenda-form-row" }, [
        el("label", { className: "auction-field" }, ["DKP", dkp]),
        el("label", { className: "auction-field" }, [t("act.field.duration"), duration]),
      ]),
      el("div", { className: "auction-field" }, [el("span", { text: t("agenda.field.days") }), days]),
      el("div", { className: "agenda-form-row" }, [
        el("label", { className: "auction-field" }, [t("agenda.field.times"), times]),
        el("label", { className: "auction-field" }, [t("agenda.field.timezone"), timezone]),
      ]),
      el("p", { className: "muted auction-hint", text: t("agenda.timesHint") }),
      el("div", { className: "agenda-form-actions" }, [
        el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => formSlot.replaceChildren(addButton()) }, [t("cancel")]),
        save,
      ]),
    ]);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      showError("");
      save.disabled = true;
      const body = {
        name: name.value,
        dkpValue: Number(dkp.value),
        durationMinutes: Number(duration.value),
        weekdays: [...selected],
        times: times.value,
        timezone: timezone.value,
      };
      try {
        await api(item ? `/api/activity-schedules/${item.id}` : "/api/activity-schedules", {
          method: item ? "PATCH" : "POST",
          body: JSON.stringify(body),
        });
        formSlot.replaceChildren(addButton());
        await changed();
      } catch (err) {
        showError(err.message);
        save.disabled = false;
      }
    });
    formSlot.replaceChildren(form);
    name.focus();
  }

  async function addGeena(button) {
    showError("");
    button.disabled = true;
    try {
      for (const preset of GEENA_RUST1) {
        await api("/api/activity-schedules", {
          method: "POST",
          body: JSON.stringify({ ...preset, timezone: "America/Sao_Paulo", active: false }),
        });
      }
      await changed();
      alert(t("agenda.geenaAdded"));
    } catch (err) {
      showError(err.message);
    } finally {
      button.disabled = false;
    }
  }

  function addButton() {
    return el("div", { className: "agenda-form-actions agenda-add-row" }, [
      el("button", {
        type: "button",
        className: "btn btn-ghost btn-small",
        title: t("agenda.geenaHint"),
        onClick: (event) => addGeena(event.currentTarget),
      }, [t("agenda.geena")]),
      el("button", { type: "button", className: "btn btn-small agenda-add", onClick: () => drawForm() }, [t("agenda.add")]),
    ]);
  }

  const dialog = el("dialog", { className: "sheet agenda-sheet", "aria-label": t("agenda.title") }, [
    el("div", { className: "agenda-body" }, [
      el("div", { className: "sheet-head" }, [
        el("h2", { text: t("agenda.title") }),
        el("button", { className: "btn btn-ghost btn-small", type: "button", onClick: () => dialog.close() }, [t("close")]),
      ]),
      el("p", { className: "muted agenda-lede", text: t("agenda.lede") }),
      error,
      list,
      formSlot,
    ]),
  ]);
  formSlot.append(addButton());
  document.body.append(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.showModal();
  reload();
}
