/** Registro do service worker (public/sw.js), que mostra os avisos de atividade. */

const UPDATE_EVERY_MS = 60 * 60 * 1000;

let registrationPromise = null;
let lastUpdateCheck = 0;

function swSupported() {
  return typeof navigator !== "undefined" && "serviceWorker" in navigator && window.isSecureContext;
}

export function registerServiceWorker() {
  if (!swSupported()) return Promise.resolve(null);
  if (registrationPromise) return registrationPromise;

  // Clique na notificação com o site já aberto: o service worker pede para ir à página certa.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data || {};
    if (data.type === "gc:open" && typeof data.hash === "string" && /^#\/[a-z-]*$/.test(data.hash)) {
      if (location.hash !== data.hash) location.hash = data.hash;
    }
  });

  registrationPromise = navigator.serviceWorker
    .register("/sw.js", { scope: "/" })
    .then((registration) => {
      // Aba aberta por dias não recarrega a página (as rotas são por #), então
      // confere de vez em quando se saiu versão nova do service worker.
      const check = () => {
        if (Date.now() - lastUpdateCheck < UPDATE_EVERY_MS) return;
        lastUpdateCheck = Date.now();
        registration.update().catch(() => {});
      };
      window.addEventListener("focus", check);
      return registration;
    })
    .catch(() => null);
  return registrationPromise;
}

/** Registro já ativo, ou null se não ficar pronto em alguns segundos. */
export async function activeRegistration(timeoutMs = 3000) {
  if (!swSupported()) return null;
  registerServiceWorker();
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
  } catch {
    return null;
  }
}
