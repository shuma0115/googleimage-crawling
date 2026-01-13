// ==UserScript==
// @name         Google Image Crawling
// @namespace    https://github.com/shuma0115/googleimage-crawling
// @version      0.5.3
// @description  Auto collect original Google Images and download to images/ folder.
// @match        https://www.google.com/*
// @match        https://www.google.co.kr/*
// @match        https://images.google.com/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

// [MAINTENANCE WARNING]
// This script is highly dependent on Google's specific DOM structure and class names.
// Google frequently updates its website, which can break the selectors used in this script.
// When the script fails, the most likely cause is a change in Google's HTML,
// and the query selectors (especially in `getThumbnailElements`) will need to be updated.
//
// [유지보수 경고]
// 이 스크립트는 구글의 특정 DOM 구조와 클래스 이름에 크게 의존합니다.
// 구글은 웹사이트를 자주 업데이트하며, 이로 인해 스크립트에서 사용하는 선택자가 깨질 수 있습니다.
// 스크립트가 오작동하는 경우, 가장 가능성이 높은 원인은 구글의 HTML 변경이므로
// `getThumbnailElements` 함수의 쿼리 선택자를 업데이트해야 합니다.

(() => {
  "use strict";

  const state = {
    autoCollecting: false,
    stoppedByUser: false,
  };
  let logDebug = () => {};
  let panelElement = null;
  let buildFilename = (url, index, extHint = "") => {
    const ext = normalizeExtension(extHint) || getUrlExtension(url) || "jpg";
    return `${String(index).padStart(3, "0")}.${ext}`;
  };
  let getDownloadPath = (name) => name;
  const STORAGE_KEY = "gi-local-settings";
  const SESSION_KEY = "gi-local-session";
  const AUTO_START_KEY = "gi-auto-start-pending";

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

  const decodeEscapedUrl = (value) =>
    (value || "")
      .replace(/\\u002f/g, "/")
      .replace(/\\u003d/g, "=")
      .replace(/\\u0026/g, "&");

  const extractOriginalFromHtml = (html) => {
    if (!html) return "";
    const match = html.match(/"ou":"(https?:[^"]+)"/);
    return match ? decodeEscapedUrl(match[1]) : "";
  };

  const extractImageFromHtml = (html, baseUrl) => {
    if (!html) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const selectors = [
        "meta[property='og:image']",
        "meta[property='og:image:secure_url']",
        "meta[name='twitter:image']",
        "meta[name='twitter:image:src']",
        "link[rel='image_src']",
      ];
      for (const selector of selectors) {
        const node = doc.querySelector(selector);
        if (!node) continue;
        const value = node.getAttribute("content") || node.getAttribute("href");
        if (!value) continue;
        try {
          return new URL(value, baseUrl).toString();
        } catch (error) {
          return value;
        }
      }
    } catch (error) {
      // ignore parse failures
    }
    return "";
  };

  const extractUrlFromDataIv = (value) => {
    if (!value) return "";
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed.ou || parsed.iurl || parsed.ru || "";
      }
    } catch (error) {
      // ignore parse failures
    }
    return "";
  };

  const getRandom = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

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

  const loadSessionState = () => {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY) || "{}");
    } catch (error) {
      return {};
    }
  };

  const saveSessionState = (next) => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
    } catch (error) {
      // ignore storage failures
    }
  };

  const normalizeExtension = (value) => {
    const ext = (value || "").toLowerCase();
    if (!ext) return "";
    if (ext === "jpeg" || ext === "jpe" || ext === "jfif") return "jpg";
    if (ext === "tif") return "tiff";
    if (ext === "svgz") return "svg";
    return ext;
  };

  const isImageContentType = (value) => /^image\//i.test(value || "");

  const extensionFromContentType = (contentType) => {
    if (!contentType) return "";
    const cleaned = contentType.split(";")[0].trim().toLowerCase();
    if (!cleaned.startsWith("image/")) return "";
    const subtype = cleaned.split("/").pop() || "";
    if (subtype.includes("svg")) return "svg";
    if (subtype.includes("jpeg") || subtype.includes("jpg")) return "jpg";
    return normalizeExtension(subtype);
  };

  const sniffImageExtension = (buffer) => {
    if (!buffer || buffer.length < 12) return "";
    if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpg";
    if (
      buffer[0] === 0x89 &&
      buffer[1] === 0x50 &&
      buffer[2] === 0x4e &&
      buffer[3] === 0x47
    ) {
      return "png";
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return "gif";
    if (buffer[0] === 0x42 && buffer[1] === 0x4d) return "bmp";
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "webp";
    }
    return "";
  };

  const downloadedUrls = new Set();
  const seenUrls = new Set();
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

  const isExtensionAllowed = (filters, ext) => {
    const normalized = normalizeExtension(ext);
    if (!filters.extensions.length || !normalized) return true;
    return filters.extensions.includes(normalized);
  };

  const fetchBinary = (url) =>
    new Promise((resolve, reject) => {
      let finished = false;
      let timeoutId;
      const finish = (handler) => {
        if (finished) return;
        finished = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        handler();
      };

      const request = GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "arraybuffer",
        headers: {
          referer: window.location.href,
        },
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

      timeoutId = setTimeout(() => {
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
    panel.dataset.dragging = "false";
    panel.dataset.dragged = "false";
    panel.innerHTML = `
      <div class="gi-header">
        <div class="gi-title">구글 이미지 저장 도구</div>
        <button class="gi-toggle" id="gi-toggle" type="button" title="패널 접기">🗕</button>
      </div>
      <div class="gi-main-grid">
        <div class="gi-main-col">
          <div class="gi-row">
            <label>검색어</label>
            <div class="gi-checks">
              <input id="gi-query" type="text" placeholder="키워드 입력" />
              <button id="gi-search" type="button">검색</button>
            </div>
          </div>
          <div class="gi-row">
            <label>예약 키워드</label>
            <textarea id="gi-queue" rows="3" placeholder="한 줄에 하나씩 입력"></textarea>
          </div>
          <div class="gi-row">
            <label>저장 폴더</label>
            <input id="gi-path" type="text" placeholder="images" />
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-custom-path" type="checkbox" /> 폴더명 직접 입력</label>
          </div>
          <div class="gi-row">
            <label>파일명 접두어</label>
            <input id="gi-basename" type="text" placeholder="image" />
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-custom-basename" type="checkbox" /> 파일명 직접 입력</label>
          </div>
        </div>
        <div class="gi-main-col">
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
          <div class="gi-row">
            <label>최소 크기 필터</label>
            <div>
              너비 <input id="gi-min-width" type="number" value="400" min="0" step="100" /> px, 높이
              <input id="gi-min-height" type="number" value="400" min="0" step="100" /> px
            </div>
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-random-delay-enabled" type="checkbox" /> 랜덤 지연 활성화</label>
          </div>
          <div class="gi-row gi-sub-row">
            <label>요청 간격 (ms)</label>
            <div class="gi-sub-inputs">
              <input id="gi-delay-min" type="number" value="500" min="0" step="100" /> ~
              <input id="gi-delay-max" type="number" value="1500" min="0" step="100" />
            </div>
          </div>
          <div class="gi-row gi-sub-row">
            <label>주기적 대기</label>
            <div class="gi-sub-inputs">
              <input id="gi-batch-min" type="number" value="15" min="1" step="1" /> ~
              <input id="gi-batch-max" type="number" value="30" min="1" step="1" /> 개 마다
              <input id="gi-batch-delay-sec" type="number" value="5" min="0" step="1" /> 초
            </div>
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-auto-start" type="checkbox" /> 검색 후 자동 수집</label>
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-queue-enabled" type="checkbox" /> 예약 키워드 진행</label>
          </div>
          <div class="gi-row gi-inline">
            <label><input id="gi-debug" type="checkbox" /> 실패 URL 로그 출력</label>
          </div>
        </div>
      </div>
      <div class="gi-actions">
        <button id="gi-auto-collect">원본 자동 수집</button>
      </div>
      <div class="gi-counts" id="gi-counts">수집: 0 / 다운로드: 0 / 필터 제외: 0</div>
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
        width: 580px;
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
      #gi-local-panel .gi-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 12px;
        cursor: move;
        user-select: none;
      }
      #gi-local-panel .gi-header .gi-title {
        margin-bottom: 0;
      }
      #gi-local-panel .gi-toggle {
        border: 1px solid #334155;
        background: #0f172a;
        color: #e2e8f0;
        border-radius: 8px;
        padding: 2px 8px;
        font-size: 12px;
        line-height: 1;
        cursor: pointer;
      }
      #gi-local-panel.gi-collapsed .gi-toggle {
        border-radius: 999px;
        width: 36px;
        height: 36px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 16px;
      }
      #gi-local-panel.gi-collapsed.gi-collecting .gi-toggle {
        animation: giPulse 1.4s ease-in-out infinite;
        background: radial-gradient(circle at 30% 30%, #7dd3fc, #38bdf8 60%, #0ea5e9);
        box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.6);
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
        width: 100%;
        box-sizing: border-box;
      }
      #gi-local-panel input[type="number"] {
        width: 60px;
      }
      #gi-local-panel input:disabled {
        background: #0b1324;
        border-color: #1e293b;
        color: #64748b;
        cursor: not-allowed;
      }
      #gi-local-panel input[data-locked="true"] {
        background: #0a0f1f;
        border-color: #1b2435;
        color: #94a3b8;
      }
      #gi-local-panel input[data-locked="true"]::placeholder {
        color: #475569;
      }
      #gi-local-panel textarea {
        border-radius: 8px;
        border: 1px solid #334155;
        background: #0f172a;
        color: #f8fafc;
        padding: 6px 8px;
        resize: vertical;
        min-height: 64px;
        font-family: system-ui, sans-serif;
      }
      #gi-local-panel input[type="checkbox"] {
        width: 14px;
        height: 14px;
      }
      #gi-local-panel .gi-actions {
        grid-column: 1 / -1;
        margin-top: 16px;
        border-top: 1px solid #334155;
        padding-top: 10px;
      }
      #gi-local-panel .gi-counts,
      #gi-local-panel .gi-status {
        grid-column: 1 / -1;
        font-size: 12px;
        color: #94a3b8;
        margin-bottom: 6px;
      }
      #gi-local-panel.gi-collapsed .gi-row,
      #gi-local-panel.gi-collapsed .gi-actions,
      #gi-local-panel.gi-collapsed .gi-counts,
      #gi-local-panel.gi-collapsed .gi-status,
      #gi-local-panel.gi-collapsed .gi-title,
      #gi-local-panel.gi-collapsed .gi-main-grid {
        display: none;
      }
      #gi-local-panel.gi-collapsed .gi-header {
        justify-content: flex-end;
      }
      #gi-local-panel.gi-collapsed {
        background: transparent;
        box-shadow: none;
        padding: 0;
        width: auto;
      }
      #gi-local-panel .gi-sub-row {
        display: grid;
        gap: 6px;
        font-size: 12px;
        padding-left: 22px;
      }
      #gi-local-panel .gi-sub-row .gi-sub-inputs {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      #gi-local-panel .gi-sub-row input {
        width: 60px;
      }
      #gi-local-panel .gi-main-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 0 24px;
        border-top: 1px solid #334155;
        padding-top: 10px;
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
      @keyframes giPulse {
        0% {
          box-shadow: 0 0 0 0 rgba(56, 189, 248, 0.6);
          transform: scale(1);
        }
        70% {
          box-shadow: 0 0 0 10px rgba(56, 189, 248, 0);
          transform: scale(1.05);
        }
        100% {
          box-shadow: 0 0 0 0 rgba(56, 189, 248, 0);
          transform: scale(1);
        }
      }
    `;
    document.head.appendChild(style);
  };

  const setupHandlers = () => {
    // 1. UI 요소 및 변수 초기화
    const pathInput = document.getElementById("gi-path");
    const queryInput = document.getElementById("gi-query");
    const searchBtn = document.getElementById("gi-search");
    const queueInput = document.getElementById("gi-queue");
    const customPathInput = document.getElementById("gi-custom-path");
    const baseNameInput = document.getElementById("gi-basename");
    const customBaseNameInput = document.getElementById("gi-custom-basename");
    const extInputs = Array.from(document.querySelectorAll(".gi-ext"));
    const autoStartInput = document.getElementById("gi-auto-start");
    const queueEnabledInput = document.getElementById("gi-queue-enabled");
    const debugInput = document.getElementById("gi-debug");
    const minWidthInput = document.getElementById("gi-min-width");
    const minHeightInput = document.getElementById("gi-min-height");
    const randomDelayEnabledInput = document.getElementById("gi-random-delay-enabled");
    const delayMinInput = document.getElementById("gi-delay-min");
    const delayMaxInput = document.getElementById("gi-delay-max");
    const batchMinInput = document.getElementById("gi-batch-min");
    const batchMaxInput = document.getElementById("gi-batch-max");
    const batchDelaySecInput = document.getElementById("gi-batch-delay-sec");
    const subRows = Array.from(document.querySelectorAll(".gi-sub-row"));
    const countsEl = document.getElementById("gi-counts");
    const statusEl = document.getElementById("gi-status");
    const autoCollectBtn = document.getElementById("gi-auto-collect");
    const toggleBtn = document.getElementById("gi-toggle");
    panelElement = document.getElementById("gi-local-panel");
    const panel = panelElement;
    const header = panel?.querySelector(".gi-header");
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
    const setInputLocked = (input, locked) => {
      if (!input) return;
      input.disabled = locked;
      if (locked) {
        input.setAttribute("data-locked", "true");
      } else {
        input.removeAttribute("data-locked");
      }
    };

    // 2. 로컬 저장소에서 설정 불러오기 및 기본값 적용
    let settings = loadSettings();
    if (!settings.defaultsApplied) {
      const nextSettings = { ...settings };
      if (!Array.isArray(nextSettings.extensions)) nextSettings.extensions = ["jpg", "png"];
      if (typeof nextSettings.autoStart !== "boolean") nextSettings.autoStart = true;
      if (typeof nextSettings.debug !== "boolean") nextSettings.debug = true;
      if (typeof nextSettings.minWidth !== "number") nextSettings.minWidth = 400;
      if (typeof nextSettings.minHeight !== "number") nextSettings.minHeight = 400;
      if (typeof nextSettings.randomDelayEnabled !== "boolean") nextSettings.randomDelayEnabled = false;
      if (typeof nextSettings.delayMin !== "number") nextSettings.delayMin = 500;
      if (typeof nextSettings.delayMax !== "number") nextSettings.delayMax = 1500;
      if (typeof nextSettings.batchMin !== "number") nextSettings.batchMin = 15;
      if (typeof nextSettings.batchMax !== "number") nextSettings.batchMax = 30;
      if (typeof nextSettings.batchDelaySec !== "number") nextSettings.batchDelaySec = 5;
      nextSettings.defaultsApplied = true;
      saveSettings(nextSettings);
      settings = nextSettings;
    }

    // 3. 불러온 설정을 UI에 반영
    pathInput.value = settings.path || "images";
    queryInput.value = settings.query || "";
    queueInput.value = settings.queue || "";
    baseNameInput.value =
      settings.baseName || sanitizeFilename(queryInput.value.trim()) || "image";
    minWidthInput.value = typeof settings.minWidth === "number" ? settings.minWidth : 400;
    minHeightInput.value = typeof settings.minHeight === "number" ? settings.minHeight : 400;
    randomDelayEnabledInput.checked = !!settings.randomDelayEnabled;
    delayMinInput.value = typeof settings.delayMin === "number" ? settings.delayMin : 500;
    delayMaxInput.value = typeof settings.delayMax === "number" ? settings.delayMax : 1500;
    batchMinInput.value = typeof settings.batchMin === "number" ? settings.batchMin : 15;
    batchMaxInput.value = typeof settings.batchMax === "number" ? settings.batchMax : 30;
    batchDelaySecInput.value = typeof settings.batchDelaySec === "number" ? settings.batchDelaySec : 5;

    if (typeof settings.customPath === "boolean") customPathInput.checked = settings.customPath;
    if (typeof settings.customBaseName === "boolean") customBaseNameInput.checked = settings.customBaseName;

    const syncPathFromQuery = () => {
      pathInput.value = sanitizePath(queryInput.value.trim()) || "images";
    };
    const syncBaseNameFromQuery = () => {
      baseNameInput.value = sanitizeFilename(queryInput.value.trim()) || "image";
    };
    if (!customPathInput.checked) {
      syncPathFromQuery();
    }
    setInputLocked(pathInput, !customPathInput.checked);
    if (!customBaseNameInput.checked) {
      syncBaseNameFromQuery();
    }
    setInputLocked(baseNameInput, !customBaseNameInput.checked);
    if (Array.isArray(settings.extensions) && settings.extensions.length) {
      extInputs.forEach((input) => {
        input.checked = settings.extensions.includes(input.value);
      });
    } else {
      extInputs.forEach((input) => {
        input.checked = ["jpg", "png"].includes(input.value);
      });
    }
    autoStartInput.checked =
      typeof settings.autoStart === "boolean" ? settings.autoStart : true;
    if (typeof settings.queueEnabled === "boolean") {
      queueEnabledInput.checked = settings.queueEnabled;
    }
    if (settings.position && panel) {
      panel.style.top = `${settings.position.top}px`;
      panel.style.right = "auto";
      panel.style.left = `${settings.position.left}px`;
      panel.dataset.dragged = "true";
    }
    if (typeof settings.collapsed === "boolean" && panel) {
      panel.classList.toggle("gi-collapsed", settings.collapsed);
      const collapsed = panel.classList.contains("gi-collapsed");
      toggleBtn.textContent = collapsed ? "🖼️" : "🗕";
      toggleBtn.title = collapsed ? "패널 펼치기" : "패널 접기";
    }
    debugInput.checked = typeof settings.debug === "boolean" ? settings.debug : true;

    // 4. 핵심 로직 및 헬퍼 함수 정의
    const setStatus = (text) => {
      statusEl.textContent = text;
    };
    logDebug = (...args) => {
      if (!debugInput.checked) return;
      console.info("[GI-IMG]", ...args);
    };

    const sessionState = loadSessionState();
    let collectedCount = Number(sessionState.collectedCount) || 0;
    let downloadedCount = Number(sessionState.downloadedCount) || 0;
    let filteredOutCount = Number(sessionState.filteredOutCount) || 0;
    const updateCounts = () => {
      if (!countsEl) return;
      countsEl.textContent = `수집: ${collectedCount} / 다운로드: ${downloadedCount} / 필터 제외: ${filteredOutCount}`;
      saveSessionState({ collectedCount, downloadedCount, filteredOutCount });
    };

    const getFilters = () => ({
      extensions: extInputs
        .filter((input) => input.checked)
        .map((input) => normalizeExtension(input.value)),
    });

    const persistSettings = () => {
      const filters = getFilters();
      const currentPath = pathInput.value.trim() || "images";
      const baseName = baseNameInput.value.trim() || "image";
      const query = queryInput.value.trim();
      const queue = queueInput.value;
      saveSettings({
        path: currentPath,
        query,
        queue,
        baseName,
        extensions: filters.extensions,
        autoStart: autoStartInput.checked,
        queueEnabled: queueEnabledInput.checked,
        customPath: customPathInput.checked,
        customBaseName: customBaseNameInput.checked,
        minWidth: Number(minWidthInput.value) || 0,
        minHeight: Number(minHeightInput.value) || 0,
        randomDelayEnabled: randomDelayEnabledInput.checked,
        delayMin: Number(delayMinInput.value) || 500,
        delayMax: Number(delayMaxInput.value) || 1500,
        batchMin: Number(batchMinInput.value) || 15,
        batchMax: Number(batchMaxInput.value) || 30,
        batchDelaySec: Number(batchDelaySecInput.value) || 5,
        defaultsApplied: true,
        collapsed: panel.classList.contains("gi-collapsed"),
        position:
          panel && panel.dataset.dragged === "true"
            ? { top: panel.offsetTop, left: panel.offsetLeft }
            : undefined,
        debug: debugInput.checked,
      });
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

    buildFilename = (url, index, extHint = "") => {
      const ext = normalizeExtension(extHint) || getUrlExtension(url) || "jpg";
      const baseName = sanitizeFilename(baseNameInput.value.trim() || "image");
      if (baseName) {
        return ensureUniqueName(`${baseName}-${String(index).padStart(4, "0")}.${ext}`);
      }
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

    getDownloadPath = (name) => {
      const raw = pathInput.value.trim();
      const queryPath = sanitizePath(queryInput.value.trim());
      const base = customPathInput.checked
        ? sanitizePath(raw) || "images"
        : queryPath || "images";
      return `${base}/${name}`;
    };

    const resolveOriginalUrl = async (url, visited = new Set()) => {
      if (!url || typeof url !== "string") return "";
      if (visited.has(url)) return url;
      visited.add(url);
      if (url.startsWith("data:") || url.startsWith("blob:")) return url;
      if (isOriginalCandidate(url)) return url;
      try {
        const response = await fetchBinary(url);
        const contentType = response?.contentType || "";
        if (contentType.includes("html")) {
          const text = new TextDecoder("utf-8").decode(response.buffer);
          const extracted = extractOriginalFromHtml(text);
          if (extracted) return resolveOriginalUrl(extracted, visited);
          const ogImage = extractImageFromHtml(text, url);
          if (ogImage) return resolveOriginalUrl(ogImage, visited);
        }
      } catch (error) {
        // ignore resolve failures
      }
      return url;
    };

    const parseQueue = (value) =>
      (value || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

    const updateQueue = (list) => {
      queueInput.value = list.join("\n");
      persistSettings();
    };


    const addUrlToState = (url) => {
      if (!url) return false;
      const normalized = normalizeUrl(url);
      if (seenUrls.has(normalized)) return false;
      seenUrls.add(normalized);
      return true;
    };

    const getImageDimensions = (url) =>
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
        img.onerror = (err) => reject(err);
        img.src = url;
      });

    const getThumbSize = (thumb) => {
      if (!thumb) return 0;
      const rect = thumb.getBoundingClientRect();
      return Math.max(
        thumb.naturalWidth || 0,
        thumb.naturalHeight || 0,
        thumb.width || 0,
        thumb.height || 0,
        rect.width || 0,
        rect.height || 0
      );
    };

    const getThumbCandidates = (thumb, fallbackUrl) => {
      const size = getThumbSize(thumb);
      if (size > 0 && size <= 20) return [];
      const preferred = [];
      const secondary = [];
      const thumbSources = [];
      if (fallbackUrl) preferred.push(fallbackUrl);
      if (thumb) {
        const parent = thumb.closest("[data-ou],[data-iurl],[data-iu]");
        if (parent) {
          ["data-ou", "data-iurl", "data-iu"].forEach((attr) => {
            const value = parent.getAttribute(attr);
            if (value) preferred.push(value);
          });
        }
        const parentIv = thumb.closest("[data-iv]");
        if (parentIv) {
          const dataIv = parentIv.getAttribute("data-iv");
          const extracted = extractUrlFromDataIv(dataIv);
          if (extracted) preferred.push(extracted);
        }
        const lpage = thumb.closest("[data-lpage]")?.getAttribute("data-lpage");
        if (lpage) secondary.push(lpage);
        const anchor = thumb.closest("a[href]");
        if (anchor && anchor.href) secondary.push(anchor.href);
        const directAttrs = ["data-iurl", "data-src", "data-lazy-src", "data-iu", "src"];
        directAttrs.forEach((attr) => {
          const value = thumb.getAttribute(attr);
          if (value) thumbSources.push(value);
        });
        if (thumb.currentSrc) thumbSources.push(thumb.currentSrc);
        if (thumb.src) thumbSources.push(thumb.src);
      }
      const seen = new Set();
      const dedupe = (list) =>
        list
          .map((value) => (value || "").trim())
          .filter(Boolean)
          .filter((value) => {
            if (seen.has(value)) return false;
            seen.add(value);
            return true;
          });
      const ordered = [...dedupe(preferred), ...dedupe(secondary)];
      const allowThumbData = size >= 500;
      const dedupedThumbs = dedupe(thumbSources);
      const onlyDataThumbs =
        ordered.length === 0 &&
        dedupedThumbs.length > 0 &&
        dedupedThumbs.every((value) => value.startsWith("data:"));
      if (onlyDataThumbs && size > 0 && size < 500) {
        return [];
      }
      const filteredThumbs = dedupedThumbs.filter((value) => {
        if (!value.startsWith("data:")) return true;
        return allowThumbData;
      });
      return [...ordered, ...filteredThumbs];
    };

    const isThumbnailUrl = (value) =>
      /^https?:\/\/(encrypted-tbn0\.gstatic\.com|tbn0\.gstatic\.com)\//i.test(value || "") ||
      /^https?:\/\/lh3\.googleusercontent\.com\/ogw\//i.test(value || "");

    const isPageVisible = () => !document.hidden;

    const collectFromViewer = async (thumb, fallbackUrl = "") => {
      const viewerUrl = isPageVisible() ? await waitForViewerUrl() : "";
      logDebug("viewer url", viewerUrl || "(none)");
      const candidates = viewerUrl ? [viewerUrl] : getThumbCandidates(thumb, fallbackUrl);
      logDebug("candidates", candidates);
      const filteredCandidates = candidates.filter(
        (value) =>
          value &&
          !value.startsWith("blob:") &&
          (!viewerUrl || !value.startsWith("data:")) &&
          !isThumbnailUrl(value)
      );
      logDebug("filtered candidates", filteredCandidates);
      const seen = new Set();
      const minWidth = Number(minWidthInput.value) || 0;
      const minHeight = Number(minHeightInput.value) || 0;
      for (const candidate of filteredCandidates) {
        if (!state.autoCollecting) break;
        if (!candidate || seen.has(candidate)) continue;
        seen.add(candidate);
        const resolved = await resolveOriginalUrl(candidate);
        if (!state.autoCollecting) break;
        logDebug("resolved url", resolved);
        if (isThumbnailUrl(resolved)) {
          logDebug("skip thumbnail url", resolved);
          continue;
        }
        if (resolved.startsWith("data:") && getThumbSize(thumb) < 500) {
          logDebug("skip small data url", resolved);
          continue;
        }
        if (!viewerUrl && resolved.startsWith("data:")) {
          logDebug("skip data url without viewer", resolved);
          continue;
        }
        const added = addUrlToState(resolved);
        if (!added) continue;
        collectedCount += 1;
        updateCounts();
        const filters = getFilters();
        const passes = applyFilters([resolved], filters).length > 0;
        if (!passes) {
          filteredOutCount += 1;
          updateCounts();
          logDebug("filtered by extension", resolved);
          return true;
        }
        if ((minWidth > 0 || minHeight > 0) && !viewerUrl) {
          try {
            const dimensions = await getImageDimensions(resolved);
            if (!state.autoCollecting) break;
            if (
              (minWidth > 0 && dimensions.width < minWidth) ||
              (minHeight > 0 && dimensions.height < minHeight)
            ) {
              filteredOutCount += 1;
              updateCounts();
              logDebug("filtered by size", resolved, dimensions);
              return true;
            }
          } catch (error) {
            logDebug("Failed to get image dimensions:", error);
          }
        }
        const result = await downloadOriginal(resolved, autoDownloadIndex, filters);
        if (!state.autoCollecting) break;
        logDebug("download result", result, resolved);
        autoDownloadIndex += 1;
        if (result === "downloaded") {
          downloadedCount += 1;
          updateCounts();
          return true;
        }
        if (result === "filtered" || result !== "skipped") {
          filteredOutCount += 1;
          updateCounts();
          return true;
        }
        return true;
      }
      return false;
    };

    const startAutoCollect = async () => {
      if (state.autoCollecting) return;

      state.autoCollecting = true;
      state.stoppedByUser = false;
      autoDownloadIndex = 1;
      const randomDelayEnabled = randomDelayEnabledInput.checked;
      const delayMin = Number(delayMinInput.value) || 500;
      const delayMax = Number(delayMaxInput.value) || 1500;
      const batchMin = Number(batchMinInput.value) || 15;
      const batchMax = Number(batchMaxInput.value) || 30;
      const batchDelaySec = Number(batchDelaySecInput.value) || 5;
      let nextBatchTarget = 0;
      const updateNextBatchTarget = () => {
        if (!randomDelayEnabled) return;
        nextBatchTarget = downloadedCount + getRandom(batchMin, batchMax);
      };

      panelElement?.classList.add("gi-collecting");
      autoCollectBtn.textContent = "자동 수집 중지";
      setStatus("수집 중");
      logDebug("auto collect start");
      downloadedUrls.clear();
      seenUrls.clear();
      usedNames.clear();
      collectedCount = 0;
      downloadedCount = 0;
      filteredOutCount = 0;
      updateCounts();
      updateNextBatchTarget();

      const sleep = async (ms) => {
        if (!state.autoCollecting) return false;
        const step = 200;
        let remaining = ms;
        while (state.autoCollecting && remaining > 0) {
          const wait = Math.min(step, remaining);
          await new Promise((resolve) => setTimeout(resolve, wait));
          remaining -= wait;
        }
        return state.autoCollecting;
      };

      const preloadAllThumbnails = async () => {
        const maxSteps = 40;
        let lastHeight = 0;
        let stableCount = 0;
        for (let step = 0; step < maxSteps; step += 1) {
          if (!state.autoCollecting) return;
          window.scrollTo(0, document.body.scrollHeight);
          if (!(await sleep(document.hidden ? 2800 : 900))) return;
          const height = document.body.scrollHeight;
          if (Math.abs(height - lastHeight) < 2) {
            stableCount += 1;
          } else {
            stableCount = 0;
            lastHeight = height;
          }
          if (stableCount >= 3) break;
        }
        window.scrollTo(0, 0);
        await sleep(document.hidden ? 1600 : 500);
      };

      setStatus("이미지 로딩 중 (스크롤)");
      await preloadAllThumbnails();
      if (!state.autoCollecting) return;
      setStatus("수집 중");

      let thumbs = getThumbnailElements();
      if (!thumbs.length) {
        setStatus("썸네일을 찾지 못했습니다. 스크롤 후 다시 시도해주세요.");
        state.autoCollecting = false;
        panelElement?.classList.remove("gi-collecting");
        autoCollectBtn.textContent = "원본 자동 수집";
        logDebug("no thumbnails found");
        return;
      }

      const processedThumbs = new Set();
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
          if (!(await sleep(document.hidden ? 1200 : 350))) break;
          const collected = await collectFromViewer(thumb, fallback);
          if (!collected && debugInput.checked) {
            console.warn("[GI-IMG] No viewer URL found for thumb", thumb);
          }
        } catch (error) {
          if (debugInput.checked) {
            console.warn("[GI-IMG] Auto collect error", error);
          }
        }

        if (i % 15 === 0) {
          window.scrollBy(0, window.innerHeight);
          if (!(await sleep(document.hidden ? 1200 : 400))) break;
          thumbs = getThumbnailElements();
        } else {
          if (
            randomDelayEnabled &&
            batchDelaySec > 0 &&
            downloadedCount > 0 &&
            downloadedCount >= nextBatchTarget
          ) {
          setStatus(`${nextBatchTarget}개 수집 후 ${batchDelaySec}초 대기...`);
          await sleep(batchDelaySec * 1000);
          setStatus("수집 중");
          updateNextBatchTarget();
          }
          const baseDelay = randomDelayEnabled
            ? getRandom(delayMin, delayMax)
            : document.hidden
            ? 2000
            : 500;
          const jitter = randomDelayEnabled ? 0 : document.hidden ? 500 : 200;
          const delay = baseDelay + jitter;
          if (!(await sleep(delay))) break;
        }
      }

      state.autoCollecting = false;
      panelElement?.classList.remove("gi-collecting");
      autoCollectBtn.textContent = "원본 자동 수집";
      setStatus("대기 중");
      logDebug("auto collect stop");
      if (state.stoppedByUser) return;
      if (!queueEnabledInput.checked) return;
      const queue = parseQueue(queueInput.value);
      if (!queue.length) return;
      const nextKeyword = queue.shift();
      updateQueue(queue);
      runSearch(nextKeyword, { forceAutoStart: true });
    };
    const stopAutoCollect = () => {
      state.autoCollecting = false;
      state.stoppedByUser = true;
      panelElement?.classList.remove("gi-collecting");
      autoCollectBtn.textContent = "원본 자동 수집";
      setStatus("대기 중");
      logDebug("auto collect stop");
    };

    const runSearch = (keyword, { forceAutoStart = false } = {}) => {
      if (!keyword) return;
      queryInput.value = keyword;
      persistSettings();
      const url = new URL("/search", window.location.origin);
      url.searchParams.set("udm", "2");
      url.searchParams.set("q", keyword);
      if (forceAutoStart || autoStartInput.checked) {
        sessionStorage.setItem(AUTO_START_KEY, "1");
      } else {
        sessionStorage.removeItem(AUTO_START_KEY);
      }
      logDebug("run search", url.toString());
      window.location.assign(url.toString());
    };

    // 5. UI 이벤트 리스너 바인딩
    autoCollectBtn.addEventListener("click", () => {
      if (state.autoCollecting) {
        stopAutoCollect();
        return;
      }
      startAutoCollect();
    });

    [
      ...extInputs,
      pathInput,
      baseNameInput,
      queryInput,
      queueInput,
      autoStartInput,
      queueEnabledInput,
      customPathInput,
      customBaseNameInput,
      debugInput,
      minWidthInput,
      minHeightInput,
      randomDelayEnabledInput,
      delayMinInput,
      delayMaxInput,
      batchMinInput,
      batchMaxInput,
      batchDelaySecInput,
    ].forEach((input) => {
      input.addEventListener("change", persistSettings);
    });
    
    queryInput.addEventListener("input", () => {
      if (!customPathInput.checked) {
        syncPathFromQuery();
      }
      if (!customBaseNameInput.checked) {
        syncBaseNameFromQuery();
      }
    });
    
    customPathInput.addEventListener("change", () => {
      setInputLocked(pathInput, !customPathInput.checked);
      if (!customPathInput.checked) {
        syncPathFromQuery();
      }
    });
    customBaseNameInput.addEventListener("change", () => {
      setInputLocked(baseNameInput, !customBaseNameInput.checked);
      if (!customBaseNameInput.checked) {
        syncBaseNameFromQuery();
      } else if (!baseNameInput.value.trim()) {
        syncBaseNameFromQuery();
      }
    });
    
    if (searchBtn && queryInput) {
      searchBtn.addEventListener("click", () => runSearch(queryInput.value.trim()));
      queryInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          runSearch(queryInput.value.trim());
        }
      });
    }

    // 6. 패널 드래그 앤 드롭 및 토글 로직
    const supportsPointerEvents = "PointerEvent" in window;
    const dragMoveEvent = supportsPointerEvents ? "pointermove" : "mousemove";
    const dragEndEvent = supportsPointerEvents ? "pointerup" : "mouseup";
    const dragStartEvent = supportsPointerEvents ? "pointerdown" : "mousedown";
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let dragStartX = 0;
    let dragStartY = 0;
    let dragOrigin = "";
    let suppressToggleClick = false;
    let dragMoved = false;
    let activePointerId = null;

    const startDragging = (event, origin) => {
      if (!panel) return;
      if (typeof event.button === "number" && event.button !== 0) return;
      if (origin === "header" && event.cancelable) {
        event.preventDefault();
      }
      panel.dataset.dragging = "true";
      dragMoved = false;
      const rect = panel.getBoundingClientRect();
      dragOffsetX = event.clientX - rect.left;
      dragOffsetY = event.clientY - rect.top;
      dragStartX = event.clientX;
      dragStartY = event.clientY;
      dragOrigin = origin;
      suppressToggleClick = false;
      if (
        origin === "header" &&
        typeof event.pointerId === "number" &&
        panel.setPointerCapture
      ) {
        activePointerId = event.pointerId;
        try {
          panel.setPointerCapture(event.pointerId);
        } catch (error) {
          activePointerId = null;
        }
      }
      document.addEventListener(dragMoveEvent, onMouseMove);
      document.addEventListener(dragEndEvent, stopDragging);
    };
    const onMouseMove = (event) => {
      if (panel.dataset.dragging !== "true") return;
      if (typeof activePointerId === "number" && event.pointerId !== activePointerId) return;
      const moved =
        Math.abs(event.clientX - dragStartX) + Math.abs(event.clientY - dragStartY) > 4;
      if (moved && !dragMoved) {
        dragMoved = true;
        panel.dataset.dragged = "true";
      }
      if (dragOrigin === "toggle" && moved) suppressToggleClick = true;
      const nextLeft = Math.max(0, event.clientX - dragOffsetX);
      const nextTop = Math.max(0, event.clientY - dragOffsetY);
      panel.style.left = `${nextLeft}px`;
      panel.style.top = `${nextTop}px`;
      panel.style.right = "auto";
    };
    const stopDragging = (event) => {
      if (panel.dataset.dragging !== "true") return;
      if (typeof activePointerId === "number" && event?.pointerId !== activePointerId) return;
      panel.dataset.dragging = "false";
      document.removeEventListener(dragMoveEvent, onMouseMove);
      document.removeEventListener(dragEndEvent, stopDragging);
      if (typeof activePointerId === "number" && panel.releasePointerCapture) {
        try {
          panel.releasePointerCapture(activePointerId);
        } catch (error) {
          // ignore release failures
        }
      }
      activePointerId = null;
      persistSettings();
    };
    
    if (toggleBtn && panel) {
      toggleBtn.addEventListener(dragStartEvent, (event) => {
        if (!panel.classList.contains("gi-collapsed")) {
          event.stopPropagation();
          return;
        }
        event.stopPropagation();
        startDragging(event, "toggle");
      });
      toggleBtn.addEventListener("click", () => {
        if (suppressToggleClick) {
          suppressToggleClick = false;
          logDebug("toggle suppressed by drag");
          return;
        }
        const beforeRect = toggleBtn.getBoundingClientRect();
        const targetCenterX = beforeRect.left + beforeRect.width / 2;
        const targetCenterY = beforeRect.top + beforeRect.height / 2;
        panel.classList.toggle("gi-collapsed");
        const collapsed = panel.classList.contains("gi-collapsed");
        toggleBtn.textContent = collapsed ? "🖼️" : "🗕";
        toggleBtn.title = collapsed ? "패널 펼치기" : "패널 접기";
        const afterBtnRect = toggleBtn.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const currentCenterX = afterBtnRect.left + afterBtnRect.width / 2;
        const currentCenterY = afterBtnRect.top + afterBtnRect.height / 2;
        const deltaX = targetCenterX - currentCenterX;
        const deltaY = targetCenterY - currentCenterY;
        const nextLeft = Math.max(0, panelRect.left + deltaX);
        const nextTop = Math.max(0, panelRect.top + deltaY);
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
        panel.style.right = "auto";
        persistSettings();
        logDebug("toggle panel", collapsed ? "collapsed" : "expanded");
      });
    }
    if (header && panel) {
      header.addEventListener(dragStartEvent, (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target && target.closest(".gi-toggle")) return;
        startDragging(event, "header");
      });
    }

    // 7. 초기화 및 페이지 이동 시 자동 시작 로직
    updateCounts();
    window.addEventListener("beforeunload", () => {
      saveSessionState({ collectedCount, downloadedCount, filteredOutCount });
    });
    if (autoStartInput.checked && !state.autoCollecting) {
      try {
        const url = new URL(window.location.href);
        const isSearchPage = url.pathname === "/search";
        const isImageSearch = url.searchParams.get("udm") === "2" || url.searchParams.get("tbm") === "isch";
        if (isSearchPage && isImageSearch) {
          const autoStartPending = sessionStorage.getItem(AUTO_START_KEY) === "1";
          if (!autoStartPending) return;
          sessionStorage.removeItem(AUTO_START_KEY);
          setTimeout(() => {
            if (!state.autoCollecting) startAutoCollect();
          }, 500);
        }
      } catch (error) {
        // ignore url parse failures
      }
    }
  };

  const processImageBuffer = async (buffer, contentType, url, index, filters) => {
    if (contentType.includes("html")) {
      const text = new TextDecoder("utf-8").decode(buffer);
      const extracted = extractOriginalFromHtml(text);
      if (extracted && extracted !== url) {
        return downloadOriginal(extracted, index, filters);
      }
      const ogImage = extractImageFromHtml(text, url);
      if (ogImage && ogImage !== url) {
        return downloadOriginal(ogImage, index, filters);
      }
      return "failed";
    }
    const data = buffer ? new Uint8Array(buffer) : null;
    if (!data || !data.byteLength) return "failed";
    const extFromType = extensionFromContentType(contentType);
    const extFromUrl = getUrlExtension(url);
    const extFromSniff = sniffImageExtension(data);
    const allowOctet = contentType.includes("octet-stream") && (extFromUrl || extFromSniff);
    const isImageData =
      isImageContentType(contentType) || Boolean(extFromSniff) || Boolean(allowOctet);
    if (!isImageData) return "failed";
    const chosenExt = extFromType || extFromUrl || extFromSniff;
    if (!isExtensionAllowed(filters, chosenExt)) return "filtered";
    const name = buildFilename(url, index, chosenExt);
    const path = getDownloadPath(name);
    const blobType =
      (isImageContentType(contentType) && contentType) ||
      (extFromSniff ? `image/${extFromSniff}` : "") ||
      "";
    saveBlob(new Blob([data], { type: blobType || "application/octet-stream" }), path);
    downloadedUrls.add(normalizeUrl(url));
    return "downloaded";
  };

  const downloadOriginal = async (url, index, filters) => {
    const normalized = normalizeUrl(url);
    if (downloadedUrls.has(normalized)) return "skipped";
    if (
      /^https?:\/\/(encrypted-tbn0\.gstatic\.com|tbn0\.gstatic\.com)\//i.test(url) ||
      /^https?:\/\/lh3\.googleusercontent\.com\/ogw\//i.test(url)
    ) {
      return "filtered";
    }
    if (url.startsWith("data:")) {
      try {
        const commaIndex = url.indexOf(",");
        const meta = url.slice(0, commaIndex);
        if (!/^data:\s*image\//i.test(meta)) return "failed";
        const base64 = meta.includes(";base64");
        const data = url.slice(commaIndex + 1);
        const bytes = base64 ? atob(data) : decodeURIComponent(data);
        const buffer = new Uint8Array(bytes.length);
        for (let i = 0; i < bytes.length; i += 1) {
          buffer[i] = bytes.charCodeAt(i);
        }
        const mimeType = meta.replace(/^data:\s*/i, "");
        const ext = extensionFromContentType(mimeType);
        if (!isExtensionAllowed(filters, ext)) return "filtered";
        const name = buildFilename(url, index, ext);
        const path = getDownloadPath(name);
        saveBlob(new Blob([buffer], { type: mimeType }), path);
        downloadedUrls.add(normalized);
        return "downloaded";
      } catch (error) {
        return "failed";
      }
    }
    if (url.startsWith("blob:")) {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        let ext = extensionFromContentType(blob.type || "");
        if (!ext) {
          const buffer = new Uint8Array(await blob.arrayBuffer());
          ext = sniffImageExtension(buffer);
          if (!ext) return "failed";
        }
        if (!isExtensionAllowed(filters, ext)) return "filtered";
        const name = buildFilename(url, index, ext);
        const path = getDownloadPath(name);
        saveBlob(blob, path);
        downloadedUrls.add(normalized);
        return "downloaded";
      } catch (error) {
        return "failed";
      }
    }

    try {
      const { buffer, contentType } = await fetchBinary(url);
      return await processImageBuffer(buffer, contentType, url, index, filters);
    } catch (error) {
      logDebug("GM_xmlhttpRequest failed, falling back to fetch:", error.message);
    }

    try {
      const response = await fetch(url);
      if (!response.ok) return "failed";
      const contentType = response.headers.get("content-type") || "";
      const arrayBuffer = await response.arrayBuffer();
      return await processImageBuffer(arrayBuffer, contentType, url, index, filters);
    } catch (error) {
      logDebug("Fetch fallback failed:", error.message);
      return "failed";
    }
  };

  const isOriginalCandidate = (url) => {
    if (!url || typeof url !== "string") return false;
    if (url.startsWith("data:") || url.startsWith("blob:")) return true;
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
      if (!state.autoCollecting) return "";
      const url = findViewerUrl();
      if (url) return url;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return "";
  };

  let autoDownloadIndex = 1;

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

  const init = () => {
    try {
      if (document.getElementById("gi-local-panel")) return;
      if (!document.body || !document.head) {
        setTimeout(init, 300);
        return;
      }
      createPanel();
      setupHandlers();
    } catch (e) {
      console.error("[GI-DEBUG] Error in init():", e);
    }
  };
  
  const installPageHooks = () => {
    if (window.__giHooksInstalled) return;
    window.__giHooksInstalled = true;

    const ensurePanel = () => {
      if (!document.getElementById("gi-local-panel")) {
        init();
      }
    };

    window.addEventListener("popstate", () => {
      setTimeout(ensurePanel, 50);
    });

    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      if (typeof original !== "function") return;
      history[method] = function (...args) {
        const result = original.apply(this, args);
        setTimeout(ensurePanel, 50);
        return result;
      };
    });

    const observer = new MutationObserver(() => {
      if (!document.getElementById("gi-local-panel")) {
        init();
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      init();
      installPageHooks();
    });
  } else {
    init();
    installPageHooks();
  }
})();
