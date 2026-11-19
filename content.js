// content.js - isolated-world bridge between the extension (bg.js / popup) and main.js,
// the audio engine that runs inside the page's own JS world.
// Injected on demand by bg.js (activeTab). Running it again in the same frame just
// re-activates the existing instance.

(function () {
  "use strict";

  const api = typeof browser !== "undefined" ? browser : chrome;

  if (globalThis.__earsInstance) {
    globalThis.__earsInstance.activate();
    return;
  }

  const TO_MAIN = "ears:to-main";
  const FROM_MAIN = "ears:from-main";

  let active = false;
  let mainSeen = false;
  let warned = {};
  let lastFFT = null;
  let lastFFTTime = 0;

  function toMain(obj) {
    document.dispatchEvent(new CustomEvent(TO_MAIN, { detail: JSON.stringify(obj) }));
  }

  function warnOnce(key, message) {
    if (warned[key]) return;
    warned[key] = true;
    console.log("[Ears]", message);
    api.runtime.sendMessage({ type: "csWarning", message: message }).catch(() => {});
  }

  document.addEventListener(FROM_MAIN, (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (err) { return; }
    if (!m) return;
    switch (m.type) {
      case "hello":
        mainSeen = true;
        break;
      case "fft":
        lastFFT = m.fft;
        lastFFTTime = performance.now();
        break;
      case "warn":
        warnOnce(m.key, m.message);
        break;
      case "status":
        if (active && !m.active) {
          warnOnce(
            "idle",
            m.early
              ? "Ears hasn't found any audio on this page yet. Start playing something (click play) and try again."
              : "Ears started after the page had loaded, so it can't see audio that is already wired up. Open about:addons > Ears > Permissions, allow access to all websites, reload the page and click EQ Current Tab again."
          );
        }
        break;
    }
  });

  async function activate() {
    active = true;
    warned = {};
    console.log("[Ears] active in frame:", location.href);
    let state = null;
    try {
      state = await api.runtime.sendMessage({ type: "csGetState" });
    } catch (e) {
      console.error("Ears: couldn't fetch state", e);
    }
    mainSeen = false;
    toMain({ cmd: "enable", state: state });
    // The reply event is dispatched synchronously, so mainSeen is already up to date here.
    if (!mainSeen) {
      warnOnce("nomain", "Ears' audio engine didn't start on this page. Reload the page and try again.");
    }
  }

  function deactivate() {
    active = false;
    toMain({ cmd: "disable" });
  }

  globalThis.__earsInstance = { activate, deactivate };

  api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.cmd) return;
    switch (msg.cmd) {
      case "ping":
        sendResponse({ ok: true });
        return;
      case "activate":
        activate();
        sendResponse({ ok: true });
        return;
      case "deactivate":
        deactivate();
        sendResponse({ ok: true });
        return;
      case "setFilter":
        toMain({ cmd: "filter", index: msg.index, frequency: msg.frequency, gain: msg.gain, q: msg.q });
        return;
      case "setGain":
        toMain({ cmd: "gain", gain: msg.gain });
        return;
      case "setState":
        toMain({ cmd: "state", state: msg.state });
        return;
      case "getFFT":
        // Only frames whose engine has data answer; the others stay silent.
        if (!active) return;
        toMain({ cmd: "fft" }); // main replies synchronously via an event
        if (lastFFT && performance.now() - lastFFTTime < 250) sendResponse({ fft: lastFFT });
        return;
    }
  });

  activate();
})();
