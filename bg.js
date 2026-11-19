// bg.js (Firefox MV3 event page)
//
// Owns: persisted filter/gain state, presets, bookkeeping of EQ'd tabs.
// Firefox has no tabCapture and no offscreen API, so the Web Audio graph now lives
// in a content script (content.js) injected into the tab on demand. This file
// pushes filter/gain changes to those content scripts and relays FFT data back
// to the popup.
//
// Event pages can be unloaded after ~30s idle, so nothing important lives only
// in module-level variables (everything is re-loadable from storage).

"use strict";

const api = typeof browser !== "undefined" ? browser : chrome;

const FREQ_DEFAULTS = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480];
const Q_DEFAULT = 0.7071;
const NUM_FILTERS = 11;

function filterType(i) {
  if (i === 0) return "lowshelf";
  if (i === NUM_FILTERS - 1) return "highshelf";
  return "peaking";
}

function defaultFilters() {
  const out = [];
  for (let i = 0; i < NUM_FILTERS; i++) {
    out.push({ frequency: FREQ_DEFAULTS[i], gain: 0, q: Q_DEFAULT, type: filterType(i) });
  }
  return out;
}

function clampGainLinear(v) { return Math.min(10, Math.max(0.00316, v)); }
function clampGainDb(v) { return Math.min(30, Math.max(-30, v)); }
function clampFreq(v) { return Math.min(20000, Math.max(5, v)); }
function clampQ(v) { return Math.min(11, Math.max(0.2, v)); }

// ---------- persistence ----------

// EQ state is written on every drag event by the popup, so keep it in memory
// and write to storage debounced.
let stateCache = null;
let saveTimer = null;

async function loadState() {
  if (stateCache) return stateCache;
  const { earsState } = await api.storage.local.get("earsState");
  if (earsState && Array.isArray(earsState.filters) && earsState.filters.length === NUM_FILTERS) {
    stateCache = earsState;
  } else {
    stateCache = { filters: defaultFilters(), gain: 1 };
  }
  return stateCache;
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    api.storage.local.set({ earsState: stateCache }).catch((e) => console.error("Ears: save failed", e));
  }, 300);
}

async function saveStateNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  await api.storage.local.set({ earsState: stateCache });
}

api.runtime.onSuspend.addListener(() => {
  if (saveTimer && stateCache) {
    clearTimeout(saveTimer);
    saveTimer = null;
    api.storage.local.set({ earsState: stateCache });
  }
});

async function loadPresets() {
  const { earsPresets } = await api.storage.sync.get("earsPresets");
  return earsPresets && typeof earsPresets === "object" ? earsPresets : {};
}

async function savePresetsObj(obj) {
  await api.storage.sync.set({ earsPresets: obj });
}

// Which tabs currently have the EQ active. storage.session is wiped on browser
// restart, which is exactly right: content scripts never survive a restart.
let capturedCache = null;

async function loadCapturedTabs() {
  if (capturedCache) return capturedCache;
  const { earsCapturedTabs } = await api.storage.session.get("earsCapturedTabs");
  capturedCache = earsCapturedTabs && typeof earsCapturedTabs === "object" ? earsCapturedTabs : {};
  return capturedCache;
}

async function saveCapturedTabs(obj) {
  capturedCache = obj;
  await api.storage.session.set({ earsCapturedTabs: obj });
}

// ---------- talking to popup / content scripts ----------

function notifyPopup(msg) {
  // Rejects with "Receiving end does not exist" when the popup is closed - ignore.
  api.runtime.sendMessage(msg).catch(() => {});
}

async function sendToTabs(msg) {
  const captured = await loadCapturedTabs();
  await Promise.all(
    Object.keys(captured).map((id) => api.tabs.sendMessage(Number(id), msg).catch(() => undefined))
  );
}

async function pushFullStateToTabs() {
  const state = await loadState();
  await sendToTabs({ cmd: "setState", state });
}

let sampleRateCache = null;
function getSampleRate() {
  if (sampleRateCache) return sampleRateCache;
  try {
    // Event pages have a DOM, so we can just ask the browser for the default output rate.
    const c = new AudioContext();
    sampleRateCache = c.sampleRate;
    c.close();
  } catch (e) {
    sampleRateCache = 48000;
  }
  return sampleRateCache;
}

// Drop entries for tabs whose content script no longer answers (navigated / reloaded / crashed).
async function pruneDeadTabs(captured) {
  let changed = false;
  await Promise.all(
    Object.keys(captured).map(async (id) => {
      try {
        const r = await api.tabs.sendMessage(Number(id), { cmd: "ping" });
        if (!r || !r.ok) throw new Error("no pong");
      } catch (e) {
        delete captured[id];
        changed = true;
      }
    })
  );
  if (changed) await saveCapturedTabs(captured);
}

