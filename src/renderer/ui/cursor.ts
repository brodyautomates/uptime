// The system pointer is never shown inside the game. Where a pointer is needed (the desk, inspect mode, menus) the game draws its own.
import { ui } from "./store";
export function installCursor(): void {
  const css = document.createElement("style");
  css.textContent = `html, html * { cursor: none !important; }
    #gcursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 2147483647; pointer-events: none; display: none; will-change: transform; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.45)); }`;
  document.head.appendChild(css);
  const el = document.createElement("div"); el.id = "gcursor";
  // the macOS arrow: black with a white outline
  el.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M4 2 L4 18.2 L7.9 14.6 L10.5 20.6 L13.1 19.5 L10.5 13.6 L15.8 13.6 Z" fill="#000" stroke="#fff" stroke-width="1.25" stroke-linejoin="round"/></svg>';
  document.body.appendChild(el);
  let inside = false;
  const wanted = () => { const s = ui.getState() as any; return inside && !document.pointerLockElement && (s.menu != null || s.tablet || (s.mode !== "walk" && s.mode !== "carry")); };
  const refresh = () => { el.style.display = wanted() ? "block" : "none"; };
  window.addEventListener("mousemove", (e) => { inside = true; el.style.transform = `translate(${e.clientX - 4}px, ${e.clientY - 2}px)`; refresh(); }, true);
  document.addEventListener("mouseleave", () => { inside = false; refresh(); });
  document.addEventListener("pointerlockchange", refresh);
  ui.subscribe(refresh);
}
