// content.js — MangaLens v3.0
// Fixed: overlay scroll sync, translation pipeline, lazy-load detection, dynamic image swap

(function () {
  "use strict";

  let apiKey = "";
  let sourceLang = "auto";
  let targetLang = "en";
  let processedImages = new WeakSet();
  let observer = null;
  let isEnabled = false;

  // ─── Load settings ────────────────────────────────────────────────────────
  chrome.storage.sync.get(["enabled", "apiKey", "sourceLang", "targetLang"], (data) => {
    isEnabled = data.enabled || false;
    apiKey = data.apiKey || "";
    sourceLang = data.sourceLang || "auto";
    targetLang = data.targetLang || "en";
    if (isEnabled && apiKey) initAutoTranslate();
  });

  // ─── Message listener from popup ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "toggle") {
      isEnabled = msg.enabled;
      apiKey = msg.apiKey;
      sourceLang = msg.sourceLang || "auto";
      targetLang = msg.targetLang || "en";
      if (isEnabled && apiKey) initAutoTranslate();
      else stopAutoTranslate();
    }
    if (msg.action === "translatePage") {
      apiKey = msg.apiKey;
      sourceLang = msg.sourceLang || "auto";
      targetLang = msg.targetLang || "en";
      showToast("⏳ Scanning page for manga panels...");
      scanAndTranslate();
      setTimeout(() => scanAndTranslate(), 2000);
      setTimeout(() => scanAndTranslate(), 5000);
      setTimeout(() => scanAndTranslate(), 10000);
      sendResponse && sendResponse({ status: "started" });
    }
    if (msg.action === "clearOverlays") {
      clearAllOverlays();
    }
    return true;
  });

  // ─── Auto-translate mode ──────────────────────────────────────────────────
  function initAutoTranslate() {
    setTimeout(() => scanAndTranslate(), 2500);
    observer = new MutationObserver((mutations) => {
      clearTimeout(observer._timer);
      // Also watch for src changes (dynamic image swaps)
      const hasSrcChange = mutations.some(m =>
        m.type === "attributes" && m.attributeName === "src" && m.target.tagName === "IMG"
      );
      const delay = hasSrcChange ? 500 : 1000;
      observer._timer = setTimeout(() => {
        findAllCandidates().forEach(c => {
          if (!processedImages.has(c.element)) processElement(c);
        });
      }, delay);
    });
    observer.observe(document.body, {
      childList: true, subtree: true,
      attributes: true, attributeFilter: ["src", "data-src"]
    });
  }

  function stopAutoTranslate() {
    if (observer) { observer.disconnect(); observer = null; }
    clearAllOverlays();
    processedImages = new WeakSet();
  }

  // ─── Main scan ────────────────────────────────────────────────────────────
  function scanAndTranslate() {
    const candidates = findAllCandidates();
    console.log(`[MangaLens] Found ${candidates.length} candidate(s):`,
      candidates.map(c => `${c.type}:${c.element.tagName} ${(c.element.src || c.bgUrl || "").slice(0, 80)}`));

    if (candidates.length === 0) {
      const allImgs = document.querySelectorAll("img");
      console.log(`[MangaLens] 0 candidates. Total <img>: ${allImgs.length}`);
      allImgs.forEach((img, i) => {
        const rect = img.getBoundingClientRect();
        console.log(`[MangaLens]   [${i}] src=${(img.src || "").slice(0, 100)} n=${img.naturalWidth}x${img.naturalHeight} r=${Math.round(rect.width)}x${Math.round(rect.height)} class="${String(img.className).slice(0, 40)}"`);
      });
      showToast(`No panels found. ${allImgs.length} imgs on page — check F12 console.`);
      return;
    }
    candidates.forEach(c => processElement(c));
  }

  // ─── Find candidates ─────────────────────────────────────────────────────
  function findAllCandidates() {
    const candidates = [];
    const seenKeys = new Set();

    collectFromRoot(document, candidates, seenKeys);

    document.querySelectorAll("iframe").forEach(iframe => {
      try {
        const iDoc = iframe.contentDocument || iframe.contentWindow?.document;
        if (iDoc) collectFromRoot(iDoc, candidates, seenKeys);
      } catch (e) { /* cross-origin */ }
    });

    return candidates;
  }

  function collectFromRoot(root, candidates, seenKeys) {
    // 1. <img> tags
    root.querySelectorAll("img").forEach(el => {
      if (processedImages.has(el)) return;

      // Get src from multiple possible sources
      let src = el.currentSrc || el.src || "";
      // Also check lazy-load attributes
      if (!src || isPlaceholder(src)) {
        src = el.getAttribute("data-src") ||
          el.getAttribute("data-lazy-src") ||
          el.getAttribute("data-original") ||
          el.getAttribute("data-echo") || "";
      }
      if (!src || isPlaceholder(src)) return;
      if (src === window.location.href) return;

      // Size check
      const nw = el.naturalWidth, nh = el.naturalHeight;
      const ow = el.offsetWidth, oh = el.offsetHeight;
      const rect = el.getBoundingClientRect();
      const rw = rect.width, rh = rect.height;

      const bigEnough =
        (nw >= 80 && nh >= 80) ||
        (ow >= 80 && oh >= 80) ||
        (rw >= 80 && rh >= 80);
      const isBlob = src.startsWith("blob:");

      if (!bigEnough && !isBlob) return;

      // Very conservative skip — only skip tiny UI elements
      const combined = (src + (el.alt || "") + String(el.className || "") + (el.id || "")).toLowerCase();
      if (["avatar", "logo", "sprite", "emoji", "1x1", "spacer", "pixel"].some(k => combined.includes(k))) return;

      if (seenKeys.has(src)) return;
      seenKeys.add(src);
      console.log(`[MangaLens] ✅ img candidate: ${src.slice(0, 100)} (${nw}x${nh})`);
      candidates.push({ type: "img", element: el });
    });

    // 2. <canvas>
    root.querySelectorAll("canvas").forEach(el => {
      if (processedImages.has(el)) return;
      const rect = el.getBoundingClientRect();
      if ((el.width < 80 || el.height < 80) && (rect.width < 80 || rect.height < 80)) return;
      const key = `canvas_${el.width}_${el.height}_${Math.round(rect.left)}_${Math.round(rect.top)}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      candidates.push({ type: "canvas", element: el });
    });

    // 3. CSS background-image
    root.querySelectorAll("div,section,figure,picture,span,li,article,a,p,td").forEach(el => {
      if (processedImages.has(el)) return;
      let bg;
      try { bg = window.getComputedStyle(el).backgroundImage; } catch { return; }
      if (!bg || bg === "none" || !bg.startsWith("url")) return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 80) return;
      const urlMatch = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!urlMatch) return;
      const bgUrl = urlMatch[1];
      if (isPlaceholder(bgUrl)) return;
      if (seenKeys.has(bgUrl)) return;
      seenKeys.add(bgUrl);
      candidates.push({ type: "bg", element: el, bgUrl });
    });

    // 4. Shadow DOM
    root.querySelectorAll("*").forEach(el => {
      if (el.shadowRoot) collectFromRoot(el.shadowRoot, candidates, seenKeys);
    });
  }

  /** Check if a URL is a loading placeholder/tiny gif */
  function isPlaceholder(src) {
    if (!src) return true;
    const s = src.toLowerCase();
    return s.endsWith("#") ||
      s.includes("loading") ||
      s.includes("placeholder") ||
      s.includes("blank.gif") ||
      s.includes("spacer") ||
      s.includes("1x1") ||
      s === "about:blank" ||
      (s.startsWith("data:") && s.length < 200); // tiny data URIs are placeholders
  }

  // ─── Process one candidate ────────────────────────────────────────────────
  async function processElement(candidate) {
    const el = candidate.element;
    if (!apiKey || processedImages.has(el)) return;
    processedImages.add(el);

    const indicator = createIndicator(el);

    try {
      const base64DataUrl = await toBase64(candidate);
      if (!base64DataUrl) {
        console.warn("[MangaLens] toBase64 returned null for", (el.src || "").slice(0, 60));
        indicator.remove();
        return;
      }

      console.log("[MangaLens] Sending to OCR...", (el.src || "").slice(0, 60));

      const result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { action: "translateImage", imageData: base64DataUrl, apiKey, sourceLang, targetLang },
          (response) => {
            if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
            if (!response) return reject(new Error("No response from background"));
            if (!response.success) return reject(new Error(response.error));
            resolve(response.data);
          }
        );
      });

      indicator.remove();
      console.log("[MangaLens] OCR result:", result.blocks?.length, "blocks");
      if (result.blocks && result.blocks.length > 0) {
        result.blocks.forEach((b, i) => {
          console.log(`[MangaLens]   block[${i}] orig="${b.original?.slice(0, 40)}" translated="${b.translated?.slice(0, 40)}"`);
        });
        overlayTranslations(el, result.blocks);
      }
    } catch (err) {
      indicator.remove();
      console.warn("[MangaLens] Error:", err.message);
      if (err.message === "QUOTA_EXCEEDED") {
        showToast("⏳ Daily OCR limit reached. Resets tomorrow!");
      }
    }
  }

  // ─── Image → base64 ───────────────────────────────────────────────────────
  async function toBase64(candidate) {
    try {
      if (candidate.type === "canvas") {
        const dataUrl = candidate.element.toDataURL("image/png");
        if (!dataUrl || dataUrl === "data:,") return null;
        return dataUrl;
      }
      const el = candidate.element;
      const url = candidate.type === "bg"
        ? candidate.bgUrl
        : (el.currentSrc || el.src || el.getAttribute("data-src") || "");
      if (!url) return null;
      if (url.startsWith("data:") && url.length > 200) return url;

      // blob: URL — fetch directly
      if (url.startsWith("blob:")) {
        try { return await blobUrlToBase64(url); }
        catch (e) { console.warn("[MangaLens] blob fail:", e.message); }
      }

      // Already-loaded img — draw directly to canvas
      if (candidate.type === "img" && el.complete && el.naturalWidth > 0) {
        try { return await drawLoadedImgToCanvas(el); }
        catch (e) { console.log("[MangaLens] direct draw fail:", e.message); }
      }

      // Re-fetch with crossOrigin
      try { return await drawToCanvas(url); }
      catch { /* fall through */ }

      // Last resort: fetch via background (no CORS restriction)
      return await fetchViaBackground(url);
    } catch (e) {
      console.warn("[MangaLens] toBase64 failed:", e.message);
      return null;
    }
  }

  async function blobUrlToBase64(blobUrl) {
    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error(`blob fetch: ${response.status}`);
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("FileReader error"));
      reader.readAsDataURL(blob);
    });
  }

  function drawLoadedImgToCanvas(imgEl) {
    return new Promise((resolve, reject) => {
      try {
        const c = document.createElement("canvas");
        c.width = imgEl.naturalWidth;
        c.height = imgEl.naturalHeight;
        if (!c.width || !c.height) return reject(new Error("zero size"));
        c.getContext("2d").drawImage(imgEl, 0, 0);
        resolve(c.toDataURL("image/png"));
      } catch (e) { reject(new Error("tainted: " + e.message)); }
    });
  }

  function drawToCanvas(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth || img.width;
          c.height = img.naturalHeight || img.height;
          if (!c.width || !c.height) return reject(new Error("zero size"));
          c.getContext("2d").drawImage(img, 0, 0);
          resolve(c.toDataURL("image/png"));
        } catch { reject(new Error("tainted")); }
      };
      img.onerror = () => reject(new Error("load failed"));
      img.src = url;
    });
  }

  function fetchViaBackground(url) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: "fetchImageAsBase64", url }, (r) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!r || !r.success) return reject(new Error(r?.error || "no response"));
        resolve(r.data);
      });
    });
  }

  // ─── Overlay boxes (FIXED: scroll-synced positioning) ─────────────────────
  function overlayTranslations(el, blocks) {
    const rect = el.getBoundingClientRect();
    const naturalW = el.naturalWidth || el.width || rect.width;
    const naturalH = el.naturalHeight || el.height || rect.height;
    const scaleX = rect.width / naturalW;
    const scaleY = rect.height / naturalH;

    // Clean up old wrapper if it exists
    if (el._mangaWrapper) {
      el._mangaWrapper.remove();
      el._mangaWrapper = null;
    }

    // Strategy: wrap the image in a relative container so overlays scroll with it
    const wrapper = document.createElement("div");
    wrapper.className = "manglens-wrapper";

    // Check if the image's parent can serve as positioning context
    const parent = el.parentElement;
    const parentStyle = parent ? window.getComputedStyle(parent) : null;
    const parentIsPositioned = parentStyle &&
      (parentStyle.position === "relative" || parentStyle.position === "absolute" || parentStyle.position === "fixed");

    if (parentIsPositioned) {
      // Parent is already positioned — append wrapper as sibling overlay
      wrapper.style.cssText = `
        position:absolute;
        left:${el.offsetLeft}px;
        top:${el.offsetTop}px;
        width:${el.offsetWidth || rect.width}px;
        height:${el.offsetHeight || rect.height}px;
        pointer-events:none; z-index:9999;
      `;
      parent.appendChild(wrapper);
    } else if (parent) {
      // Make the parent a positioning context
      parent.style.position = "relative";
      wrapper.style.cssText = `
        position:absolute;
        left:${el.offsetLeft}px;
        top:${el.offsetTop}px;
        width:${el.offsetWidth || rect.width}px;
        height:${el.offsetHeight || rect.height}px;
        pointer-events:none; z-index:9999;
      `;
      parent.appendChild(wrapper);
    } else {
      // Fallback: absolute position on body (old behavior)
      wrapper.style.cssText = `
        position:absolute;
        left:${rect.left + window.scrollX}px;
        top:${rect.top + window.scrollY}px;
        width:${rect.width}px; height:${rect.height}px;
        pointer-events:none; z-index:9999;
      `;
      document.body.appendChild(wrapper);
    }

    el._mangaWrapper = wrapper;

    for (const { boundingBox: bb, translated, original } of blocks) {
      if (!translated) continue;
      const left = bb.left * scaleX;
      const top = bb.top * scaleY;
      const width = (bb.right - bb.left) * scaleX;
      const height = (bb.bottom - bb.top) * scaleY;
      const fontSize = Math.max(9, Math.min(14, height * 0.35));

      const box = document.createElement("div");
      box.className = "manglens-overlay";
      box.textContent = translated;
      box.title = `Original: ${original}`;
      box.style.cssText = `
        position:absolute; left:${left}px; top:${top}px;
        width:${width}px; min-height:${height}px;
        font-size:${fontSize}px; pointer-events:auto;
      `;
      wrapper.appendChild(box);
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function createIndicator(el) {
    const rect = el.getBoundingClientRect();
    const div = document.createElement("div");
    div.className = "manglens-processing";
    div.textContent = "🔍 Translating...";
    div.style.cssText = `
      position:fixed; top:${Math.max(8, rect.top + 8)}px; left:${Math.max(8, rect.left + 8)}px;
      background:#1a1a2e; color:#fff; padding:4px 10px; border-radius:6px;
      font:bold 12px Arial; z-index:99999; pointer-events:none;
    `;
    document.body.appendChild(div);
    return div;
  }

  function showToast(msg) {
    document.querySelectorAll(".manglens-toast").forEach(e => e.remove());
    const el = document.createElement("div");
    el.className = "manglens-toast";
    el.textContent = `📖 MangaLens: ${msg}`;
    el.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:#1a1a2e; color:#fff; font-family:Arial,sans-serif;
      font-size:14px; padding:12px 22px; border-radius:8px;
      box-shadow:0 4px 16px rgba(0,0,0,.4); z-index:99999;
      max-width:480px; text-align:center; pointer-events:none;
    `;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 7000);
  }

  function clearAllOverlays() {
    document.querySelectorAll(".manglens-overlay,.manglens-processing,.manglens-toast,.manglens-wrapper").forEach(e => e.remove());
    document.querySelectorAll("img,canvas,div,section,figure,td").forEach(e => { delete e._mangaWrapper; });
    processedImages = new WeakSet();
  }
})();
