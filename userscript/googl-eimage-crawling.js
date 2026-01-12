// ==UserScript==
// @name         Google Image Crawling
// @namespace    https://github.com/shuma0115/googleimage-crawling
// @version      0.3.1
// @description  Auto collect original Google Images and download to images/ folder.
// @match        https://www.google.com/*
// @match        https://www.google.co.kr/*
// @match        https://images.google.com/*
// @grant        GM_download
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
    autoCollecting: false,
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
      if (/^https?:\/\/(encrypted-tbn0\.gstatic\.com|tbn0\.gstatic\.com)\//i.test(value)) {
        return;
      }
      if (/^https?:\/\/lh3\.googleusercontent\.com\/ogw\//i.test(value)) {
        return;
      }
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
      <div class="gi-row gi-inline">
        <label><input id="gi-debug" type="checkbox" /> 실패 URL 로그 출력</label>
      </div>
      <div class="gi-actions">
        <button id="gi-auto-collect">원본 자동 수집</button>
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
    const debugInput = document.getElementById("gi-debug");
    const statusEl = document.getElementById("gi-status");
    const countEl = document.getElementById("gi-count");
    const filteredCountEl = document.getElementById("gi-count-filtered");
    const autoCollectBtn = document.getElementById("gi-auto-collect");

    const settings = loadSettings();
    folderInput.value = settings.folder || parseQuery();
    limitInput.value = settings.limit || limitInput.value;
    if (Array.isArray(settings.extensions) && settings.extensions.length) {
      extInputs.forEach((input) => {
        input.checked = settings.extensions.includes(input.value);
      });
    }
    if (typeof settings.debug === "boolean") {
      debugInput.checked = settings.debug;
    }

    const setStatus = (text) => {
      statusEl.textContent = text;
    };

    const setRunning = (running) => {
      state.running = running;
      autoCollectBtn.disabled = running;
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
        debug: debugInput.checked,
      });
    };

    const getFilteredTargets = (urls = state.urls) => applyFilters(urls, getFilters());

    const updateCounts = (allCount, filteredCount) => {
      countEl.textContent = String(allCount);
      filteredCountEl.textContent = String(filteredCount);
    };

    const downloadedUrls = new Set();
    const normalizeUrl = (value) => {
      try {
        const parsed = new URL(value);
        parsed.hash = "";
        return parsed.toString();
      } catch (error) {
        return value;
      }
    };

    const usedNames = new Map();
    const ensureUniqueName = (name) => {
      const key = name.toLowerCase();
      const count = usedNames.get(key) || 0;
      usedNames.set(key, count + 1);
      if (!count) return name;
      const dot = name.lastIndexOf(".");
      const suffix = `_${count + 1}`;
      if (dot > 0) {
        return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
      }
      return `${name}${suffix}`;
    };

    const buildFilename = (url, index) => {
      const ext = getUrlExtension(url) || "jpg";
      try {
        const parsed = new URL(url);
        const last = parsed.pathname.split("/").pop() || "";
        if (last) {
          const base = sanitizeFilename(decodeURIComponent(last));
          if (base) {
            if (base.toLowerCase().endsWith(`.${ext}`)) {
              return ensureUniqueName(base);
            }
            return ensureUniqueName(`${base}.${ext}`);
          }
        }
      } catch (error) {
        // ignore parse failures
      }
      return ensureUniqueName(`${String(index).padStart(3, "0")}.${ext}`);
    };

    const downloadOriginal = (url, index) => {
      const normalized = normalizeUrl(url);
      if (downloadedUrls.has(normalized)) return Promise.resolve(false);
      downloadedUrls.add(normalized);
      const name = buildFilename(url, index);
      const path = `images/${name}`;
      return new Promise((resolve) => {
        GM_download({
          url,
          name: path,
          onload: () => resolve(true),
          onerror: () => {
            setStatus("원본 다운로드 실패");
            resolve(false);
          },
        });
      });
    };

    const addUrlToState = (url, { respectFilter = false } = {}) => {
      if (!url) return;
      if (respectFilter) {
        const passes = applyFilters([url], getFilters()).length > 0;
        if (!passes) return;
      }
      const next = new Set(state.urls);
      next.add(url);
      state.urls = Array.from(next);
      state.filtered = getFilteredTargets(state.urls);
      updateCounts(state.urls.length, state.filtered.length);
    };

    const isOriginalCandidate = (url) => {
      if (!url || typeof url !== "string") return false;
      if (!url.startsWith("http")) return false;
      if (/^https?:\/\/(encrypted-tbn0\.gstatic\.com|tbn0\.gstatic\.com)\//i.test(url)) {
        return false;
      }
      if (/^https?:\/\/lh3\.googleusercontent\.com\/ogw\//i.test(url)) {
        return false;
      }
      return true;
    };

    const findViewerUrl = () => {
      const selectors = [
        "img.n3VNCb",
        "img[jsname='HiaYvf']",
        "img[jsname='kn3ccd']",
        "img.iPVvYb",
      ];
      const nodes = document.querySelectorAll(selectors.join(","));
      const candidates = Array.from(nodes)
        .map((img) => img.currentSrc || img.src)
        .filter((src) => isOriginalCandidate(src));
      return candidates[0] || "";
    };

    const waitForViewerUrl = async (timeoutMs = 3000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        const url = findViewerUrl();
        if (url) return url;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return "";
    };

    let autoDownloadIndex = 1;
    const collectFromViewer = async (fallbackUrl = "") => {
      const url = await waitForViewerUrl();
      if (url) {
        addUrlToState(url, { respectFilter: true });
        await downloadOriginal(url, autoDownloadIndex);
        autoDownloadIndex += 1;
        return true;
      }
      if (fallbackUrl) {
        addUrlToState(fallbackUrl, { respectFilter: true });
        await downloadOriginal(fallbackUrl, autoDownloadIndex);
        autoDownloadIndex += 1;
        return true;
      }
      return false;
    };

    const getThumbnailElements = () => {
      const nodes = Array.from(
        document.querySelectorAll(
          [
            "a[href*='imgurl=']",
            "div[data-tbnid]",
            "div[data-iv]",
            "[role='link'][data-ved]",
            "img.YQ4gaf",
            "img.Q4LuWd",
            "img.rg_i",
            "img[jsname='Q4LuWd']",
            "g-img img",
          ].join(",")
        )
      );
      return nodes
        .map((node) => node.querySelector("img") || (node.tagName === "IMG" ? node : null))
        .filter(Boolean)
        .filter((img) => !img.closest("g-scrolling-carousel"))
        .filter((img) => {
          const link = img.closest("a[href]");
          if (!link) return true;
          const href = link.href || "";
          if (href.includes("imgurl=") || href.includes("/imgres")) return true;
          if (href.includes("tbm=isch") || href.includes("udm=2")) {
            return false;
          }
          if (/[?&]q=/.test(href)) return false;
          return true;
        });
    };

    const startAutoCollect = async () => {
      if (state.autoCollecting) return;
      state.autoCollecting = true;
      autoCollectBtn.textContent = "자동 수집 중지";

      let thumbs = getThumbnailElements();
      if (!thumbs.length) {
        setStatus("썸네일을 찾지 못했습니다. 스크롤 후 다시 시도해주세요.");
        state.autoCollecting = false;
        autoCollectBtn.textContent = "원본 자동 수집";
        return;
      }

      setStatus(`원본 자동 수집 시작 (0/${thumbs.length})`);
      for (let i = 0; i < thumbs.length; i += 1) {
        if (!state.autoCollecting) break;
        const thumb = thumbs[i];
        const anchor = thumb.closest("a[href*='imgurl=']");
        let fallback = "";
        if (anchor) {
          try {
            const url = new URL(anchor.href, window.location.href);
            const imgurl = url.searchParams.get("imgurl");
            if (imgurl) fallback = decodeURIComponent(imgurl);
          } catch (error) {
            // ignore parse failures
          }
        }

        thumb.scrollIntoView({ block: "center", behavior: "instant" });
        const navAnchor = thumb.closest("a[href]");
        if (navAnchor) {
          const preventNav = (event) => {
            event.preventDefault();
            event.stopImmediatePropagation();
          };
          navAnchor.addEventListener("click", preventNav, { capture: true, once: true });
        }
        thumb.dispatchEvent(
          new MouseEvent("click", { bubbles: true, cancelable: true, view: window })
        );
        if (!state.autoCollecting) break;
        await collectFromViewer(fallback);
        setStatus(`원본 자동 수집 중 (${i + 1}/${thumbs.length})`);

        if (i % 15 === 0) {
          window.scrollBy(0, window.innerHeight);
          await new Promise((resolve) => setTimeout(resolve, 400));
          thumbs = getThumbnailElements();
        } else {
          const delay = 900 + Math.floor(Math.random() * 500);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      state.autoCollecting = false;
      autoCollectBtn.textContent = "원본 자동 수집";
    };

    const stopAutoCollect = () => {
      state.autoCollecting = false;
      autoCollectBtn.textContent = "원본 자동 수집";
      setStatus("원본 자동 수집 중지");
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

      let success = 0;
      const downloaded = [];
      const usedNames = new Map();
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

      const ensureUniqueName = (name) => {
        const key = name.toLowerCase();
        const count = usedNames.get(key) || 0;
        usedNames.set(key, count + 1);
        if (!count) return name;
        const dot = name.lastIndexOf(".");
        const suffix = `_${count + 1}`;
        if (dot > 0) {
          return `${name.slice(0, dot)}${suffix}${name.slice(dot)}`;
        }
        return `${name}${suffix}`;
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
          const filename = ensureUniqueName(buildFilename(url, i + 1, ext));
          downloaded.push({
            data,
            ext,
            index: i + 1,
            name: filename,
            size: data.byteLength,
            url,
          });
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

      const generateZipWithTimeout = (zipInstance, options, timeoutMs, label) =>
        new Promise((resolve, reject) => {
          const zipPromise = zipInstance.generateAsync(options, (metadata) => {
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

      const downloadIndividually = async (items = downloaded) => {
        if (!items.length) return;
        setStatus("개별 다운로드 중...");
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i];
          const blob = new Blob([item.data]);
          saveBlob(blob, item.name || `${folder}-${String(item.index).padStart(3, "0")}.${item.ext}`);
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
        setStatus(`개별 다운로드 완료: ${items.length}개`);
      };

      const handleZipFailure = async (items) => {
        setStatus("ZIP 생성이 지연되어 개별 다운로드로 전환합니다.");
        if (debugInput.checked && Array.isArray(items)) {
          console.warn("[GI-ZIP] ZIP failed batch URLs:", items.map((item) => item.url));
        }
        await downloadIndividually(items);
      };

      try {
        const MAX_FILES_PER_ZIP = 50;
        const MAX_ZIP_BYTES = 80 * 1024 * 1024;
        const batches = [];
        let current = [];
        let currentBytes = 0;

        downloaded.forEach((item) => {
          const wouldExceed =
            current.length >= MAX_FILES_PER_ZIP ||
            (current.length && currentBytes + item.size > MAX_ZIP_BYTES);
          if (wouldExceed) {
            batches.push(current);
            current = [];
            currentBytes = 0;
          }
          current.push(item);
          currentBytes += item.size;
        });
        if (current.length) {
          batches.push(current);
        }

        for (let b = 0; b < batches.length; b += 1) {
          const batch = batches[b];
          const zip = new JSZip();
          const folderHandle = zip.folder(folder);
          batch.forEach((item) => {
            folderHandle.file(item.name, item.data);
          });

          const label =
            batches.length > 1 ? `ZIP 생성 중 (${b + 1}/${batches.length})...` : "ZIP 생성 중...";
          let blob;
          try {
            blob = await generateZipWithTimeout(
              zip,
              { type: "blob", streamFiles: true, compression: "STORE" },
              180000,
              label
            );
          } catch (error) {
            if (error && error.message === "zip-timeout") {
              try {
                setStatus("ZIP 대체 생성 중...");
                const data = await generateZipWithTimeout(
                  zip,
                  { type: "uint8array", streamFiles: false, compression: "STORE" },
                  180000,
                  "ZIP 대체 생성 중..."
                );
                blob = new Blob([data], { type: "application/zip" });
              } catch (retryError) {
                if (retryError && retryError.message === "zip-timeout") {
                  await handleZipFailure(batch);
                  continue;
                }
                throw retryError;
              }
            } else {
              throw error;
            }
          }

          const suffix = batches.length > 1 ? `-${b + 1}` : "";
          saveBlob(blob, `${folder}${suffix}.zip`);
        }

        setStatus(`완료: ${success}/${sliced.length}개 저장`);
      } catch (error) {
        if (error && error.message === "zip-timeout") {
          await handleZipFailure(downloaded);
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

    autoCollectBtn.addEventListener("click", () => {
      if (state.autoCollecting) {
        stopAutoCollect();
        return;
      }
      startAutoCollect();
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
    debugInput.addEventListener("change", persistSettings);

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
