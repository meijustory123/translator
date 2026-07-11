(() => {
  "use strict";

  if (globalThis.__siliconFlowSelectionTranslatorLoaded) {
    return;
  }
  globalThis.__siliconFlowSelectionTranslatorLoaded = true;

  const TRANSLATION_PORT_NAME = "multi-provider-translation";
  const MAX_TEXT_LENGTH = 20_000;
  const SELECTION_DEBOUNCE_MS = 320;
  const CONTEXT_IMAGE_MAX_AGE_MS = 30_000;

  let autoTranslateEnabled = false;
  let settingsLoaded = false;
  let selectionTimer = null;
  let lastSelectionKey = "";
  let lastImageContext = null;
  let activeRequest = null;
  let visibleAnchor = null;
  let renderTimer = null;

  const ui = createTranslatorUi();
  void loadPublicSettings();

  document.addEventListener("selectionchange", () => scheduleSelectionCheck(SELECTION_DEBOUNCE_MS));
  document.addEventListener(
    "pointerup",
    (event) => {
      if (!ui.overlay.hidden || event.composedPath().includes(ui.host)) {
        return;
      }
      scheduleSelectionCheck(60);
    },
    true,
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (event.key === "Shift" || event.key.startsWith("Arrow")) {
        scheduleSelectionCheck(90);
      }
    },
    true,
  );
  document.addEventListener("contextmenu", rememberImageContext, true);
  window.addEventListener("scroll", hidePanelWhileScrolling, { passive: true, capture: true });
  window.addEventListener("resize", () => {
    if (!ui.panel.hidden && visibleAnchor) {
      positionPanel(visibleAnchor);
    }
  });
  document.addEventListener("keydown", handleGlobalKeydown, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== "object") {
      return false;
    }

    if (message.type === "PUBLIC_SETTINGS_CHANGED") {
      autoTranslateEnabled = Boolean(message.autoTranslate);
      settingsLoaded = true;
      if (!autoTranslateEnabled && activeRequest?.kind === "TRANSLATE_TEXT") {
        cancelActiveRequest();
        hidePanel();
      }
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "START_IMAGE_SELECTION") {
      startImageSelection();
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === "TRANSLATE_CONTEXT_IMAGE") {
      translateRememberedImage();
      sendResponse({ ok: true });
      return false;
    }

    return false;
  });

  async function loadPublicSettings() {
    try {
      const settings = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
      if (!settings?.ok) {
        throw new Error("SETTINGS_UNAVAILABLE");
      }
      autoTranslateEnabled = settings?.autoTranslate !== false;
    } catch {
      autoTranslateEnabled = false;
    } finally {
      settingsLoaded = true;
    }
  }

  function scheduleSelectionCheck(delay) {
    if (!settingsLoaded || !autoTranslateEnabled || !ui.overlay.hidden) {
      return;
    }

    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(checkCurrentSelection, delay);
  }

  function checkCurrentSelection() {
    if (!autoTranslateEnabled || !ui.overlay.hidden || isEditingText()) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    if (range.commonAncestorContainer?.getRootNode?.() === ui.shadow) {
      return;
    }

    const text = normalizeSelectedText(selection.toString());
    if (!text) {
      return;
    }

    const language = detectSourceLanguage(text);
    if (!language) {
      return;
    }

    const rect = getUsableRangeRect(range);
    if (!rect) {
      return;
    }

    const selectionKey = `${language}:${text}`;
    if (selectionKey === lastSelectionKey && !ui.panel.hidden) {
      return;
    }
    lastSelectionKey = selectionKey;

    const anchor = {
      x: rect.left,
      below: rect.bottom,
      above: rect.top,
    };
    if (text.length > MAX_TEXT_LENGTH) {
      cancelActiveRequest();
      showErrorPanel({
        anchor,
        title: "划段落翻译",
        badge: language,
        message: `单次最多翻译 ${MAX_TEXT_LENGTH.toLocaleString()} 个字符。`,
      });
      return;
    }

    const contentType = classifyContentType(text);
    startTranslation(
      {
        type: "TRANSLATE_TEXT",
        text,
        sourceLanguage: language,
        contentType,
      },
      {
        anchor,
        title: contentType === "word" ? "划词翻译" : "划段落翻译",
        badge: language,
        waitForCapture: false,
      },
    );
  }

  function normalizeSelectedText(text) {
    return text
      .replaceAll("\u00a0", " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function detectSourceLanguage(text) {
    let kana = 0;
    let cyrillic = 0;
    let latin = 0;
    let han = 0;
    let otherLetters = 0;

    for (const character of text) {
      if (/[\u3040-\u30ff\u31f0-\u31ff\uff66-\uff9d]/u.test(character)) {
        kana += 1;
      } else if (/[\u0400-\u052f]/u.test(character)) {
        cyrillic += 1;
      } else if (/\p{Script=Latin}/u.test(character)) {
        latin += 1;
      } else if (/[\u3400-\u4dbf\u4e00-\u9fff]/u.test(character)) {
        han += 1;
      } else if (/\p{Letter}/u.test(character)) {
        otherLetters += 1;
      }
    }

    const letterCount = kana + cyrillic + latin + han + otherLetters;
    const japaneseShare = letterCount ? (kana + han) / letterCount : 0;
    if (kana > 0 && (kana >= 2 || han <= 8) && japaneseShare >= 0.6) {
      return "日语";
    }
    if (
      cyrillic > 0 &&
      cyrillic >= latin * 0.35 &&
      cyrillic >= han + otherLetters
    ) {
      return "俄语";
    }
    if (latin > 0 && kana === 0 && cyrillic === 0 && han === 0 && otherLetters === 0) {
      return "英语";
    }
    return "";
  }

  function classifyContentType(text) {
    const tokens = text.split(/\s+/u).filter(Boolean);
    const hasSentencePunctuation = /[.!?。！？\n]/u.test(text);
    return tokens.length <= 3 && text.length <= 80 && !hasSentencePunctuation
      ? "word"
      : "paragraph";
  }

  function isEditingText() {
    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLInputElement ||
      activeElement instanceof HTMLTextAreaElement ||
      activeElement?.isContentEditable
    ) {
      return true;
    }

    const selection = window.getSelection();
    const node = selection?.anchorNode;
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    return Boolean(element?.closest?.("[contenteditable=''], [contenteditable='true']"));
  }

  function getUsableRangeRect(range) {
    const boundingRect = range.getBoundingClientRect();
    if (boundingRect.width > 0 || boundingRect.height > 0) {
      return boundingRect;
    }

    return Array.from(range.getClientRects()).find((rect) => rect.width > 0 || rect.height > 0) || null;
  }

  function rememberImageContext(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      lastImageContext = null;
      return;
    }

    const image = target.closest("img");
    if (!image) {
      lastImageContext = null;
      return;
    }

    const rect = image.getBoundingClientRect();
    const clipped = clipRectToViewport(rect);
    if (!clipped) {
      lastImageContext = null;
      return;
    }

    lastImageContext = {
      rect: clipped,
      point: { x: event.clientX, y: event.clientY },
      createdAt: Date.now(),
    };
  }

  function translateRememberedImage() {
    if (
      !lastImageContext ||
      Date.now() - lastImageContext.createdAt > CONTEXT_IMAGE_MAX_AGE_MS
    ) {
      showErrorPanel({
        anchor: centerAnchor(),
        title: "图片翻译",
        badge: "图片",
        message: "没有取得图片区域，请点击扩展图标后使用“框选图片翻译”。",
      });
      return;
    }

    const { rect, point } = lastImageContext;
    const anchor = {
      x: point.x,
      below: Math.min(window.innerHeight, rect.top + rect.height),
      above: rect.top,
    };
    void beginImageTranslation(rect, anchor);
  }

  function startImageSelection() {
    clearTimeout(selectionTimer);
    cancelActiveRequest();
    hidePanel();

    ui.selectionBox.hidden = true;
    ui.overlay.hidden = false;
    ui.overlay.focus({ preventScroll: true });

    let startPoint = null;
    let currentRect = null;

    const cleanup = () => {
      ui.overlay.removeEventListener("pointerdown", onPointerDown);
      ui.overlay.removeEventListener("pointermove", onPointerMove);
      ui.overlay.removeEventListener("pointerup", onPointerUp);
      ui.overlay.removeEventListener("pointercancel", cancelSelection);
      ui.overlay.hidden = true;
      ui.selectionBox.hidden = true;
    };

    const onPointerDown = (event) => {
      if (event.button !== 0) {
        return;
      }
      startPoint = { x: event.clientX, y: event.clientY };
      currentRect = { left: event.clientX, top: event.clientY, width: 0, height: 0 };
      ui.selectionBox.hidden = false;
      updateSelectionBox(currentRect);
      ui.overlay.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event) => {
      if (!startPoint) {
        return;
      }
      currentRect = rectFromPoints(startPoint.x, startPoint.y, event.clientX, event.clientY);
      updateSelectionBox(currentRect);
    };

    const onPointerUp = (event) => {
      if (!startPoint) {
        return;
      }
      currentRect = rectFromPoints(startPoint.x, startPoint.y, event.clientX, event.clientY);
      cleanup();

      if (currentRect.width < 12 || currentRect.height < 12) {
        showErrorPanel({
          anchor: {
            x: event.clientX,
            below: event.clientY,
            above: event.clientY,
          },
          title: "图片翻译",
          badge: "图片",
          message: "框选区域太小，请重新框选。",
        });
        return;
      }

      const anchor = {
        x: currentRect.left,
        below: currentRect.top + currentRect.height,
        above: currentRect.top,
      };
      void beginImageTranslation(currentRect, anchor);
    };

    const cancelSelection = () => {
      cleanup();
    };

    ui.overlay.addEventListener("pointerdown", onPointerDown);
    ui.overlay.addEventListener("pointermove", onPointerMove);
    ui.overlay.addEventListener("pointerup", onPointerUp);
    ui.overlay.addEventListener("pointercancel", cancelSelection);
    ui.cancelImageSelection = cancelSelection;
  }

  async function beginImageTranslation(rect, anchor) {
    cancelActiveRequest();
    hidePanel();
    await afterTwoPaints();

    startTranslation(
      {
        type: "TRANSLATE_IMAGE",
        rect,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
        },
      },
      {
        anchor,
        title: "图片翻译",
        badge: "图片",
        waitForCapture: true,
      },
    );
  }

  function rectFromPoints(startX, startY, endX, endY) {
    const left = Math.max(0, Math.min(startX, endX));
    const top = Math.max(0, Math.min(startY, endY));
    const right = Math.min(window.innerWidth, Math.max(startX, endX));
    const bottom = Math.min(window.innerHeight, Math.max(startY, endY));
    return {
      left,
      top,
      width: Math.max(0, right - left),
      height: Math.max(0, bottom - top),
    };
  }

  function clipRectToViewport(rect) {
    const left = Math.max(0, rect.left);
    const top = Math.max(0, rect.top);
    const right = Math.min(window.innerWidth, rect.right);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    if (right - left < 12 || bottom - top < 12) {
      return null;
    }
    return { left, top, width: right - left, height: bottom - top };
  }

  function updateSelectionBox(rect) {
    ui.selectionBox.style.left = `${rect.left}px`;
    ui.selectionBox.style.top = `${rect.top}px`;
    ui.selectionBox.style.width = `${rect.width}px`;
    ui.selectionBox.style.height = `${rect.height}px`;
  }

  function afterTwoPaints() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  function startTranslation(payload, view) {
    cancelActiveRequest();
    const requestId = crypto.randomUUID();
    const port = chrome.runtime.connect({ name: TRANSLATION_PORT_NAME });
    const request = {
      id: requestId,
      port,
      output: "",
      pendingOutput: "",
      finished: false,
      intentionalDisconnect: false,
      kind: payload.type,
      view,
    };
    activeRequest = request;

    if (!view.waitForCapture) {
      showLoadingPanel(view);
    }

    port.onMessage.addListener((message) => handleTranslationMessage(request, message));
    port.onDisconnect.addListener(() => {
      if (activeRequest !== request || request.finished || request.intentionalDisconnect) {
        return;
      }
      showRequestError(request, "翻译连接意外中断，请重试。", "CONNECTION_CLOSED");
    });

    try {
      port.postMessage({ ...payload, requestId });
    } catch {
      showRequestError(request, "无法连接扩展后台，请重新加载页面后重试。", "CONNECTION_FAILED");
    }
  }

  function handleTranslationMessage(request, message) {
    if (activeRequest !== request || message?.requestId !== request.id) {
      return;
    }

    if (message.type === "ROUTE") {
      const providerLabel = message.providerLabel || "翻译服务";
      const model = typeof message.model === "string" ? message.model : "";
      request.routeFooter = model ? `${providerLabel} · ${model}` : providerLabel;
      ui.footer.textContent = request.routeFooter;
      return;
    }

    if (message.type === "IMAGE_CAPTURED") {
      showLoadingPanel(request.view);
      ui.footer.textContent = request.routeFooter || "硅基流动图片翻译";
      return;
    }

    if (message.type === "DELTA") {
      if (request.view.waitForCapture && ui.panel.hidden) {
        showLoadingPanel(request.view);
        ui.footer.textContent = request.routeFooter || "硅基流动图片翻译";
      }
      request.pendingOutput += typeof message.delta === "string" ? message.delta : "";
      scheduleOutputRender(request);
      return;
    }

    if (message.type === "DONE") {
      flushOutput(request);
      request.finished = true;
      ui.spinner.hidden = true;
      ui.status.textContent = "翻译完成";
      ui.status.classList.add("success");
      if (!request.output.trim()) {
        ui.output.textContent = "模型没有返回译文，请重新翻译。";
      }
      ui.copyButton.disabled = !request.output.trim();
      request.intentionalDisconnect = true;
      request.port.disconnect();
      activeRequest = null;
      return;
    }

    if (message.type === "ERROR") {
      showRequestError(request, message.error || "翻译失败，请重试。", message.code);
    }
  }

  function scheduleOutputRender(request) {
    if (renderTimer) {
      return;
    }
    renderTimer = setTimeout(() => {
      renderTimer = null;
      flushOutput(request);
    }, 36);
  }

  function flushOutput(request) {
    if (!request.pendingOutput || (activeRequest !== request && !request.finished)) {
      return;
    }
    request.output += request.pendingOutput;
    request.pendingOutput = "";
    ui.output.textContent = request.output;
    ui.output.hidden = false;
    ui.copyButton.disabled = !request.output.trim();
    if (visibleAnchor) {
      requestAnimationFrame(() => positionPanel(visibleAnchor));
    }
  }

  function showRequestError(request, message, code) {
    clearTimeout(renderTimer);
    renderTimer = null;
    request.finished = true;
    request.intentionalDisconnect = true;
    try {
      request.port.disconnect();
    } catch {
      // Port may already be disconnected.
    }
    if (activeRequest === request) {
      activeRequest = null;
    }

    showErrorPanel({
      anchor: request.view.anchor,
      title: request.view.title,
      badge: request.view.badge,
      message,
      showSettings:
        code === "API_KEY_MISSING" ||
        code === "TEXT_PROVIDER_KEY_MISSING" ||
        code === "SILICONFLOW_KEY_MISSING" ||
        code === "DEEPSEEK_KEY_MISSING" ||
        code === "HTTP_401" ||
        code === "HTTP_403",
    });
    ui.footer.textContent = request.routeFooter || "翻译服务";
  }

  function cancelActiveRequest() {
    clearTimeout(renderTimer);
    renderTimer = null;
    if (!activeRequest) {
      return;
    }

    activeRequest.intentionalDisconnect = true;
    try {
      activeRequest.port.postMessage({
        type: "CANCEL",
        requestId: activeRequest.id,
      });
      activeRequest.port.disconnect();
    } catch {
      // The service worker may already be gone.
    }
    activeRequest = null;
  }

  function showLoadingPanel(view) {
    visibleAnchor = view.anchor;
    ui.title.textContent = view.title;
    ui.badge.textContent = view.badge;
    ui.output.textContent = "";
    ui.output.hidden = true;
    ui.errorActions.hidden = true;
    ui.settingsButton.hidden = true;
    ui.copyButton.disabled = true;
    ui.copyButton.textContent = "复制";
    ui.footer.textContent = "正在选择翻译服务…";
    ui.spinner.hidden = false;
    ui.status.textContent = view.waitForCapture ? "正在识别并翻译图片…" : "正在翻译…";
    ui.status.classList.remove("success", "error");
    ui.panel.hidden = false;
    positionPanel(view.anchor);
  }

  function showErrorPanel({ anchor, title, badge, message, showSettings = false }) {
    visibleAnchor = anchor;
    ui.title.textContent = title;
    ui.badge.textContent = badge;
    ui.spinner.hidden = true;
    ui.status.textContent = "翻译失败";
    ui.status.classList.remove("success");
    ui.status.classList.add("error");
    ui.output.textContent = message;
    ui.output.hidden = false;
    ui.copyButton.disabled = true;
    ui.copyButton.textContent = "复制";
    ui.footer.textContent = "翻译服务";
    ui.errorActions.hidden = !showSettings;
    ui.settingsButton.hidden = !showSettings;
    ui.panel.hidden = false;
    positionPanel(anchor);
  }

  function positionPanel(anchor) {
    if (ui.panel.hidden) {
      return;
    }

    const margin = 12;
    ui.panel.style.left = `${margin}px`;
    ui.panel.style.top = `${margin}px`;
    const bounds = ui.panel.getBoundingClientRect();
    const maxLeft = Math.max(margin, window.innerWidth - bounds.width - margin);
    const left = Math.min(Math.max(margin, anchor.x), maxLeft);
    let top = anchor.below + 10;

    if (top + bounds.height > window.innerHeight - margin) {
      top = Math.max(margin, anchor.above - bounds.height - 10);
    }
    if (top + bounds.height > window.innerHeight - margin) {
      top = Math.max(margin, window.innerHeight - bounds.height - margin);
    }

    ui.panel.style.left = `${Math.round(left)}px`;
    ui.panel.style.top = `${Math.round(top)}px`;
  }

  function hidePanel() {
    ui.panel.hidden = true;
    visibleAnchor = null;
  }

  function hidePanelWhileScrolling(event) {
    if (
      event.target === ui.output ||
      event.target === ui.host ||
      event.composedPath?.().includes(ui.host)
    ) {
      return;
    }
    if (!ui.panel.hidden) {
      cancelActiveRequest();
      hidePanel();
    }
  }

  function centerAnchor() {
    return {
      x: Math.max(12, window.innerWidth / 2 - 180),
      below: Math.max(12, window.innerHeight / 2),
      above: Math.max(12, window.innerHeight / 2),
    };
  }

  function handleGlobalKeydown(event) {
    if (event.key !== "Escape") {
      return;
    }

    if (!ui.overlay.hidden && ui.cancelImageSelection) {
      ui.cancelImageSelection();
      ui.cancelImageSelection = null;
      return;
    }

    if (!ui.panel.hidden) {
      cancelActiveRequest();
      hidePanel();
    }
  }

  function createTranslatorUi() {
    const host = document.createElement("div");
    host.id = "siliconflow-selection-translator-root";
    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = getUiStyles();

    const panel = createElement("section", "translator-panel");
    panel.hidden = true;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-labelledby", "sf-translator-dialog-title");

    const header = createElement("header", "panel-header");
    const brand = createElement("div", "brand");
    const mark = createElement("span", "brand-mark", "译");
    const title = createElement("strong", "panel-title", "翻译");
    title.id = "sf-translator-dialog-title";
    const badge = createElement("span", "language-badge", "自动");
    brand.append(mark, title, badge);

    const actions = createElement("div", "header-actions");
    const copyButton = createElement("button", "text-button", "复制");
    copyButton.type = "button";
    copyButton.disabled = true;
    copyButton.setAttribute("aria-label", "复制译文");
    const closeButton = createElement("button", "icon-button", "×");
    closeButton.type = "button";
    closeButton.setAttribute("aria-label", "关闭翻译窗口");
    actions.append(copyButton, closeButton);
    header.append(brand, actions);

    const statusRow = createElement("div", "status-row");
    const spinner = createElement("span", "spinner");
    const status = createElement("span", "status-text", "正在翻译…");
    status.setAttribute("aria-live", "polite");
    statusRow.append(spinner, status);

    const output = createElement("div", "translation-output");
    output.hidden = true;

    const errorActions = createElement("div", "error-actions");
    errorActions.hidden = true;
    const settingsButton = createElement("button", "primary-button", "打开扩展设置");
    settingsButton.type = "button";
    errorActions.append(settingsButton);

    const footer = createElement("footer", "panel-footer", "翻译服务");
    panel.append(header, statusRow, output, errorActions, footer);

    const overlay = createElement("div", "capture-overlay");
    overlay.hidden = true;
    overlay.tabIndex = -1;
    const overlayHint = createElement(
      "div",
      "capture-hint",
      "拖动框选要翻译的图片区域 · 按 Esc 取消",
    );
    const selectionBox = createElement("div", "capture-box");
    selectionBox.hidden = true;
    overlay.append(overlayHint, selectionBox);

    shadow.append(style, panel, overlay);
    (document.documentElement || document.body).append(host);

    closeButton.addEventListener("click", () => {
      cancelActiveRequest();
      hidePanel();
    });
    copyButton.addEventListener("click", () => void copyTranslation(copyButton, output));
    settingsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());

    return {
      host,
      shadow,
      panel,
      title,
      badge,
      copyButton,
      spinner,
      status,
      output,
      errorActions,
      settingsButton,
      footer,
      overlay,
      selectionBox,
      cancelImageSelection: null,
    };
  }

  function createElement(tagName, className, text = "") {
    const element = document.createElement(tagName);
    element.className = className;
    if (text) {
      element.textContent = text;
    }
    return element;
  }

  async function copyTranslation(button, output) {
    const text = output.textContent?.trim();
    if (!text) {
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      (document.body || document.documentElement).append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    button.textContent = "已复制";
    setTimeout(() => {
      button.textContent = "复制";
    }, 1_200);
  }

  function getUiStyles() {
    return `
      :host {
        all: initial;
        color-scheme: light;
      }
      [hidden] {
        display: none !important;
      }
      .translator-panel,
      .translator-panel * {
        box-sizing: border-box;
      }
      .translator-panel {
        position: fixed;
        z-index: 2147483647;
        width: min(390px, calc(100vw - 24px));
        max-height: min(520px, calc(100vh - 24px));
        overflow: hidden;
        color: #18212f;
        background: rgba(255, 255, 255, 0.985);
        border: 1px solid rgba(60, 74, 94, 0.15);
        border-radius: 16px;
        box-shadow: 0 18px 55px rgba(18, 29, 46, 0.22), 0 3px 10px rgba(18, 29, 46, 0.1);
        font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        text-align: left;
      }
      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        min-height: 54px;
        padding: 10px 12px 10px 14px;
        border-bottom: 1px solid #edf0f4;
      }
      .brand,
      .header-actions,
      .status-row,
      .error-actions {
        display: flex;
        align-items: center;
      }
      .brand {
        min-width: 0;
        gap: 8px;
      }
      .brand-mark {
        display: inline-grid;
        flex: 0 0 auto;
        width: 28px;
        height: 28px;
        place-items: center;
        color: #ffffff;
        background: linear-gradient(145deg, #635bff, #3484ff);
        border-radius: 9px;
        font-size: 14px;
        font-weight: 800;
      }
      .panel-title {
        overflow: hidden;
        max-width: 130px;
        color: #172033;
        font-size: 14px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .language-badge {
        padding: 2px 7px;
        color: #4f5b70;
        background: #f0f3f8;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 600;
      }
      .header-actions {
        gap: 4px;
      }
      button {
        appearance: none;
        border: 0;
        font: inherit;
        cursor: pointer;
      }
      button:focus-visible {
        outline: 2px solid #5f65f6;
        outline-offset: 2px;
      }
      button:disabled {
        cursor: default;
        opacity: 0.42;
      }
      .text-button,
      .icon-button {
        color: #596579;
        background: transparent;
        border-radius: 8px;
      }
      .text-button {
        padding: 6px 8px;
        font-size: 12px;
      }
      .icon-button {
        width: 30px;
        height: 30px;
        font-size: 20px;
        line-height: 28px;
      }
      .text-button:not(:disabled):hover,
      .icon-button:hover {
        color: #263247;
        background: #f1f3f7;
      }
      .status-row {
        gap: 8px;
        padding: 12px 16px 4px;
        color: #68758a;
        font-size: 12px;
      }
      .status-text.success {
        color: #16845b;
      }
      .status-text.error {
        color: #c43c4d;
      }
      .spinner {
        width: 13px;
        height: 13px;
        border: 2px solid #d9def0;
        border-top-color: #5c63ef;
        border-radius: 50%;
        animation: sf-spin 0.8s linear infinite;
      }
      @keyframes sf-spin {
        to { transform: rotate(360deg); }
      }
      .translation-output {
        max-height: 350px;
        overflow: auto;
        padding: 10px 16px 14px;
        color: #1c2636;
        font-size: 14px;
        line-height: 1.7;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
        user-select: text;
      }
      .error-actions {
        padding: 0 16px 14px;
      }
      .primary-button {
        padding: 8px 12px;
        color: #ffffff;
        background: #5963e9;
        border-radius: 9px;
        font-size: 12px;
        font-weight: 650;
      }
      .primary-button:hover {
        background: #4852d7;
      }
      .panel-footer {
        padding: 8px 16px;
        color: #626d7e;
        background: #fafbfc;
        border-top: 1px solid #f0f2f5;
        font-size: 10px;
        text-align: right;
      }
      .capture-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        cursor: crosshair;
        background: rgba(12, 18, 30, 0.22);
        user-select: none;
        touch-action: none;
      }
      .capture-hint {
        position: fixed;
        top: 20px;
        left: 50%;
        padding: 9px 14px;
        color: #ffffff;
        background: rgba(17, 24, 39, 0.92);
        border-radius: 10px;
        box-shadow: 0 7px 24px rgba(0, 0, 0, 0.23);
        font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
        transform: translateX(-50%);
        white-space: nowrap;
      }
      .capture-box {
        position: fixed;
        border: 2px solid #6c72ff;
        background: rgba(255, 255, 255, 0.12);
        box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.75), inset 0 0 0 9999px rgba(255, 255, 255, 0.03);
      }
    `;
  }
})();
