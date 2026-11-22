import { t } from "./i18n.js";
import { activeRegistration } from "./service-worker.js";

const SOUND_PREF_KEY = "activitySoundEnabled";
const VOLUME_PREF_KEY = "activitySoundVolume";

let apiBase = "";
let currentAudio = null;
let audioUnlocked = false;

export function configureActivityAlert(base) {
  apiBase = String(base || "").replace(/\/$/, "");
}

/** Navegadores bloqueiam autoplay até haver gesto do usuário. */
export async function unlockActivityAudio() {
  if (audioUnlocked) return true;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      if (ctx.state === "suspended") await ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.01);
      await ctx.close();
    }
    const silent = new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=",
    );
    silent.volume = 0.01;
    await silent.play();
    silent.pause();
    audioUnlocked = true;
    return true;
  } catch {
    return false;
  }
}

export function isSoundEnabled() {
  return localStorage.getItem(SOUND_PREF_KEY) !== "0";
}

export function getSoundVolume() {
  const saved = localStorage.getItem(VOLUME_PREF_KEY);
  const value = saved === null ? 100 : Number(saved);
  return Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : 100;
}

export function setSoundVolume(percent) {
  const value = Math.min(100, Math.max(0, Math.round(Number(percent) || 0)));
  localStorage.setItem(VOLUME_PREF_KEY, String(value));
}

export async function ensureNotificationPermission() {
  if (!("Notification" in window)) return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  try {
    const result = await Notification.requestPermission();
    return result === "granted";
  } catch {
    return false;
  }
}

export async function setSoundEnabled(enabled) {
  localStorage.setItem(SOUND_PREF_KEY, enabled ? "1" : "0");
  if (enabled) {
    await unlockActivityAudio();
    await ensureNotificationPermission();
  }
  window.dispatchEvent(new Event("gc:som-atividade"));
}

function pageInBackground() {
  return Boolean(document.hidden) || !document.hasFocus();
}

async function showDesktopNotification(activity) {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  if (!pageInBackground()) return;

  const name = String(activity?.name || "").trim() || t("act.title");
  const title = t("act.notify.title");
  const options = {
    body: t("act.notify.body", { name }),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    tag: `guildnox-activity-${activity?.id || "open"}`,
    renotify: true,
    data: { hash: "#/atividades" },
  };

  // No Android, new Notification() lança erro: lá só o service worker mostra notificação.
  const registration = await activeRegistration();
  if (registration) {
    try {
      await registration.showNotification(title, options);
      return;
    } catch {
      /* tenta o jeito antigo abaixo */
    }
  }

  try {
    const note = new Notification(title, options);
    note.onclick = () => {
      try {
        window.focus();
      } catch {
        /* ignore */
      }
      note.close();
    };
  } catch {
    /* browser bloqueou */
  }
}

let cachedVoices = [];

function refreshVoices() {
  if (!window.speechSynthesis) return;
  cachedVoices = window.speechSynthesis.getVoices();
}

if (typeof window !== "undefined" && window.speechSynthesis) {
  refreshVoices();
  window.speechSynthesis.addEventListener("voiceschanged", refreshVoices);
}

const FEMALE_VOICE_HINTS = ["maria", "luciana", "helena", "fernanda", "camila", "catarina", "joana", "sofia", "beatriz"];

function speak(text) {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "pt-BR";
  utterance.pitch = 1.15;
  utterance.rate = 1;
  utterance.volume = getSoundVolume() / 100;

  const ptVoices = cachedVoices.filter((voice) => voice.lang?.toLowerCase().startsWith("pt"));
  const female = ptVoices.find((voice) => FEMALE_VOICE_HINTS.some((hint) => voice.name.toLowerCase().includes(hint)));
  const chosen = female || ptVoices[0];
  if (chosen) utterance.voice = chosen;

  window.speechSynthesis.resume();
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function stopCurrentAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

async function playActivitySound(activityId) {
  if (!activityId) return false;
  const base = apiBase || "";
  const response = await fetch(`${base}/api/activities/${activityId}/sound`, {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return false;
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  stopCurrentAudio();
  if (window.speechSynthesis) window.speechSynthesis.cancel();
  currentAudio = new Audio(url);
  currentAudio.volume = getSoundVolume() / 100;
  currentAudio.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  await currentAudio.play();
  audioUnlocked = true;
  return true;
}

/** Aviso ao abrir atividade: notificação do sistema (se minimizado) + áudio/voz. */
export async function notifyActivityOpened(activity = null) {
  if (!isSoundEnabled()) return;
  if (activity) showDesktopNotification(activity).catch(() => {});
  if (activity?.hasSound) {
    try {
      if (await playActivitySound(activity.id)) return;
    } catch {
      /* cai na voz padrão */
    }
  }
  stopCurrentAudio();
  speak(t("act.notify.title"));
}

let knownOpenState = null;
let pollTimer = null;

export function watchActivityOpenings(activities = []) {
  const newlyOpened = [];
  if (knownOpenState) {
    for (const activity of activities) {
      const wasOpen = knownOpenState.get(activity.id) ?? false;
      if (activity.isOpen && !wasOpen) newlyOpened.push(activity);
    }
  }
  knownOpenState = new Map(activities.map((activity) => [activity.id, Boolean(activity.isOpen)]));
  for (const activity of newlyOpened) notifyActivityOpened(activity);
  return newlyOpened.length > 0;
}

export function resetActivityOpenWatch() {
  knownOpenState = null;
}

export function startActivityOpenPoll(api, { intervalMs = 5000 } = {}) {
  stopActivityOpenPoll();
  const tick = async () => {
    try {
      const data = await api("/api/activities");
      watchActivityOpenings(data.activities || []);
    } catch {
      /* rede: tenta de novo no próximo ciclo */
    }
  };
  tick();
  pollTimer = setInterval(tick, intervalMs);
}

export function stopActivityOpenPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}
