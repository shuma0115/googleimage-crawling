// ==UserScript==
// @name         Google Images ZIP Downloader (Local)
// @namespace    https://github.com/shuma0115/googleimage-crawling
// @version      0.3.1
// @description  Extract image URLs from Google Images and download as ZIP without a server.
// @match        https://www.google.com/*
// @match        https://www.google.co.kr/*
// @match        https://images.google.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setClipboard
// @connect      *
// @require      https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// @require      https://cdnjs.cloudflare.com/ajax/libs/FileSaver.js/2.0.5/FileSaver.min.js
// ==/UserScript==

(() => {
  "use strict";

  const state = {
    urls: [],
    filtered: [],
    running: false,
  };
  const STORAGE_KEY = "gi-local-settings";

  const sanitizeName = (value) =>
    (value || "images")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-_.]/g, "")
      .toLowerCase() || "images";

  const sanitizeFilename = (value) =>
    (value || "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9\-_.]/g, "");

  const parseQuery = () => {
    const params = new URLSearchParams(window.location.search);
    return params.get("q") || "google-images";
  };

  const parseContentType = (headers) => {
    if (!headers) return "";
    const match = headers.match(/content-type:\s*([^\n;]+)/i);
    return match ? match[1].trim() : "";
  };

  const loadSettings = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    } catch (error) {
      return {};
    }
  };

  const saveSettings = (next) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch (error) {
      // ignore storage failures
    }
  };

  const guessExtension = (url, contentType) => {
    if (contentType) {
      if (contentType.includes("png")) return "png";
      if (contentType.includes("gif")) return "gif";
      if (contentType.includes("webp")) return "webp";
      if (contentType.includes("bmp")) return "bmp";
      if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
    }
    try {
      const path = new URL(url).pathname;
      const last = path.split("/").pop();
      if (last && last.includes(".")) {
        return last.split(".").pop().slice(0, 4);
      }
    } catch (error) {
      return "jpg";
    }
    return "jpg";
  };

  const getUrlExtension = (url) => {
    try {
      const parsed = new URL(url);
      const path = parsed.pathname;
      const last = path.split("/").pop();
      if (last && last.includes(".")) {
        return last.split(".").pop().toLowerCase();
      }
      const queryExt =
        parsed.searchParams.get("fm") ||
        parsed.searchParams.get("fmt") ||
        parsed.searchParams.get("ext");
      if (queryExt) return queryExt.toLowerCase();
    } catch (error) {
      return "";
    }
    return "";
  };

  const applyFilters = (urls, filters) => {
    const { extensions } = filters;
    return urls.filter((url) => {
      if (extensions.length) {
        const ext = getUrlExtension(url);
        if (ext && !extensions.includes(ext)) return false;
      }

      return true;
    });
  };

  const extractUrls = () => {
    const urls = new Set();
    const addUrl = (value) => {
      if (!value || typeof value !== "string") return;
      if (value.startsWith("http")) {
        urls.add(value);
      }
    };

    document.querySelectorAll("div[data-ou]").forEach((el) => {
      addUrl(el.getAttribute("data-ou"));
    });

    document.querySelectorAll("img[data-iurl]").forEach((img) => {
      addUrl(img.getAttribute("data-iurl"));
    });

    document.querySelectorAll('a[href*="imgurl="]').forEach((link) => {
      try {
        const url = new URL(link.href, window.location.href);
        const imgurl = url.searchParams.get("imgurl");
        if (imgurl) {
          addUrl(decodeURIComponent(imgurl));
        }
      } catch (error) {
        // ignore parse failures
      }
    });

    try {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const ouRegex = /"ou":"(https?:[^"]+)"/g;
      let match;
      while ((match = ouRegex.exec(html))) {
        addUrl(match[1].replace(/\\u002f/g, "/").replace(/\\u003d/g, "="));
      }
      const imgurlRegex = /imgurl=([^&"']+)/g;
      while ((match = imgurlRegex.exec(html))) {
        addUrl(decodeURIComponent(match[1]));
      }
    } catch (error) {
      // ignore parse failures
    }

    document.querySelectorAll("img").forEach((img) => {
      const url = img.getAttribute("src") || img.getAttribute("data-src");
      addUrl(url);
    });

    return Array.from(urls);
  };

  const fetchBinary = (url) =>
    new Promise((resolve, reject) => {
      let finished = false;
      const finish = (handler) => {
        if (finished) return;
        finished = true;
        handler();
      };

      const request = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        timeout: 30000,
        onload: (resp) =>
          finish(() => {
            if (resp.status >= 200 && resp.status < 300) {
              resolve({
                buffer: resp.response,
                contentType: parseContentType(resp.responseHeaders),
              });
              return;
            }
            reject(new Error(`HTTP ${resp.status}`));
          }),
        onerror: () => finish(() => reject(new Error("요청 실패"))),
        ontimeout: () => finish(() => reject(new Error("요청 시간 초과"))),
      });

      setTimeout(() => {
        if (finished) return;
        try {
          request.abort();
        } catch (error) {
          // ignore abort failures
        }
        finish(() => reject(new Error("요청 시간 초과")));
      }, 35000);
    });

  const saveBlob = (blob, filename) => {
    if (typeof saveAs === "function") {
      saveAs(blob, filename);
      return;
    }
    if (typeof window.saveAs === "function") {
      window.saveAs(blob, filename);
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const createPanel = () => {
    const panel = document.createElement("div");
    panel.id = "gi-local-panel";
    panel.innerHTML = `
      <div class="gi-title">로컬 이미지 ZIP 도구</div>
      <div class="gi-row">
        <label>폴더명</label>
        <input id="gi-folder" type="text" />
      </div>
      <div class="gi-row">
        <label>최대 개수</label>
        <input id="gi-limit" type="number" min="1" max="200" value="30" />
      </div>
      <div class="gi-row">
        <label>확장자 필터</label>
        <div class="gi-checks">
          <label><input class="gi-ext" type="checkbox" value="jpg" checked /> JPG</label>
          <label><input class="gi-ext" type="checkbox" value="png" checked /> PNG</label>
          <label><input class="gi-ext" type="checkbox" value="gif" checked /> GIF</label>
          <label><input class="gi-ext" type="checkbox" value="webp" checked /> WEBP</label>
        </div>
      </div>
      <div class="gi-actions">
        <button id="gi-collect">URL 수집</button>
        <button id="gi-copy">URL 복사</button>
        <button id="gi-download">ZIP 다운로드</button>
      </div>
      <div class="gi-status" id="gi-status">대기 중</div>
      <div class="gi-count">수집된 URL: <span id="gi-count">0</span>개 · 필터 후 <span id="gi-count-filtered">0</span>개</div>
    `;
    document.body.appendChild(panel);

    const style = document.createElement("style");
    style.textContent = `
      #gi-local-panel {
        position: fixed;
        top: 24px;
        right: 24px;
        z-index: 99999;
        width: 280px;
        padding: 16px;
        border-radius: 14px;
        background: #111827;
        color: #f8fafc;
        font-family: system-ui, sans-serif;
        box-shadow: 0 20px 40px rgba(0,0,0,0.35);
      }
      #gi-local-panel .gi-title {
        font-weight: 700;
        margin-bottom: 12px;
        font-size: 14px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      #gi-local-panel .gi-row {
        display: grid;
        gap: 6px;
        margin-bottom: 10px;
        font-size: 12px;
      }
      #gi-local-panel .gi-inline {
        display: flex;
        align-items: center;
      }
      #gi-local-panel .gi-inline label {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 12px;
      }
      #gi-local-panel .gi-checks {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      #gi-local-panel .gi-checks label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 12px;
      }
      #gi-local-panel input {
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0f172a;
        color: #f8fafc;
        padding: 6px 8px;
      }
      #gi-local-panel input[type="checkbox"] {
        width: 14px;
        height: 14px;
      }
      #gi-local-panel .gi-actions {
        display: grid;
        gap: 6px;
        margin: 10px 0;
      }
      #gi-local-panel button {
        border: none;
        border-radius: 999px;
        padding: 8px 10px;
        cursor: pointer;
        background: #38bdf8;
        color: #0b1020;
        font-weight: 600;
        font-size: 12px;
      }
      #gi-local-panel button:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #gi-local-panel .gi-status,
      #gi-local-panel .gi-count {
        font-size: 12px;
        color: #cbd5f5;
      }
    `;
    document.head.appendChild(style);
  };

  const setupHandlers = () => {
    const folderInput = document.getElementById("gi-folder");
    const limitInput = document.getElementById("gi-limit");
    const extInputs = Array.from(document.querySelectorAll(".gi-ext"));
    const statusEl = document.getElementById("gi-status");
    const countEl = document.getElementById("gi-count");
    const filteredCountEl = document.getElementById("gi-count-filtered");
    const collectBtn = document.getElementById("gi-collect");
    const copyBtn = document.getElementById("gi-copy");
    const downloadBtn = document.getElementById("gi-download");

    const settings = loadSettings();
    folderInput.value = settings.folder || parseQuery();
    limitInput.value = settings.limit || limitInput.value;
    if (Array.isArray(settings.extensions) && settings.extensions.length) {
      extInputs.forEach((input) => {
        input.checked = settings.extensions.includes(input.value);
      });
    }

    const setStatus = (text) => {
      statusEl.textContent = text;
    };

    const setRunning = (running) => {
      state.running = running;
      [collectBtn, copyBtn, downloadBtn].forEach((btn) => {
        btn.disabled = running;
      });
    };

    const getFilters = () => ({
      extensions: extInputs.filter((input) => input.checked).map((input) => input.value),
    });

    const persistSettings = () => {
      const filters = getFilters();
      saveSettings({
        folder: folderInput.value.trim(),
        limit: Number(limitInput.value || 30),
        extensions: filters.extensions,
      });
    };

    const getFilteredTargets = (urls = state.urls) => applyFilters(urls, getFilters());

    const updateCounts = (allCount, filteredCount) => {
      countEl.textContent = String(allCount);
      filteredCountEl.textContent = String(filteredCount);
    };

    const runDownload = async (targets) => {
      if (state.running) return;
      if (!targets.length) {
        setStatus("필터에 맞는 URL이 없습니다.");
        return;
      }

      const limit = Math.min(Number(limitInput.value || 30), 200);
      const folder = sanitizeName(folderInput.value);
      const sliced = targets.slice(0, limit);

      setRunning(true);
      setStatus(`다운로드 시작 (0/${sliced.length})`);

      if (typeof JSZip === "undefined") {
        setStatus("ZIP 라이브러리를 불러오지 못했습니다.");
        setRunning(false);
        return;
      }
      if (JSZip.defaults && "useWebWorkers" in JSZip.defaults) {
        JSZip.defaults.useWebWorkers = false;
      }
      const zip = new JSZip();
      const folderHandle = zip.folder(folder);

      let success = 0;
      const downloaded = [];
      const buildFilename = (url, index, ext) => {
        try {
          const parsed = new URL(url);
          const last = parsed.pathname.split("/").pop() || "";
          if (last) {
            const base = sanitizeFilename(decodeURIComponent(last));
            if (base) {
              if (base.toLowerCase().endsWith(`.${ext}`)) {
                return base;
              }
              return `${base}.${ext}`;
            }
          }
        } catch (error) {
          // ignore parse failures
        }
        return `${String(index).padStart(3, "0")}.${ext}`;
      };

      for (let i = 0; i < sliced.length; i += 1) {
        const url = sliced[i];
        try {
          const { buffer, contentType } = await fetchBinary(url);
          const ext = guessExtension(url, contentType);
          const data = buffer ? new Uint8Array(buffer) : null;
          if (!data || !data.byteLength) {
            setStatus(`빈 파일 건너뜀: ${i + 1}/${sliced.length}`);
            continue;
          }
          const filename = buildFilename(url, i + 1, ext);
          downloaded.push({
            data,
            ext,
            index: i + 1,
            name: filename,
          });
          folderHandle.file(filename, data);
          success += 1;
          setStatus(`다운로드 중 (${success}/${sliced.length})`);
        } catch (error) {
          setStatus(`다운로드 실패: ${i + 1}/${sliced.length}`);
        }
      }

      if (!success) {
        setStatus("다운로드할 이미지가 없습니다.");
        setRunning(false);
        return;
      }

      const generateZipWithTimeout = (options, timeoutMs, label) =>
        new Promise((resolve, reject) => {
          const zipPromise = zip.generateAsync(options, (metadata) => {
            const percent = Math.floor(metadata.percent || 0);
            setStatus(`${label} ${percent}%`);
          });
          const timer = setTimeout(() => reject(new Error("zip-timeout")), timeoutMs);
          zipPromise
            .then((blob) => {
              clearTimeout(timer);
              resolve(blob);
            })
            .catch((error) => {
              clearTimeout(timer);
              reject(error);
            });
        });

      const downloadIndividually = async () => {
        if (!downloaded.length) return;
        setStatus("개별 다운로드 중...");
        for (let i = 0; i < downloaded.length; i += 1) {
          const item = downloaded[i];
          const blob = new Blob([item.data]);
          saveBlob(blob, item.name || `${folder}-${String(item.index).padStart(3, "0")}.${item.ext}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        setStatus(`개별 다운로드 완료: ${downloaded.length}개`);
      };

      try {
        setStatus("ZIP 생성 중...");
        let blob;
        try {
          blob = await generateZipWithTimeout(
            { type: "blob", streamFiles: false, compression: "STORE" },
            120000,
            "ZIP 생성 중..."
          );
        } catch (error) {
          if (error && error.message === "zip-timeout") {
            setStatus("ZIP 대체 생성 중...");
            const data = await generateZipWithTimeout(
              { type: "uint8array", streamFiles: false, compression: "STORE" },
              120000,
              "ZIP 대체 생성 중..."
            );
            blob = new Blob([data], { type: "application/zip" });
          } else {
            throw error;
          }
        }
        saveBlob(blob, `${folder}.zip`);
        setStatus(`완료: ${success}/${sliced.length}개 저장`);
      } catch (error) {
        if (error && error.message === "zip-timeout") {
          setStatus("ZIP 생성 시간이 너무 깁니다. 개수를 줄여주세요.");
        } else {
          setStatus("ZIP 생성 실패");
        }
      } finally {
        setRunning(false);
      }
    };

    const runCollect = async ({ silent = false } = {}) => {
      state.urls = extractUrls();
      state.filtered = getFilteredTargets(state.urls);
      updateCounts(state.urls.length, state.filtered.length);
      if (!silent) {
        setStatus(`URL 수집 완료 (${state.filtered.length}개)`);
      }
    };

    collectBtn.addEventListener("click", () => runCollect());

    copyBtn.addEventListener("click", () => {
      const targets = getFilteredTargets();
      if (!targets.length) {
        setStatus("필터에 맞는 URL이 없습니다.");
        return;
      }
      GM_setClipboard(targets.join("\n"));
      setStatus(`URL ${targets.length}개를 클립보드에 복사했습니다.`);
    });

    downloadBtn.addEventListener("click", async () => {
      await runDownload(getFilteredTargets());
    });

    const refreshFiltered = () => {
      if (!state.urls.length) return;
      state.filtered = getFilteredTargets(state.urls);
      updateCounts(state.urls.length, state.filtered.length);
    };

    extInputs.forEach((input) => {
      input.addEventListener("change", () => {
        refreshFiltered();
        persistSettings();
      });
    });

    [folderInput, limitInput].forEach((input) => {
      input.addEventListener("change", persistSettings);
    });

    runCollect({ silent: true });
    let scrollTimer;
    window.addEventListener("scroll", () => {
      if (state.running) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => runCollect({ silent: true }), 400);
    });
  };

  const init = () => {
    if (document.getElementById("gi-local-panel")) return;
    const params = new URLSearchParams(window.location.search);
    const isImagesHost = window.location.hostname === "images.google.com";
    const isImages = isImagesHost || params.get("tbm") === "isch" || params.get("udm") === "2";
    if (!isImages) return;

    createPanel();
    setupHandlers();
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