async function getActiveTab() {
  const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function broadcastFullRefresh() {
  const state = await loadState();
  const captured = await loadCapturedTabs();
  await pruneDeadTabs(captured);

  notifyPopup({
    type: "sendWorkspaceStatus",
    eqFilters: state.filters,
    streams: Object.values(captured),
    gain: state.gain
  });

  const tab = await getActiveTab();
  notifyPopup({ type: "sendCurrentTabStatus", streaming: !!(tab && tab.id in captured) });
  notifyPopup({ type: "sendSampleRate", Fs: getSampleRate() });
  notifyPopup({ type: "sendPresets", presets: await loadPresets() });
}

// ---------- filter / gain mutation ----------

async function modifyFilter(index, frequency, gain, q) {
  if (!(index >= 0 && index < NUM_FILTERS)) return;
  const state = await loadState();
  const f = {
    frequency: clampFreq(frequency),
    gain: clampGainDb(gain),
    q: clampQ(q),
    type: filterType(index)
  };
  state.filters[index] = f;
  scheduleSave();
  await sendToTabs({ cmd: "setFilter", index, frequency: f.frequency, gain: f.gain, q: f.q });
}

async function modifyGain(gain) {
  const state = await loadState();
  state.gain = clampGainLinear(gain);
  scheduleSave();
  await sendToTabs({ cmd: "setGain", gain: state.gain });
}

async function resetFilter(index) {
  if (!(index >= 0 && index < NUM_FILTERS)) return;
  await modifyFilter(index, FREQ_DEFAULTS[index], 0, Q_DEFAULT);
}

async function resetAllFilters() {
  stateCache = { filters: defaultFilters(), gain: 1 };
  await saveStateNow();
  await pushFullStateToTabs();
}

function validPreset(p) {
  return !!p && ["frequencies", "gains", "qs"].every(
    (k) => Array.isArray(p[k]) && p[k].length === NUM_FILTERS && p[k].every((x) => Number.isFinite(x))
  );
}

async function applyPreset(name) {
  let filters;
  if (name === "bassBoost") {
    filters = defaultFilters();
    filters[0] = { frequency: 340, gain: 5, q: Q_DEFAULT, type: "lowshelf" };
  } else {
    const presets = await loadPresets();
    const p = presets[name];
    if (!validPreset(p)) return;
    filters = p.frequencies.map((f, i) => ({
      frequency: clampFreq(f), gain: clampGainDb(p.gains[i]), q: clampQ(p.qs[i]), type: filterType(i)
    }));
  }
  const state = await loadState();
  state.filters = filters;
  await saveStateNow();
  await pushFullStateToTabs();
}

async function savePreset(name) {
  const state = await loadState();
  const presets = await loadPresets();
  presets[name] = {
    frequencies: state.filters.map((f) => f.frequency),
    gains: state.filters.map((f) => f.gain),
    qs: state.filters.map((f) => f.q)
  };
  await savePresetsObj(presets);
}

async function deletePreset(name) {
  const presets = await loadPresets();
  delete presets[name];
  await savePresetsObj(presets);
}

async function importPresets(imported) {
  if (!imported || typeof imported !== "object") return;
  const presets = await loadPresets();
  for (const name of Object.keys(imported)) {
    if (validPreset(imported[name])) presets[name] = imported[name];
  }
  await savePresetsObj(presets);
}

async function exportPresets() {
  const presets = await loadPresets();
  const json = JSON.stringify(presets, null, 2);
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  try {
    await api.downloads.download({ url, filename: "EarsAudioToolkitPresets.json", saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
}

// ---------- per-tab EQ (content-script injection instead of tabCapture) ----------

async function startEqTab() {
  const tab = await getActiveTab();
  if (!tab) return;
  // Popup opened as a full-size tab: its "active tab" is the extension page itself.
  if (tab.url && tab.url.startsWith(api.runtime.getURL(""))) return;

  try {
    // Safe to call repeatedly: content.js is idempotent (re-activates and
    // picks up media in frames that appeared since the last injection).
    // 1) the audio engine, in the page's own JS world (no-op if the manifest's
    //    document_start content script already put it there)
    await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["main.js"],
      world: "MAIN"
    });
    // 2) the bridge between the extension and that engine
    await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ["content.js"]
    });
  } catch (err) {
    console.error("Ears: executeScript failed", err);
    notifyPopup({
      type: "captureError",
      message: "Ears can't run on this page (browser-internal pages, the add-ons site and some PDFs are off-limits to extensions)."
    });
    return;
  }

  const captured = await loadCapturedTabs();
  captured[tab.id] = {
    id: tab.id,
    title: tab.title || "",
    favIconUrl: tab.favIconUrl || "",
    windowId: tab.windowId
  };
  await saveCapturedTabs(captured);
  await broadcastFullRefresh();
}

