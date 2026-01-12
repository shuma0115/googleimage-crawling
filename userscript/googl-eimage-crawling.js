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

  const sanitizeFilename = (value) =>
    (value || "")
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "");

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
      if (contentType.includes("svg")) return "svg";
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

  const normalizeExtension = (value) => {
    const ext = (value || "").toLowerCase();
    if (!ext) return "";
    if (ext === "jpeg" || ext === "jpe" || ext === "jfif") return "jpg";
    if (ext === "tif") return "tiff";
    if (ext === "svgz") return "svg";
    return ext;
  };

  const getUrlExtension = (url) => {
    try {
      if (url.startsWith("data:")) {
        const match = url.match(/^data:([^;,]+)/i);
        if (match) {
          return normalizeExtension(match[1].split("/").pop());
        }
      }
      const parsed = new URL(url);
      const path = parsed.pathname;
      const last = path.split("/").pop();
      if (last && last.includes(".")) {
        return normalizeExtension(last.split(".").pop());
      }
      const queryExt =
        parsed.searchParams.get("fm") ||
        parsed.searchParams.get("fmt") ||
        parsed.searchParams.get("ext");
      if (queryExt) return normalizeExtension(queryExt);
    } catch (error) {
      return "";
    }
    return "";
  };

  const applyFilters = (urls, filters) => {
    const { extensions } = filters;
    return urls.filter((url) => {
      if (extensions.length) {
        const ext = normalizeExtension(getUrlExtension(url));
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
    if (typeof GM_download === "function") {
      const url = URL.createObjectURL(blob);
      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      };
      const fallbackToSaveAs = () => {
        if (typeof saveAs === "function") {
          saveAs(blob, filename);
          return;
        }
        if (typeof window.saveAs === "function") {
          window.saveAs(blob, filename);
          return;
        }
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        link.remove();
      };
      const fallbackToDataUrl = () => {
        try {
          const reader = new FileReader();
          reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== "string") {
              fallbackToSaveAs();
              return;
            }
            GM_download({
              url: dataUrl,
              name: filename,
              saveAs: false,
              conflictAction: "uniquify",
              onload: () => {
                cleanup();
              },
              onerror: () => {
                cleanup();
                fallbackToSaveAs();
              },
            });
          };
          reader.onerror = () => fallbackToSaveAs();
          reader.readAsDataURL(blob);
        } catch (error) {
          fallbackToSaveAs();
        }
      };
      GM_download({
        url,
        name: filename,
        saveAs: false,
        conflictAction: "uniquify",
        onload: cleanup,
        onerror: () => {
          cleanup();
          fallbackToDataUrl();
        },
      });
      return;
    }
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
      <div class="gi-title">로컬 이미지 저장 도구</div>
      <div class="gi-row">
        <label>저장 폴더</label>
        <input id="gi-path" type="text" placeholder="images" />
      </div>
      <div class="gi-row">
        <label>확장자 필터</label>
        <div class="gi-checks">
          <label><input class="gi-ext" type="checkbox" value="jpg" checked /> JPG</label>
          <label><input class="gi-ext" type="checkbox" value="png" checked /> PNG</label>
          <label><input class="gi-ext" type="checkbox" value="gif" checked /> GIF</label>
          <label><input class="gi-ext" type="checkbox" value="webp" checked /> WEBP</label>
          <label><input class="gi-ext" type="checkbox" value="svg" /> SVG</label>
        </div>
      </div>
      <div class="gi-row gi-inline">
        <label><input id="gi-debug" type="checkbox" /> 실패 URL 로그 출력</label>
      </div>
      <div class="gi-actions">
        <button id="gi-auto-collect">원본 자동 수집</button>
      </div>
      <div class="gi-status" id="gi-status">대기 중</div>
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
      #gi-local-panel .gi-status {
        font-size: 12px;
        color: #cbd5f5;
      }
    `;
    document.head.appendChild(style);
  };

  const setupHandlers = () => {
    const pathInput = document.getElementById("gi-path");
    const extInputs = Array.from(document.querySelectorAll(".gi-ext"));
    const debugInput = document.getElementById("gi-debug");
    const statusEl = document.getElementById("gi-status");
    const autoCollectBtn = document.getElementById("gi-auto-collect");

    const settings = loadSettings();
    pathInput.value = settings.path || "images";
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
      extensions: extInputs
        .filter((input) => input.checked)
        .map((input) => normalizeExtension(input.value)),
    });

    const persistSettings = () => {
      const filters = getFilters();
      const currentPath = pathInput.value.trim() || "images";
      saveSettings({
        path: currentPath,
        extensions: filters.extensions,
        debug: debugInput.checked,
      });
    };

    const getFilteredTargets = (urls = state.urls) => applyFilters(urls, getFilters());

    const downloadedUrls = new Set();
    const normalizeUrl = (value) => {
      try {
        const parsed = new URL(value);
        ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "ved", "sqi"].forEach(
          (key) => parsed.searchParams.delete(key)
        );
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

    const sanitizePath = (value) =>
      (value || "")
        .split("/")
        .map((part) =>
          part
            .trim()
            .replace(/\s+/g, "-")
            .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
        )
        .filter(Boolean)
        .join("/");

    const getDownloadPath = (name) => {
      const raw = pathInput.value.trim();
      const base = sanitizePath(raw) || "images";
      return `${base}/${name}`;
    };

    const resolveOriginalUrl = async (url) => {
      if (!url || typeof url !== "string") return "";
      if (isOriginalCandidate(url)) return url;
      try {
        const response = await fetchBinary(url);
        const contentType = response?.contentType || "";
        if (contentType.includes("html")) {
          const text = new TextDecoder("utf-8").decode(response.buffer);
          const match = text.match(/"ou":"(https?:[^"]+)"/);
          if (match) {
            return match[1].replace(/\\u002f/g, "/").replace(/\\u003d/g, "=");
          }
        }
      } catch (error) {
        // ignore resolve failures
      }
      return url;
    };

    const downloadOriginal = async (url, index) => {
      const normalized = normalizeUrl(url);
      if (downloadedUrls.has(normalized)) return false;
      downloadedUrls.add(normalized);
      const name = buildFilename(url, index);
      const path = getDownloadPath(name);
      if (url.startsWith("data:")) {
        try {
          const commaIndex = url.indexOf(",");
          const meta = url.slice(0, commaIndex);
          const base64 = meta.includes(";base64");
          const data = url.slice(commaIndex + 1);
          const bytes = base64 ? atob(data) : decodeURIComponent(data);
          const buffer = new Uint8Array(bytes.length);
          for (let i = 0; i < bytes.length; i += 1) {
            buffer[i] = bytes.charCodeAt(i);
          }
          saveBlob(new Blob([buffer]), path);
          return true;
        } catch (error) {
          return false;
        }
      }
      if (url.startsWith("blob:")) {
        try {
          const response = await fetch(url);
          const blob = await response.blob();
          saveBlob(blob, path);
          return true;
        } catch (error) {
          return false;
        }
      }
      const primary = await new Promise((resolve) => {
        GM_download({
          url,
          name: path,
          saveAs: false,
          conflictAction: "uniquify",
          onload: () => resolve(true),
          onerror: () => {
            setStatus("원본 다운로드 실패");
            resolve(false);
          },
          ontimeout: () => {
            setStatus("원본 다운로드 시간 초과");
            resolve(false);
          },
        });
      });
      if (primary) return true;
      try {
        const { buffer } = await fetchBinary(url);
        const data = buffer ? new Uint8Array(buffer) : null;
        if (data && data.byteLength) {
          saveBlob(new Blob([data]), path);
          return true;
        }
      } catch (error) {
        // ignore fallback failures
      }
      return false;
    };

    const addUrlToState = (url, { respectFilter = false } = {}) => {
      if (!url) return false;
      const passes = applyFilters([url], getFilters()).length > 0;
      const next = new Set(state.urls);
      const alreadyHad = next.has(url);
      next.add(url);
      state.urls = Array.from(next);
      state.filtered = getFilteredTargets(state.urls);
      if (respectFilter) {
        return !alreadyHad && passes;
      }
      return !alreadyHad;
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

    const waitForViewerUrl = async (timeoutMs = 5000) => {
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
        const added = addUrlToState(url, { respectFilter: true });
        if (added) {
          const resolved = await resolveOriginalUrl(url);
          await downloadOriginal(resolved, autoDownloadIndex);
          autoDownloadIndex += 1;
        }
        return !!added;
      }
      if (fallbackUrl) {
        const added = addUrlToState(fallbackUrl, { respectFilter: true });
        if (added) {
          const resolved = await resolveOriginalUrl(fallbackUrl);
          await downloadOriginal(resolved, autoDownloadIndex);
          autoDownloadIndex += 1;
        }
        return !!added;
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

      const processedThumbs = new Set();
      setStatus(`원본 자동 수집 시작 (0/${thumbs.length})`);
      for (let i = 0; i < thumbs.length; i += 1) {
        if (!state.autoCollecting) break;
        const thumb = thumbs[i];
        const thumbKey =
          thumb.closest("[data-tbnid]")?.getAttribute("data-tbnid") ||
          normalizeUrl(thumb.currentSrc || thumb.src || "");
        if (thumbKey && processedThumbs.has(thumbKey)) {
          continue;
        }
        if (thumbKey) processedThumbs.add(thumbKey);
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

        try {
          const clickTarget =
            thumb.closest("a[href], [role='link'], div[data-tbnid], div[data-iv]") || thumb;
          clickTarget.scrollIntoView({ block: "center", behavior: "instant" });
          const navAnchor = clickTarget.closest("a[href]");
          if (navAnchor) {
            const preventNav = (event) => {
              event.preventDefault();
              event.stopImmediatePropagation();
            };
            navAnchor.addEventListener("click", preventNav, { capture: true, once: true });
          }
          ["mousedown", "mouseup", "click"].forEach((type) => {
            try {
              clickTarget.dispatchEvent(
                new MouseEvent(type, { bubbles: true, cancelable: true })
              );
            } catch (error) {
              if (type === "click" && typeof clickTarget.click === "function") {
                clickTarget.click();
              }
            }
          });
          if (!state.autoCollecting) break;
          await new Promise((resolve) => setTimeout(resolve, 350));
          const collected = await collectFromViewer(fallback);
          if (!collected && debugInput.checked) {
            console.warn("[GI-IMG] No viewer URL found for thumb", thumb);
          }
          setStatus(`원본 자동 수집 중 (${i + 1}/${thumbs.length})`);
        } catch (error) {
          if (debugInput.checked) {
            console.warn("[GI-IMG] Auto collect error", error);
          }
        }

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

      const sliced = targets.slice(0);

      setRunning(true);
      setStatus(`다운로드 시작 (0/${sliced.length})`);

      let success = 0;
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

      try {
        for (let i = 0; i < sliced.length; i += 1) {
          const url = sliced[i];
          try {
            if (url.startsWith("data:")) {
              const commaIndex = url.indexOf(",");
              const meta = url.slice(0, commaIndex);
              const base64 = meta.includes(";base64");
              const data = url.slice(commaIndex + 1);
              const bytes = base64 ? atob(data) : decodeURIComponent(data);
              const buffer = new Uint8Array(bytes.length);
              for (let j = 0; j < bytes.length; j += 1) {
                buffer[j] = bytes.charCodeAt(j);
              }
              const mimeMatch = meta.match(/^data:([^;,]+)/i);
              const ext = guessExtension(url, mimeMatch ? mimeMatch[1] : "");
              const filename = ensureUniqueName(buildFilename(url, i + 1, ext));
              saveBlob(new Blob([buffer]), getDownloadPath(filename));
              success += 1;
              setStatus(`다운로드 중 (${success}/${sliced.length})`);
              continue;
            }
            if (url.startsWith("blob:")) {
              const response = await fetch(url);
              const blob = await response.blob();
              const ext = guessExtension(url, blob.type || "");
              const filename = ensureUniqueName(buildFilename(url, i + 1, ext));
              saveBlob(blob, getDownloadPath(filename));
              success += 1;
              setStatus(`다운로드 중 (${success}/${sliced.length})`);
              continue;
            }
            const { buffer, contentType } = await fetchBinary(url);
            const ext = guessExtension(url, contentType);
            const data = buffer ? new Uint8Array(buffer) : null;
            if (!data || !data.byteLength) {
              setStatus(`빈 파일 건너뜀: ${i + 1}/${sliced.length}`);
              continue;
            }
            const filename = ensureUniqueName(buildFilename(url, i + 1, ext));
            const blob = new Blob([data]);
            saveBlob(blob, getDownloadPath(filename));
            success += 1;
            setStatus(`다운로드 중 (${success}/${sliced.length})`);
          } catch (error) {
            setStatus(`다운로드 실패: ${i + 1}/${sliced.length}`);
          }
        }

        if (!success) {
          setStatus("다운로드할 이미지가 없습니다.");
          return;
        }

        setStatus(`완료: ${success}/${sliced.length}개 저장`);
      } finally {
        setRunning(false);
      }
    };

    const runCollect = async ({ silent = false } = {}) => {
      state.urls = extractUrls();
      state.filtered = getFilteredTargets(state.urls);
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
    };

    extInputs.forEach((input) => {
      input.addEventListener("change", () => {
        refreshFiltered();
        persistSettings();
      });
    });

    [pathInput].forEach((input) => {
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
