/* ============================================================
   OSDC — Community Links
   Theme toggle · copy email · share / QR modal
   No dependencies. The QR is a static SVG built by tools/qr.mjs.
   ============================================================ */
(function () {
  "use strict";

  var root = document.documentElement;
  var EMAIL = "contact@osdc.dev";
  var FALLBACK_URL = "https://links.osdc.dev";

  /* ---------- helpers ---------- */

  function pageUrl() {
    return /^https?:/.test(location.protocol) ? location.href : FALLBACK_URL;
  }

  function prettyUrl(u) {
    return u.replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  // Copy text with a graceful fallback for insecure contexts (file://).
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-1000px";
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand("copy");
        document.body.removeChild(ta);
        ok ? resolve() : reject();
      } catch (e) {
        reject(e);
      }
    });
  }

  var toastEl = document.getElementById("toast");
  var toastTimer;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("show");
    }, 2000);
  }

  /* ---------- theme ---------- */

  var themeBtn = document.getElementById("themeBtn");

  function syncThemeBtn() {
    if (themeBtn) {
      themeBtn.setAttribute(
        "aria-pressed",
        root.getAttribute("data-theme") === "dark" ? "true" : "false"
      );
    }
  }
  syncThemeBtn();

  if (themeBtn) {
    themeBtn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("osdc-theme", next); } catch (e) {}
      syncThemeBtn();
    });
  }

  /* ---------- copy email ---------- */

  var copyMail = document.getElementById("copyMail");
  if (copyMail) {
    copyMail.addEventListener("click", function () {
      copyText(EMAIL).then(
        function () { toast("Email copied — " + EMAIL); },
        function () { toast("Couldn't copy. Email: " + EMAIL); }
      );
    });
  }

  /* ---------- share / QR modal ---------- */

  var modal = document.getElementById("shareModal");
  var shareBtn = document.getElementById("shareBtn");
  var shareUrlEl = document.getElementById("shareUrl");
  var copyLink = document.getElementById("copyLink");
  var lastFocus = null;

  var FOCUSABLE = 'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

  function focusables() {
    return Array.prototype.filter.call(
      modal.querySelectorAll(FOCUSABLE),
      function (el) { return el.offsetParent !== null; }
    );
  }

  function openModal() {
    if (!modal) return;
    if (shareUrlEl) shareUrlEl.textContent = prettyUrl(pageUrl());
    lastFocus = document.activeElement;
    modal.hidden = false;
    var closeBtn = modal.querySelector(".modal__close");
    if (closeBtn) closeBtn.focus();
    document.addEventListener("keydown", onKeydown);
  }

  function closeModal() {
    if (!modal || modal.hidden) return;
    modal.hidden = true;
    document.removeEventListener("keydown", onKeydown);
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // Escape closes; Tab is kept inside the dialog.
  function onKeydown(e) {
    if (e.key === "Escape") {
      closeModal();
      return;
    }
    if (e.key !== "Tab") return;

    var items = focusables();
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  if (shareBtn) {
    shareBtn.addEventListener("click", function () {
      // Prefer the native share sheet when available (mobile), else show the QR.
      if (navigator.share) {
        navigator
          .share({ title: "OSDC — Links", text: "Every OSDC link in one place", url: pageUrl() })
          .catch(function () { openModal(); });
      } else {
        openModal();
      }
    });
  }

  if (modal) {
    modal.addEventListener("click", function (e) {
      if (e.target.hasAttribute("data-close")) closeModal();
    });
  }

  if (copyLink) {
    copyLink.addEventListener("click", function () {
      copyText(pageUrl()).then(
        function () { toast("Link copied!"); },
        function () { toast("Couldn't copy the link"); }
      );
    });
  }
})();
