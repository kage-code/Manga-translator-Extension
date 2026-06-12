// background.js — MangaLens v2.1
// OCR:         OCR.space API  — FREE, 25,000 req/month, no billing ever
// Translation: MyMemory API   — FREE, no key needed

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "translateImage") {
    handleTranslateImage(request.imageData, request.apiKey, request.targetLang, request.sourceLang)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function handleTranslateImage(imageData, apiKey, targetLang = "en", sourceLang = "auto") {
  const ocrLangMap = {
    "auto": "auto", "ja": "jpn", "ko": "kor", "zh": "chs",
    "zh-TW": "cht", "en": "eng", "fr": "fre", "de": "ger",
    "es": "spa", "pt": "por", "ar": "ara", "hi": "hin",
    "ru": "rus", "th": "tha", "pt": "por", "id": "ind",
  };
  const ocrLang = ocrLangMap[sourceLang] || "auto";

  // Send as base64 — works for canvas exports and CORS-blocked images
  const formData = new FormData();
  formData.append("base64Image", imageData);
  formData.append("apikey", apiKey);
  formData.append("language", ocrLang);
  formData.append("isOverlayRequired", "true");
  formData.append("detectOrientation", "true");
  formData.append("scale", "true");
  formData.append("OCREngine", "2");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    body: formData
  });

  if (!res.ok) throw new Error(`OCR.space HTTP error: ${res.status}`);

  const data = await res.json();

  if (data.IsErroredOnProcessing) {
    const msg = data.ErrorMessage?.[0] || "OCR failed";
    if (msg.toLowerCase().includes("limit") || msg.toLowerCase().includes("quota")) {
      throw new Error("QUOTA_EXCEEDED");
    }
    throw new Error(msg);
  }

  const parsedResults = data.ParsedResults;
  if (!parsedResults || parsedResults.length === 0) return { blocks: [] };

  const textBlocks = [];
  for (const result of parsedResults) {
    const overlay = result.TextOverlay;
    if (!overlay?.Lines) continue;

    for (const line of overlay.Lines) {
      const lineText = line.Words?.map(w => w.WordText).join(" ").trim();
      if (!lineText || lineText.length < 1) continue;

      const words = line.Words || [];
      if (words.length === 0) continue;

      textBlocks.push({
        original: lineText,
        boundingBox: {
          left:   Math.min(...words.map(w => w.Left)),
          top:    Math.min(...words.map(w => w.Top)),
          right:  Math.max(...words.map(w => w.Left + w.Width)),
          bottom: Math.max(...words.map(w => w.Top + w.Height))
        }
      });
    }
  }

  if (textBlocks.length === 0) return { blocks: [] };

  const translated = await translateAll(textBlocks.map(b => b.original), targetLang);

  return {
    blocks: textBlocks.map((block, i) => ({
      ...block,
      translated: translated[i] || block.original
    }))
  };
}

async function translateAll(texts, targetLang) {
  const results = [];
  const batches = buildBatches(texts, 450);

  for (const batch of batches) {
    const combined = batch.texts.join(" ||| ");
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(combined)}&langpair=auto|${targetLang}`;

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`MyMemory error: ${res.status}`);
      const data = await res.json();

      if (data.responseStatus !== 200) {
        batch.texts.forEach(t => results.push(t));
        continue;
      }

      const translatedText = data.responseData.translatedText;
      if (batch.texts.length === 1) {
        results.push(translatedText);
      } else {
        const parts = translatedText.split(" ||| ");
        batch.texts.forEach((orig, i) => results.push(parts[i] || orig));
      }
    } catch {
      batch.texts.forEach(t => results.push(t));
    }

    if (batches.length > 1) await sleep(150);
  }

  return results;
}

function buildBatches(texts, maxChars) {
  const batches = [];
  let current = { texts: [], charCount: 0 };
  for (const text of texts) {
    if (current.charCount + text.length > maxChars && current.texts.length > 0) {
      batches.push(current);
      current = { texts: [], charCount: 0 };
    }
    current.texts.push(text);
    current.charCount += text.length + 5;
  }
  if (current.texts.length > 0) batches.push(current);
  return batches;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Also handle fetching CORS-blocked images from the background service worker
// (Background scripts aren't bound by CORS, so they can fetch cross-origin images)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "fetchImageAsBase64") {
    fetchImageAsBase64(request.url)
      .then(data => sendResponse({ success: true, data }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

async function fetchImageAsBase64(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch failed: ${resp.status}`);
  const buffer = await resp.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  const base64 = btoa(binary);
  const mimeType = resp.headers.get("content-type") || "image/jpeg";
  return `data:${mimeType};base64,${base64}`;
}
