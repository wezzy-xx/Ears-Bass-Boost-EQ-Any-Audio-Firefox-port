// main.js - audio engine that runs in the PAGE's JavaScript world (not the extension sandbox).
//
// Injected two ways (the script guards against running twice):
//  1) manifest content_scripts, world MAIN, run_at document_start
//     -> sees every AudioContext the page creates, from the very beginning.
//  2) bg.js executeScript(world MAIN) when the user clicks "EQ Current Tab"
//     -> fallback; works for plain <audio>/<video> but can't see Web Audio graphs
//        that were already wired up before it ran.
//
// What it does when enabled:
//  A) Web Audio pages (e.g. players with their own AudioContext): every node that is
//     connected to context.destination is re-routed through our EQ chain living in the
//     SAME context:  node -> preGain -> 11 biquads -> masterGain -> destination (+analyser)
//  B) Plain media elements (also ones never added to the DOM, like new Audio()):
//     caught at play(), sent through createMediaElementSource() into our own AudioContext.
//
// It talks to content.js (the bridge) through CustomEvents carrying JSON strings.

(function () {
  "use strict";

  if (window.__earsMainLoaded) return;
  try { Object.defineProperty(window, "__earsMainLoaded", { value: true }); } catch (e) { return; }

  const EARLY = document.readyState === "loading";
  const FREQ_DEFAULTS = [20, 40, 80, 160, 320, 640, 1280, 2560, 5120, 10240, 20480];
  const Q_DEFAULT = 0.7071;
  const NUM_FILTERS = 11;
  const TO_MAIN = "ears:to-main";
  const FROM_MAIN = "ears:from-main";

  function clampGainLinear(v) { return Math.min(10, Math.max(0.00316, v)); }
  function clampGainDb(v) { return Math.min(30, Math.max(-30, v)); }
  function clampFreq(v) { return Math.min(20000, Math.max(5, v)); }
  function clampQ(v) { return Math.min(11, Math.max(0.2, v)); }

  const rawConnect = AudioNode.prototype.connect;
  const rawDisconnect = AudioNode.prototype.disconnect;
  const rawPlay = HTMLMediaElement.prototype.play;
  const OfflineCtx = window.OfflineAudioContext || null;

  let enabled = false;
  let rescanTimer = null;
  let mediaCtx = null;

  const params = {
    filters: FREQ_DEFAULTS.map((f) => ({ frequency: f, gain: 0, q: Q_DEFAULT })),
    gain: 1
  };

  const graphs = new WeakMap();   // AudioContext -> graph
  const graphRefs = new Set();    // WeakRef<AudioContext>
  const nodeInfo = new WeakMap(); // AudioNode -> { g, ref }
  const seenMedia = new Set();    // WeakRef<HTMLMediaElement>
  const seenSet = new WeakSet();
  const hooked = new WeakSet();
  const lastNote = new WeakMap();

  function log() {
    const a = Array.prototype.slice.call(arguments);
    a.unshift("[Ears:main]");
    console.log.apply(console, a);
  }

  function emit(obj) {
    try {
      document.dispatchEvent(new CustomEvent(FROM_MAIN, { detail: JSON.stringify(obj) }));
    } catch (e) {}
  }

  function note(el, text) {
    if (lastNote.get(el) === text) return;
    lastNote.set(el, text);
    log(text, el);
  }

  // ---------- per-AudioContext graph registry ----------

  function getGraph(ctx) {
    let g = graphs.get(ctx);
    if (g) return g;
    g = { ctx: ctx, built: false, input: null, filters: [], master: null, analyser: null, feeders: new Set(), pruneAt: 256 };
    graphs.set(ctx, g);
    graphRefs.add(new WeakRef(ctx));
    return g;
  }

  function forEachGraph(fn) {
    for (const r of graphRefs) {
      const ctx = r.deref();
      if (!ctx) { graphRefs.delete(r); continue; }
      const g = graphs.get(ctx);
      if (g) fn(g);
    }
  }

  function forEachFeeder(g, fn) {
    for (const r of g.feeders) {
      const node = r.deref();
      if (!node) { g.feeders.delete(r); continue; }
      fn(node);
    }
  }

  function hasFeeders(g) {
    for (const r of g.feeders) if (r.deref()) return true;
    return false;
  }

  function track(g, node) {
    const info = nodeInfo.get(node);
    if (info && info.g === g) return;
    const ref = new WeakRef(node);
    nodeInfo.set(node, { g: g, ref: ref });
    g.feeders.add(ref);
    if (g.feeders.size > g.pruneAt) {
      for (const r of g.feeders) if (!r.deref()) g.feeders.delete(r);
      g.pruneAt = Math.max(256, g.feeders.size * 2);
    }
  }

  function untrack(node) {
    const info = nodeInfo.get(node);
    if (!info) return;
    info.g.feeders.delete(info.ref);
    nodeInfo.delete(node);
  }

  // ---------- EQ chain ----------

  function setParam(g, param, v, immediate) {
    if (immediate) param.value = v;
    else param.setTargetAtTime(v, g.ctx.currentTime, 0.015); // avoids zipper noise while dragging
  }

  function applyParams(g, immediate) {
    if (!g.built) return;
    try {
      for (let i = 0; i < NUM_FILTERS; i++) {
        const f = g.filters[i];
        const p = params.filters[i];
        if (!f || !p) continue;
        setParam(g, f.frequency, clampFreq(p.frequency), immediate);
        setParam(g, f.gain, clampGainDb(p.gain), immediate);
        setParam(g, f.Q, clampQ(p.q), immediate);
      }
      setParam(g, g.master.gain, clampGainLinear(params.gain), immediate);
    } catch (e) {}
  }

  function buildChain(g) {
    if (g.built) return;
    const ctx = g.ctx;
    const input = ctx.createGain();
    const filters = [];
    for (let i = 0; i < NUM_FILTERS; i++) {
      const f = ctx.createBiquadFilter();
      f.type = i === 0 ? "lowshelf" : i === NUM_FILTERS - 1 ? "highshelf" : "peaking";
      f.frequency.value = FREQ_DEFAULTS[i];
      f.gain.value = 0;
      f.Q.value = Q_DEFAULT;
      filters.push(f);
    }
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 8192;
    analyser.smoothingTimeConstant = 0.5;

    let node = input;
    for (const f of filters) { rawConnect.call(node, f); node = f; }
    rawConnect.call(node, master);
    rawConnect.call(master, ctx.destination);
    rawConnect.call(master, analyser);

    g.input = input; g.filters = filters; g.master = master; g.analyser = analyser;
    g.built = true;
    applyParams(g, true);
  }

  function routeToChain(g) {
    forEachFeeder(g, (node) => {
      try { rawDisconnect.call(node, g.ctx.destination); } catch (e) {}
      try { rawConnect.call(node, g.input); } catch (e) {}
    });
  }

  function routeToDestination(g) {
    forEachFeeder(g, (node) => {
      try { rawDisconnect.call(node, g.input); } catch (e) {}
      try { rawConnect.call(node, g.ctx.destination); } catch (e) {}
    });
  }

  // ---------- Web Audio interception ----------

  function isRealDestination(dest) {
    return dest instanceof AudioDestinationNode && !(OfflineCtx && dest.context instanceof OfflineCtx);
  }

  AudioNode.prototype.connect = function (dest) {
    try {
      if (isRealDestination(dest)) {
        const g = getGraph(dest.context);
        track(g, this);
        if (enabled) {
          buildChain(g);
          const args = Array.prototype.slice.call(arguments);
          args[0] = g.input;
          rawConnect.apply(this, args);
          return dest; // keep the return value the page expects
        }
      }
    } catch (e) {
      // fall through to the untouched native behaviour
    }
    return rawConnect.apply(this, arguments);
  };

  AudioNode.prototype.disconnect = function (dest) {
    try {
      if (arguments.length === 0) {
        untrack(this);
      } else if (isRealDestination(dest)) {
        const g = graphs.get(dest.context);
        if (g) {
          untrack(this);
          if (enabled && g.built) {
            const args = Array.prototype.slice.call(arguments);
            args[0] = g.input;
            return rawDisconnect.apply(this, args);
          }
        }
      }
    } catch (e) {}
    return rawDisconnect.apply(this, arguments);
  };

  // ---------- plain media elements ----------

  // createMediaElementSource() on a cross-origin resource loaded without CORS makes the
  // element output silence, so such elements are never hooked.
  function allowDrm() {
    try { return localStorage.getItem("earsAllowDrm") === "1"; } catch (e) { return false; }
  }

  function blockReason(el) {
    if (el.srcObject) return "srcObject (MediaStream)";
    // Experimental: run  localStorage.earsAllowDrm = "1"  in the page console and reload
    // to try hooking DRM media anyway (it may turn silent; remove the key to undo).
    if (el.mediaKeys && !allowDrm()) return "DRM-protected (EME) media";
    const s = el.currentSrc || el.src;
    if (!s) return "no src yet";
    if (/^(blob|data):/i.test(s)) return null;
    try {
      if (new URL(s, location.href).origin === location.origin) return null;
    } catch (e) {}
    return el.crossOrigin !== null ? null : "cross-origin without CORS: " + s;
  }

  function ensureMediaCtx() {
    if (mediaCtx) return mediaCtx;
    mediaCtx = new AudioContext();
    mediaCtx.addEventListener("statechange", () => {
      if (mediaCtx.state === "running") rescanMedia();
    });
    ["pointerdown", "keydown", "touchend", "click"].forEach((t) =>
      window.addEventListener(t, () => {
        if (enabled && mediaCtx && mediaCtx.state !== "running") mediaCtx.resume().catch(() => {});
      }, true)
    );
    return mediaCtx;
  }

  function tryHook(el) {
    if (!enabled || hooked.has(el)) return;
    const why = blockReason(el);
    if (why) {
      note(el, "not hooked: " + why);
      if (why.indexOf("cross-origin") === 0) {
        emit({ type: "warn", key: "cors", message: "This audio is served from another site without CORS headers, so the browser doesn't allow EQing it." });
      } else if (why.indexOf("DRM") === 0) {
        emit({ type: "warn", key: "drm", message: "This audio is DRM-protected, so the browser doesn't allow EQing it." });
      }
      return;
    }
    let ctx;
    try { ctx = ensureMediaCtx(); } catch (e) { note(el, "can't create AudioContext: " + e); return; }
    if (ctx.state !== "running") {
      note(el, "AudioContext is '" + ctx.state + "' - click anywhere on the page so the browser lets it start");
      emit({ type: "warn", key: "suspended", message: "Ears is waiting for the browser to allow audio processing: click anywhere on the page (e.g. the player), then pause/play the track." });
      ctx.resume().catch(() => {});
      return;
    }
    try {
      const g = getGraph(ctx);
      const src = ctx.createMediaElementSource(el);
      hooked.add(el);
      track(g, src);
      buildChain(g);
      rawConnect.call(src, g.input);
      note(el, "hooked OK");
    } catch (e) {
      // Typically: the page already routes this element through its own AudioContext.
      // That case is handled by the destination interception above.
      note(el, "createMediaElementSource skipped: " + e);
    }
  }

  function watchMedia(el) {
    if (seenSet.has(el)) return;
    seenSet.add(el);
    seenMedia.add(new WeakRef(el));
    ["loadedmetadata", "playing"].forEach((t) => el.addEventListener(t, () => tryHook(el)));
  }

  HTMLMediaElement.prototype.play = function () {
    try {
      watchMedia(this);
      if (enabled) tryHook(this);
    } catch (e) {}
    return rawPlay.apply(this, arguments);
  };

  function rescanMedia() {
    if (!enabled) return;
    try {
      document.querySelectorAll("audio, video").forEach((el) => {
        watchMedia(el);
        if (!el.paused && !el.ended) tryHook(el);
      });
    } catch (e) {}
    for (const r of seenMedia) {
      const el = r.deref();
      if (!el) { seenMedia.delete(r); continue; }
      if (!el.paused && !el.ended) tryHook(el);
    }
  }

  // ---------- enable / disable / state ----------

  function pickGraph() {
    let best = null;
    forEachGraph((g) => {
      if (g.built && g.ctx.state === "running" && hasFeeders(g)) best = g;
    });
    return best;
  }

  function enable() {
    enabled = true;
    forEachGraph((g) => {
      try { buildChain(g); routeToChain(g); } catch (e) { log("chain setup failed", e); }
    });
    rescanMedia();
    if (!rescanTimer) rescanTimer = setInterval(rescanMedia, 3000);
    setTimeout(() => {
      emit({ type: "status", early: EARLY, active: !!pickGraph() });
    }, 2500);
  }

  function disable() {
    enabled = false;
    forEachGraph((g) => { if (g.built) routeToDestination(g); });
    if (rescanTimer) { clearInterval(rescanTimer); rescanTimer = null; }
  }

  function applyState(state) {
    if (!state || !Array.isArray(state.filters)) return;
    for (let i = 0; i < NUM_FILTERS; i++) {
      const f = state.filters[i];
      if (f) params.filters[i] = { frequency: f.frequency, gain: f.gain, q: f.q };
    }
    if (typeof state.gain === "number") params.gain = state.gain;
    forEachGraph((g) => applyParams(g, false));
  }

  function getFFT() {
    const g = pickGraph();
    if (!g) return null;
    const d = new Float32Array(g.analyser.frequencyBinCount);
    g.analyser.getFloatFrequencyData(d);
    const out = new Array(d.length);
    for (let i = 0; i < d.length; i++) {
      const v = d[i];
      out[i] = v > -100 ? Math.round(v * 10) / 10 : -100; // -Infinity / NaN -> floor
    }
    return out;
  }

  // ---------- bridge protocol ----------

  document.addEventListener(TO_MAIN, (e) => {
    let m;
    try { m = JSON.parse(e.detail); } catch (err) { return; }
    if (!m || !m.cmd) return;
    switch (m.cmd) {
      case "enable":
        applyState(m.state);
        enable();
        emit({ type: "hello", early: EARLY });
        break;
      case "disable":
        disable();
        break;
      case "state":
        applyState(m.state);
        break;
      case "filter":
        if (m.index >= 0 && m.index < NUM_FILTERS) {
          params.filters[m.index] = { frequency: m.frequency, gain: m.gain, q: m.q };
          forEachGraph((g) => applyParams(g, false));
        }
        break;
      case "gain":
        params.gain = m.gain;
        forEachGraph((g) => applyParams(g, false));
        break;
      case "fft": {
        const fft = getFFT();
        if (fft) emit({ type: "fft", fft: fft });
        break;
      }
    }
  });
})();
