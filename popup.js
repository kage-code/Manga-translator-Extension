// popup.js

const toggleSwitch  = document.getElementById("toggleSwitch");
const statusDot     = document.getElementById("statusDot");
const apiKeyInput   = document.getElementById("apiKeyInput");
const toggleVis     = document.getElementById("toggleVis");
const sourceLang    = document.getElementById("sourceLang");
const targetLang    = document.getElementById("targetLang");
const translateBtn  = document.getElementById("translateBtn");
const clearBtn      = document.getElementById("clearBtn");
const statusBar     = document.getElementById("statusBar");
const savedBadge    = document.getElementById("savedBadge");
const statImages    = document.getElementById("statImages");
const statBlocks    = document.getElementById("statBlocks");
const statPages     = document.getElementById("statPages");

let saveTimer = null;
let statsData = { images: 0, blocks: 0, pages: 0 };

// ─── Load saved settings ──────────────────────────────────────────────────────
chrome.storage.sync.get(["enabled", "apiKey", "sourceLang", "targetLang", "stats"], (data) => {
  const key = data.apiKey || "";
  apiKeyInput.value = key;
  toggleSwitch.checked = data.enabled || false;
  sourceLang.value = data.sourceLang || "auto";
  targetLang.value = data.targetLang || "en";
  statsData = data.stats || { images: 0, blocks: 0, pages: 0 };

  updateToggleUI(toggleSwitch.checked);
  updateStats();
  translateBtn.disabled = !key;
  updateStatus(key ? "Ready. Open a manga page and click Translate." : "Enter your OCR.space API key to begin.", "");
});

// ─── Auto-translate toggle ────────────────────────────────────────────────────
toggleSwitch.addEventListener("change", () => {
  const enabled = toggleSwitch.checked;
  const key = apiKeyInput.value.trim();

  if (enabled && !key) {
    toggleSwitch.checked = false;
    updateStatus("Please enter your API key first.", "error");
    return;
  }

  saveSettings();
  updateToggleUI(enabled);
  sendToActiveTab({ action: "toggle", enabled, apiKey: key, sourceLang: sourceLang.value, targetLang: targetLang.value });
  updateStatus(enabled ? "Auto-translate ON — images will translate as they load." : "Auto-translate OFF.", enabled ? "success" : "");
});

// ─── Translate page now ───────────────────────────────────────────────────────
translateBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    updateStatus("Please enter your API key first.", "error");
    return;
  }

  saveSettings();
  updateStatus("🔍 Scanning for manga images...", "loading");
  translateBtn.disabled = true;

  sendToActiveTab(
    { action: "translatePage", apiKey: key, sourceLang: sourceLang.value, targetLang: targetLang.value },
    () => {
      translateBtn.disabled = false;
      statsData.pages = (statsData.pages || 0) + 1;
      chrome.storage.sync.set({ stats: statsData });
      updateStats();
      updateStatus("✓ Translation started! Overlays appearing on images.", "success");
    }
  );
});

// ─── Clear overlays ───────────────────────────────────────────────────────────
clearBtn.addEventListener("click", () => {
  sendToActiveTab({ action: "clearOverlays" });
  updateStatus("Overlays cleared.", "");
});

// ─── Auto-save on input ───────────────────────────────────────────────────────
apiKeyInput.addEventListener("input", () => {
  clearTimeout(saveTimer);
  const key = apiKeyInput.value.trim();
  translateBtn.disabled = !key;
  saveTimer = setTimeout(() => {
    if (key) { saveSettings(); showSavedBadge(); }
  }, 800);
});

sourceLang.addEventListener("change", saveSettings);
targetLang.addEventListener("change", saveSettings);

toggleVis.addEventListener("click", () => {
  const hidden = apiKeyInput.type === "password";
  apiKeyInput.type = hidden ? "text" : "password";
  toggleVis.textContent = hidden ? "🙈" : "👁";
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function updateToggleUI(enabled) {
  statusDot.className = "status-dot" + (enabled ? " on" : "");
}

function saveSettings() {
  chrome.storage.sync.set({
    enabled: toggleSwitch.checked,
    apiKey: apiKeyInput.value.trim(),
    sourceLang: sourceLang.value,
    targetLang: targetLang.value
  });
}

function updateStats() {
  statImages.textContent = statsData.images || 0;
  statBlocks.textContent = statsData.blocks || 0;
  statPages.textContent  = statsData.pages  || 0;
}

function showSavedBadge() {
  savedBadge.classList.add("show");
  setTimeout(() => savedBadge.classList.remove("show"), 2000);
}

function updateStatus(msg, type = "") {
  statusBar.textContent = msg;
  statusBar.className = "status-bar" + (type ? ` ${type}` : "");
}

function sendToActiveTab(message, callback) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, message, callback || (() => {}));
  });
}
