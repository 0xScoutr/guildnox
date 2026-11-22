/*
 * Service worker do Guildnox.
 *
 * Existe para mostrar os avisos de atividade: no Android o navegador só mostra
 * notificação pelo service worker (new Notification() dá erro lá). Não faz cache
 * de nada, então nunca serve uma versão velha do site.
 */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

function safeHash(hash) {
  return typeof hash === "string" && /^#\/[a-z-]*$/.test(hash) ? hash : "#/atividades";
}

/** Traz o site para a frente (ou abre) já na página certa. */
async function openSite(hash) {
  const target = safeHash(hash);
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const mine = windows.find((client) => new URL(client.url).origin === self.location.origin);
  if (mine) {
    try {
      await mine.focus();
    } catch {
      /* alguns navegadores só deixam focar a partir do clique */
    }
    mine.postMessage({ type: "gc:open", hash: target });
    return;
  }
  await self.clients.openWindow(`/${target}`);
}

self.addEventListener("notificationclick", (event) => {
  const data = event.notification.data || {};
  event.notification.close();
  event.waitUntil(openSite(data.hash));
});