async function disconnectTab(tabRef) {
  const tabId = tabRef.id;
  await api.tabs.sendMessage(tabId, { cmd: "deactivate" }).catch(() => {});
  const captured = await loadCapturedTabs();
  delete captured[tabId];
  await saveCapturedTabs(captured);
  await broadcastFullRefresh();
}

api.tabs.onRemoved.addListener(async (tabId) => {
  const captured = await loadCapturedTabs();
  if (tabId in captured) {
    delete captured[tabId];
    await saveCapturedTabs(captured);
  }
});

// Navigation / reload destroys the content script (and its AudioContext).
api.tabs.onUpdated.addListener(async (tabId, changeInfo) => {
  if (changeInfo.status !== "loading") return;
  const captured = await loadCapturedTabs();
  if (tabId in captured) {
    delete captured[tabId];
    await saveCapturedTabs(captured);
    await broadcastFullRefresh();
  }
});

// ---------- message handling ----------

api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  handle(msg, sender).then(sendResponse, (err) => {
    console.error("Ears: error handling message", msg, err);
    sendResponse({});
  });
  return true; // async response
});

// ---------- "Lost sound?" switch (DRM handling) ----------
// main.js leaves DRM (EME) media untouched when localStorage.earsBlockDrm === "1"
// for the page's origin. These helpers read / flip that flag and reload the tab,
// because an element that was already routed through Web Audio can't be released.

async function activeNormalTab() {
  const tab = await getActiveTab();
  if (!tab || (tab.url && tab.url.startsWith(api.runtime.getURL("")))) return null;
  return tab;
}

async function getDrmBlocked() {
  const tab = await activeNormalTab();
  if (!tab) return false;
  try {
    const res = await api.scripting.executeScript({
      target: { tabId: tab.id },
      world: "MAIN",
      func: () => {
        try { return localStorage.getItem("earsBlockDrm") === "1"; } catch (e) { return false; }
      }
    });
    return !!(res && res[0] && res[0].result);
  } catch (e) {
    return false;
  }
}

async function setDrmBlocked(block) {
  const tab = await activeNormalTab();
  if (!tab) return;
  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      world: "MAIN",
      func: (b) => {
        try {
          if (b) localStorage.setItem("earsBlockDrm", "1");
          else localStorage.removeItem("earsBlockDrm");
        } catch (e) {}
      },
      args: [block]
    });
  } catch (e) {
    console.error("Ears: couldn't change the DRM switch", e);
  }
  await api.tabs.reload(tab.id);
}

async function handle(msg, sender) {
  switch (msg.type) {
    case "onPopupOpen":
    case "getFullRefresh":
      await broadcastFullRefresh();
      return {};

    case "eqTab":
      if (msg.on) {
        await startEqTab();
      } else {
        const tab = await getActiveTab();
        if (tab) await disconnectTab({ id: tab.id });
      }
      return {};

    case "disconnectTab":
      await disconnectTab(msg.tab);
      return {};

    case "modifyFilter":
      await modifyFilter(msg.index, msg.frequency, msg.gain, msg.q);
      return {};

    case "modifyGain":
      await modifyGain(msg.gain);
      return {};

    case "resetFilter":
      await resetFilter(msg.index);
      return {};

    case "resetFilters":
      await resetAllFilters();
      await broadcastFullRefresh();
      return {};

    case "preset":
      await applyPreset(msg.preset);
      await broadcastFullRefresh();
      return {};

    case "savePreset":
      await savePreset(msg.preset);
      await broadcastFullRefresh();
      return {};

    case "deletePreset":
      await deletePreset(msg.preset);
      await broadcastFullRefresh();
      return {};

    case "importPresets":
      await importPresets(msg.presets);
      await broadcastFullRefresh();
      return {};

    case "exportPresets":
      await exportPresets();
      return {};

    case "drmGetState":
      return { blocked: await getDrmBlocked() };

    case "drmSet":
      await setDrmBlocked(!!msg.block);
      return {};

    case "getFFT": {
      const tab = await getActiveTab();
      const captured = await loadCapturedTabs();
      if (tab && tab.id in captured) {
        try {
          const r = await api.tabs.sendMessage(tab.id, { cmd: "getFFT" });
          if (r && r.fft) return { fft: r.fft };
        } catch (e) { /* tab gone / no media yet */ }
      }
      return { fft: [] };
    }

    // ---- from content.js ----
    case "csGetState":
      return await loadState();

    case "csWarning":
      notifyPopup({ type: "captureError", message: msg.message });
      return {};

    case "gainUpdated":
    case "filterUpdated":
      return {}; // analytics hooks in the original build; no-op.
  }
  return {};
}
