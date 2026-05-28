/**
 * PoolTerminal — entry.
 *
 * Phase 0: scaffold only.
 *
 * Future phases will:
 *   - boot the data layer (LIVE via Tauri/SSH, or DEMO synthetic)
 *   - bind tickertape values to live data
 *   - wire tab switching to view modules
 *   - register Bloomberg-flash hooks on changing values
 */

const { invoke } = window.__TAURI__.core;

window.addEventListener("DOMContentLoaded", () => {
  console.log("PoolTerminal — scaffold ready (Phase 0)");

  // Minimal tab-switch handler so the chrome feels alive even before Phase 1.
  const tabs = document.querySelectorAll(".pt-tab");
  const canvas = document.getElementById("pt-canvas");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("pt-tab-active"));
      tab.classList.add("pt-tab-active");
      const view = tab.dataset.view;
      canvas.innerHTML = `
        <div class="pt-placeholder">
          <h2>${tab.textContent} view</h2>
          <p>Phase 0 placeholder — this view will be built in a later phase.</p>
        </div>
      `;
    });
  });

  // Minimal mode-toggle so the LIVE / DEMO badge can flip visually.
  const modeBadge = document.getElementById("ttape-mode");
  modeBadge.addEventListener("click", () => {
    const isDemo = modeBadge.classList.toggle("pt-mode-demo");
    modeBadge.textContent = isDemo ? "● DEMO" : "● LIVE";
  });
});
