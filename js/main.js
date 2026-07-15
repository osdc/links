/* ============================================================
   OSDC Community Links
   Theme toggle · logo easter egg · copy email · share / QR modal
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

  /* ---------- logo easter egg ---------- */

  var logoBreaker = document.getElementById("logoBreaker");

  if (logoBreaker) {
    var fragmentHost = logoBreaker.querySelector(".logo-breaker__fragments");
    var particleHost = document.createElement("div");
    var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var fragments = [];
    var damage = 0;
    var repairDelay;
    var repairTick;
    var impactTimer;
    var lastPointer = null;
    var revealed = false;
    var BREAK_AT = 10;
    var COLS = 8;
    var ROWS = 4;
    var MAX_PARTICLES = 120;

    particleHost.className = "logo-particles";
    particleHost.setAttribute("aria-hidden", "true");
    document.body.appendChild(particleHost);

    function shuffledIndexes(length) {
      var indexes = [];
      var i;
      for (i = 0; i < length; i += 1) indexes.push(i);
      for (i = length - 1; i > 0; i -= 1) {
        var swap = Math.floor(Math.random() * (i + 1));
        var value = indexes[i];
        indexes[i] = indexes[swap];
        indexes[swap] = value;
      }
      return indexes;
    }

    if (fragmentHost) {
      var totalFragments = COLS * ROWS;
      var damageOrder = shuffledIndexes(totalFragments);

      for (var row = 0; row < ROWS; row += 1) {
        for (var col = 0; col < COLS; col += 1) {
          var fragment = document.createElement("span");
          var index = row * COLS + col;
          var xDirection = col < COLS / 2 ? -1 : 1;
          var xDrift = xDirection * (3 + Math.random() * 6);
          var yDrift = (Math.random() - .5) * 9;
          var rotation = (Math.random() - .5) * 5;

          fragment.className = "logo-fragment";
          fragment.style.clipPath = "inset(" +
            (row * 100 / ROWS) + "% " +
            ((COLS - col - 1) * 100 / COLS) + "% " +
            ((ROWS - row - 1) * 100 / ROWS) + "% " +
            (col * 100 / COLS) + "%)";
          fragment.style.setProperty("--split-x", (xDirection * (42 + Math.random() * 34)) + "px");
          fragment.style.setProperty("--split-y", ((Math.random() - .35) * 28) + "px");
          fragment.style.setProperty("--split-r", (xDirection * (4 + Math.random() * 7)) + "deg");
          fragmentHost.appendChild(fragment);

          fragments.push({
            el: fragment,
            order: damageOrder[index],
            x: xDrift,
            y: yDrift,
            rotation: rotation
          });
        }
      }

      logoBreaker.classList.add("is-ready");
    }

    function renderDamage() {
      var progress = Math.max(0, damage - 2) / (BREAK_AT - 2);
      var affected = Math.ceil(progress * fragments.length);
      var missing = Math.max(0, damage - 4) * 2;

      fragments.forEach(function (fragment) {
        var isDamaged = fragment.order < affected;
        fragment.el.classList.toggle("is-damaged", isDamaged);
        fragment.el.classList.toggle("is-missing", isDamaged && fragment.order < missing);
        fragment.el.style.setProperty("--damage-x", (fragment.x * progress) + "px");
        fragment.el.style.setProperty("--damage-y", (fragment.y * progress) + "px");
        fragment.el.style.setProperty("--damage-r", (fragment.rotation * progress) + "deg");
      });
    }

    function stopRepair() {
      clearTimeout(repairDelay);
      clearInterval(repairTick);
    }

    function scheduleRepair() {
      stopRepair();
      repairDelay = setTimeout(function () {
        repairTick = setInterval(function () {
          damage = Math.max(0, damage - 1);
          renderDamage();
          if (damage === 0) clearInterval(repairTick);
        }, 170);
      }, 700);
    }

    function trimParticles() {
      while (particleHost.childElementCount >= MAX_PARTICLES) {
        particleHost.firstElementChild.remove();
      }
    }

    function burstParticles(point, count, strength) {
      if (reduceMotion.matches || !Element.prototype.animate) return;

      for (var i = 0; i < count; i += 1) {
        trimParticles();
        var particle = document.createElement("i");
        var size = 3 + Math.floor(Math.random() * 5);
        var angle = Math.random() * Math.PI * 2;
        var distance = (24 + Math.random() * 42) * strength;
        var x = Math.cos(angle) * distance;
        var lift = Math.sin(angle) * distance - 18 * strength;
        var fall = lift + 34 + Math.random() * 34;
        var turn = (Math.random() > .5 ? 1 : -1) * (90 + Math.random() * 270);

        particle.className = "logo-particle";
        particle.style.left = point.x + "px";
        particle.style.top = point.y + "px";
        particle.style.width = size + "px";
        particle.style.height = size + "px";
        particleHost.appendChild(particle);

        (function (el) {
          var animation = el.animate([
            { transform: "translate(-50%, -50%) scale(1)", opacity: 1 },
            { transform: "translate(calc(-50% + " + (x * .72) + "px), calc(-50% + " + lift + "px)) rotate(" + (turn * .55) + "deg)", opacity: 1, offset: .62 },
            { transform: "translate(calc(-50% + " + x + "px), calc(-50% + " + fall + "px)) rotate(" + turn + "deg)", opacity: 0 }
          ], {
            duration: 430 + Math.random() * 270,
            easing: "cubic-bezier(.16, .7, .22, 1)",
            fill: "forwards"
          });
          animation.finished.then(function () { el.remove(); }, function () { el.remove(); });
        })(particle);
      }
    }

    function impact() {
      clearTimeout(impactTimer);
      logoBreaker.classList.remove("is-hit");
      void logoBreaker.offsetWidth;
      logoBreaker.classList.add("is-hit");
      impactTimer = setTimeout(function () { logoBreaker.classList.remove("is-hit"); }, 150);
    }

    function vibrate(pattern) {
      if (!navigator.vibrate) return;
      try { navigator.vibrate(pattern); } catch (e) {}
    }

    function logoCenter() {
      var rect = logoBreaker.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }

    function revealPixelLogo(point) {
      revealed = true;
      stopRepair();
      logoBreaker.classList.add("is-revealed");
      logoBreaker.setAttribute("aria-label", "Pixelated OSDC logo, activate for particles");
      document.body.classList.add("logo-shake");
      burstParticles(point, 38, 1.65);
      setTimeout(function () {
        document.body.classList.remove("logo-shake");
        logoBreaker.classList.add("is-settled");
      }, 520);
    }

    logoBreaker.addEventListener("pointerdown", function (event) {
      if (event.isPrimary) lastPointer = { x: event.clientX, y: event.clientY };
    });

    logoBreaker.addEventListener("click", function (event) {
      var point = event.detail === 0 ? logoCenter() : (lastPointer || { x: event.clientX, y: event.clientY });
      lastPointer = null;

      if (revealed) {
        burstParticles(point, 9, .85);
        impact();
        vibrate(12);
        return;
      }

      damage = Math.min(BREAK_AT, damage + 1);
      burstParticles(point, 7 + damage, .8 + damage * .035);
      impact();

      if (damage >= BREAK_AT) {
        vibrate([45, 28, 70, 32, 110]);
        revealPixelLogo(point);
      } else {
        vibrate(6 + damage * 4);
        renderDamage();
        scheduleRepair();
      }
    });
  }

  /* ---------- copy email ---------- */

  var copyMail = document.getElementById("copyMail");
  if (copyMail) {
    copyMail.addEventListener("click", function () {
      copyText(EMAIL).then(
        function () { toast("Email copied: " + EMAIL); },
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
          .share({ title: "OSDC Links", text: "Every OSDC link in one place", url: pageUrl() })
          .catch(function () { openModal(); });
      } else {
        openModal();
      }
    });
  }

  if (modal) {
    // closest(), not target: the close button wraps an <svg>, so a click on the
    // icon reports the <svg> as the target and never the button itself.
    modal.addEventListener("click", function (e) {
      if (e.target.closest("[data-close]")) closeModal();
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
