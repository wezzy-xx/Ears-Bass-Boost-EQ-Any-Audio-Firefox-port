// ff-shim.js - small Firefox-specific UI helpers for the popup.
//
// 1) Firefox closes a browser-action popup as soon as a native file picker opens, so
//    "Import Presets" can't work inside the popup. From the popup the button opens the
//    same page in a full tab (popup.html?full=1&import=1). A browser only allows a file
//    picker after a click on that page, so there the user presses the button again; a
//    banner and a highlight on the button tell them so.
// 2) "Пропал звук?" button: switches DRM handling off/on for the current site
//    (see bg.js, localStorage.earsBlockDrm) and reloads the tab.
(function () {
  var api = typeof browser !== "undefined" ? browser : chrome;
  var isFull = /[?&]full=1/.test(location.search);
  var wantsImport = /[?&]import=1/.test(location.search);

  // ---- 1) Import Presets ----
  if (!isFull) {
    document.addEventListener("click", function (e) {
      var btn = e.target && e.target.closest ? e.target.closest("#importPresetsButton") : null;
      if (!btn) return;
      e.stopPropagation();
      e.preventDefault();
      api.tabs.create({ url: api.runtime.getURL("popup.html?full=1&import=1") });
      window.close();
    }, true);
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (isFull && wantsImport) {
      var importBtn = document.getElementById("importPresetsButton");
      var banner = document.createElement("div");
      banner.textContent =
        "Click \u201CImport Presets\u201D again and choose your file / " +
        "Нажмите «Import Presets» ещё раз и выберите файл";
      banner.style.cssText =
        "position:fixed;top:0;left:0;right:0;z-index:2000;padding:8px;text-align:center;" +
        "background:wheat;color:#2C3E50;font-weight:bold";
      document.body.appendChild(banner);
      if (importBtn) {
        importBtn.style.boxShadow = "0 0 0 3px wheat";
        importBtn.addEventListener("click", function () {
          banner.remove();
          importBtn.style.boxShadow = "";
        });
      }
    }

    // ---- 2) "Lost sound?" button ----
    var drmBtn = document.getElementById("drmFixButton");
    if (!drmBtn) return;
    var blocked = false;

    function render() {
      drmBtn.textContent = blocked ? "Вернуть EQ" : "Пропал звук?";
      drmBtn.title = blocked
        ? "Ears is currently off for protected (DRM) audio on this site. Click to turn it back on (the tab reloads)."
        : "Turns off Ears for protected (DRM) audio on this site and reloads the tab.";
    }

    render();
    api.runtime.sendMessage({ type: "drmGetState" }).then(function (r) {
      blocked = !!(r && r.blocked);
      render();
    }).catch(function () {});

    drmBtn.addEventListener("click", function () {
      api.runtime.sendMessage({ type: "drmSet", block: !blocked }).then(function () {
        blocked = !blocked;
        render();
        if (!isFull) window.close();
      }).catch(function () {});
    });
  });
})();
