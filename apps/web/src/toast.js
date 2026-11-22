/** Toast no estilo do site — substitui alert() feio do navegador. */
export function showToast(message, { tone = "ok", duration = 3800 } = {}) {
  let host = document.getElementById("gc-toasts");
  if (!host) {
    host = document.createElement("div");
    host.id = "gc-toasts";
    host.className = "gc-toasts";
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }

  const item = document.createElement("div");
  item.className = `gc-toast gc-toast-${tone}`;
  item.setAttribute("role", "status");

  const lines = String(message || "").split("\n").map((line) => line.trim()).filter(Boolean);
  lines.forEach((line, index) => {
    const p = document.createElement("p");
    p.className = index === 0 ? "gc-toast-title" : "gc-toast-line";
    p.textContent = line;
    item.append(p);
  });

  host.append(item);
  requestAnimationFrame(() => item.classList.add("is-in"));

  const hide = () => {
    item.classList.remove("is-in");
    item.classList.add("is-out");
    window.setTimeout(() => item.remove(), 240);
  };

  const timer = window.setTimeout(hide, duration);
  item.addEventListener("click", () => {
    window.clearTimeout(timer);
    hide();
  });
}
