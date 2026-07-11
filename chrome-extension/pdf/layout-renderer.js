export const MAX_CANVAS_PIXELS = 5_500_000;
export const MAX_CANVAS_EDGE = 2_560;
export const DEFAULT_CANVAS_MEMORY_BUDGET = 256 * 1024 * 1024;
export const DEFAULT_MAX_CACHED_PAGES = 8;

const BYTES_PER_CANVAS_PIXEL = 4;
const DEFAULT_ROOT_MARGIN = "900px 0px";

/**
 * Returns a scale that keeps a PDF.js viewport inside the hard canvas limits.
 * The viewport must describe the page at scale 1.
 */
export function calculateRenderScale(viewport, requestedScale = 1, limits = {}) {
  if (requestedScale && typeof requestedScale === "object") {
    limits = requestedScale;
    requestedScale = 1;
  }

  const width = Math.abs(Number(viewport?.width));
  const height = Math.abs(Number(viewport?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new TypeError("viewport 必须包含有效的 width 和 height");
  }

  const desiredScale = positiveNumber(requestedScale, 1);
  const maxPixels = cappedLimit(limits.maxPixels, MAX_CANVAS_PIXELS);
  const maxEdge = cappedLimit(limits.maxEdge, MAX_CANVAS_EDGE);
  const pixelScale = Math.sqrt(maxPixels / (width * height));
  const edgeScale = maxEdge / Math.max(width, height);

  return Math.max(Number.EPSILON, Math.min(desiredScale, pixelScale, edgeScale));
}

/**
 * Builds a constrained PDF.js viewport and its exact canvas allocation data.
 */
export function getConstrainedViewport(pdfPage, requestedScale = 1, limits = {}) {
  if (!pdfPage || typeof pdfPage.getViewport !== "function") {
    throw new TypeError("pdfPage 必须提供 getViewport() 方法");
  }

  const maxPixels = cappedLimit(limits.maxPixels, MAX_CANVAS_PIXELS);
  const maxEdge = cappedLimit(limits.maxEdge, MAX_CANVAS_EDGE);
  const baseViewport = pdfPage.getViewport({ scale: 1 });
  const scale = calculateRenderScale(baseViewport, requestedScale, { maxPixels, maxEdge });
  const viewport = pdfPage.getViewport({ scale });
  let width = Math.max(1, Math.min(maxEdge, Math.floor(Math.abs(viewport.width))));
  let height = Math.max(1, Math.min(maxEdge, Math.floor(Math.abs(viewport.height))));

  // Floating point rounding must never push the actual allocation over budget.
  if (width * height > maxPixels) {
    const correction = Math.sqrt(maxPixels / (width * height));
    width = Math.max(1, Math.floor(width * correction));
    height = Math.max(1, Math.floor(height * correction));
  }

  return {
    viewport,
    scale,
    width,
    height,
    estimatedBytes: width * height * BYTES_PER_CANVAS_PIXEL,
  };
}

/**
 * Lazily renders registered PDF pages and evicts hidden canvases in LRU order.
 */
export class LazyPageCanvasRenderer {
  constructor({
    pdfDocument,
    root = null,
    rootMargin = DEFAULT_ROOT_MARGIN,
    threshold = 0.01,
    requestedScale = 1.5,
    maxPixels = MAX_CANVAS_PIXELS,
    maxEdge = MAX_CANVAS_EDGE,
    memoryBudgetBytes = DEFAULT_CANVAS_MEMORY_BUDGET,
    maxCachedPages = DEFAULT_MAX_CACHED_PAGES,
    IntersectionObserver: Observer = globalThis.IntersectionObserver,
    onRendered = null,
    onError = null,
  } = {}) {
    if (!pdfDocument || typeof pdfDocument.getPage !== "function") {
      throw new TypeError("pdfDocument 必须提供 getPage() 方法");
    }

    this.pdfDocument = pdfDocument;
    this.requestedScale = positiveNumber(requestedScale, 1.5);
    this.maxPixels = cappedLimit(maxPixels, MAX_CANVAS_PIXELS);
    this.maxEdge = cappedLimit(maxEdge, MAX_CANVAS_EDGE);
    this.memoryBudgetBytes = cappedLimit(memoryBudgetBytes, DEFAULT_CANVAS_MEMORY_BUDGET);
    this.maxCachedPages = Math.max(1, Math.floor(positiveNumber(maxCachedPages, DEFAULT_MAX_CACHED_PAGES)));
    this.onRendered = typeof onRendered === "function" ? onRendered : null;
    this.onError = typeof onError === "function" ? onError : null;
    this.entries = new Map();
    this.canvasBytes = 0;
    this.destroyed = false;

    this.observer = typeof Observer === "function"
      ? new Observer((records) => this.handleIntersections(records), { root, rootMargin, threshold })
      : null;
  }

  /**
   * Registers one canvas. The object form is preferred; a positional form is
   * accepted for small integrations: registerPage(pageNumber, canvas, options).
   */
  registerPage(pageOrOptions, canvas, options = {}) {
    const config = typeof pageOrOptions === "object" && pageOrOptions !== null
      ? pageOrOptions
      : { ...options, pageNumber: pageOrOptions, canvas };
    const pageNumber = Number(config.pageNumber);
    const pageCanvas = config.canvas;
    const target = config.container || pageCanvas;

    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      throw new TypeError("pageNumber 必须是从 1 开始的整数");
    }
    if (!pageCanvas || typeof pageCanvas.getContext !== "function") {
      throw new TypeError("canvas 必须是有效的画布元素");
    }
    if (!target) {
      throw new TypeError("缺少用于观察的页面容器");
    }

    this.unregisterPage(pageNumber);
    const entry = {
      pageNumber,
      canvas: pageCanvas,
      target,
      requestedScale: positiveNumber(config.requestedScale, this.requestedScale),
      visible: false,
      state: "idle",
      lastUsedAt: 0,
      estimatedBytes: 0,
      renderTask: null,
      renderPromise: null,
      generation: 0,
      onRendered: typeof config.onRendered === "function" ? config.onRendered : null,
      onError: typeof config.onError === "function" ? config.onError : null,
    };

    this.entries.set(pageNumber, entry);
    if (this.observer) {
      this.observer.observe(target);
    } else {
      entry.visible = true;
      void this.renderPage(pageNumber);
    }

    return () => this.unregisterPage(pageNumber);
  }

  observePage(config) {
    return this.registerPage(config);
  }

  async renderPage(pageNumber, { force = false } = {}) {
    const entry = this.entries.get(Number(pageNumber));
    if (!entry || this.destroyed) {
      return false;
    }
    if (entry.state === "rendering" && entry.renderPromise) {
      return entry.renderPromise;
    }
    if (entry.state === "rendered" && !force) {
      this.touch(entry);
      return true;
    }
    if (force) {
      this.releaseEntry(entry);
    }

    const generation = ++entry.generation;
    entry.state = "rendering";
    entry.target.classList?.add("is-rendering");
    entry.canvas.setAttribute?.("aria-busy", "true");

    entry.renderPromise = (async () => {
      try {
        const pdfPage = await this.pdfDocument.getPage(entry.pageNumber);
        if (!this.isCurrent(entry, generation)) {
          return false;
        }

        const layout = getConstrainedViewport(pdfPage, entry.requestedScale, {
          maxPixels: this.maxPixels,
          maxEdge: this.maxEdge,
        });
        const context = entry.canvas.getContext("2d", { alpha: false });
        if (!context) {
          throw new Error("无法创建 PDF 页面画布上下文");
        }

        entry.canvas.width = layout.width;
        entry.canvas.height = layout.height;
        entry.canvas.dataset.renderScale = String(layout.scale);
        entry.canvas.dataset.pageNumber = String(entry.pageNumber);
        entry.renderTask = pdfPage.render({ canvasContext: context, viewport: layout.viewport });
        await entry.renderTask.promise;

        if (!this.isCurrent(entry, generation)) {
          return false;
        }

        this.canvasBytes -= entry.estimatedBytes;
        entry.estimatedBytes = layout.estimatedBytes;
        this.canvasBytes += entry.estimatedBytes;
        entry.state = "rendered";
        this.touch(entry);
        entry.canvas.dataset.rendered = "true";
        const detail = {
          pageNumber: entry.pageNumber,
          canvas: entry.canvas,
          viewport: layout.viewport,
          scale: layout.scale,
          width: layout.width,
          height: layout.height,
        };
        entry.onRendered?.(detail);
        this.onRendered?.(detail);
        this.enforceCacheBudget();
        return true;
      } catch (error) {
        if (!this.isCurrent(entry, generation) || isRenderingCancelled(error)) {
          return false;
        }
        entry.state = "error";
        entry.onError?.(error, entry.pageNumber);
        this.onError?.(error, entry.pageNumber);
        return false;
      } finally {
        if (this.isCurrent(entry, generation)) {
          entry.renderTask = null;
          entry.renderPromise = null;
          entry.target.classList?.remove("is-rendering");
          entry.canvas.removeAttribute?.("aria-busy");
        }
      }
    })();

    return entry.renderPromise;
  }

  handleIntersections(records) {
    for (const record of records || []) {
      const entry = this.findEntryByTarget(record.target);
      if (!entry) {
        continue;
      }

      entry.visible = Boolean(record.isIntersecting || record.intersectionRatio > 0);
      if (entry.visible) {
        this.touch(entry);
        void this.renderPage(entry.pageNumber);
      }
    }
    this.enforceCacheBudget();
  }

  markVisible(pageNumber, visible = true) {
    const entry = this.entries.get(Number(pageNumber));
    if (!entry) {
      return false;
    }
    entry.visible = Boolean(visible);
    if (entry.visible) {
      this.touch(entry);
      void this.renderPage(entry.pageNumber);
    } else {
      this.enforceCacheBudget();
    }
    return true;
  }

  releasePage(pageNumber) {
    const entry = this.entries.get(Number(pageNumber));
    if (!entry) {
      return false;
    }
    this.releaseEntry(entry);
    return true;
  }

  releaseHiddenPages({ keepRecent = 0 } = {}) {
    const hiddenEntries = Array.from(this.entries.values())
      .filter((entry) => !entry.visible && entry.state === "rendered")
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
    const keepCount = Math.max(0, Math.floor(Number(keepRecent) || 0));
    for (const entry of hiddenEntries.slice(keepCount)) {
      this.releaseEntry(entry);
    }
    return Math.max(0, hiddenEntries.length - keepCount);
  }

  unregisterPage(pageNumber) {
    const entry = this.entries.get(Number(pageNumber));
    if (!entry) {
      return false;
    }
    this.observer?.unobserve(entry.target);
    this.releaseEntry(entry);
    this.entries.delete(entry.pageNumber);
    return true;
  }

  destroy() {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.observer?.disconnect();
    for (const entry of this.entries.values()) {
      this.releaseEntry(entry);
    }
    this.entries.clear();
    this.canvasBytes = 0;
  }

  enforceCacheBudget() {
    const renderedEntries = Array.from(this.entries.values()).filter((entry) => entry.state === "rendered");
    const hiddenLru = renderedEntries
      .filter((entry) => !entry.visible)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt);
    let cachedCount = renderedEntries.length;

    while (
      hiddenLru.length > 0
      && (this.canvasBytes > this.memoryBudgetBytes || cachedCount > this.maxCachedPages)
    ) {
      this.releaseEntry(hiddenLru.shift());
      cachedCount -= 1;
    }
  }

  releaseEntry(entry) {
    entry.generation += 1;
    if (entry.renderTask && typeof entry.renderTask.cancel === "function") {
      try {
        entry.renderTask.cancel();
      } catch {
        // A completed PDF.js task may reject a redundant cancellation.
      }
    }
    this.canvasBytes = Math.max(0, this.canvasBytes - entry.estimatedBytes);
    entry.estimatedBytes = 0;
    entry.renderTask = null;
    entry.renderPromise = null;
    entry.state = "idle";
    entry.target.classList?.remove("is-rendering");
    entry.canvas.removeAttribute?.("aria-busy");
    if (entry.canvas.dataset) {
      delete entry.canvas.dataset.rendered;
      delete entry.canvas.dataset.renderScale;
    }

    // Setting both dimensions to zero releases the backing store immediately.
    entry.canvas.width = 0;
    entry.canvas.height = 0;
  }

  findEntryByTarget(target) {
    for (const entry of this.entries.values()) {
      if (entry.target === target) {
        return entry;
      }
    }
    return null;
  }

  isCurrent(entry, generation) {
    return !this.destroyed && this.entries.get(entry.pageNumber) === entry && entry.generation === generation;
  }

  touch(entry) {
    entry.lastUsedAt = monotonicNow();
  }
}

/**
 * Converts a model bbox to a safe normalized [x, y, width, height] tuple.
 * Invalid or overflowing boxes are discarded instead of being placed.
 */
export function normalizeBbox(value) {
  const tuple = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? [value.x, value.y, value.width, value.height]
      : null;
  if (!tuple || tuple.length !== 4) {
    return null;
  }

  const numbers = tuple.map(Number);
  if (numbers.some((number) => !Number.isFinite(number))) {
    return null;
  }
  const [x, y, width, height] = numbers;
  if (
    x < 0
    || y < 0
    || width <= 0
    || height <= 0
    || x > 1_000
    || y > 1_000
    || width > 1_000
    || height > 1_000
    || x + width > 1_000
    || y + height > 1_000
  ) {
    return null;
  }
  return numbers;
}

export const normaliseBbox = normalizeBbox;

export function applyNormalizedBbox(element, bbox) {
  const normalized = normalizeBbox(bbox);
  if (!normalized || !element?.style) {
    return false;
  }
  const [x, y, width, height] = normalized;
  element.style.left = `${formatPercent(x / 10)}%`;
  element.style.top = `${formatPercent(y / 10)}%`;
  element.style.width = `${formatPercent(width / 10)}%`;
  element.style.height = `${formatPercent(height / 10)}%`;
  return true;
}

/** Creates one original-page block without parsing model data as markup. */
export function createTextBlock(block = {}, options = {}) {
  const documentObject = requireDocument(options.document);
  const element = documentObject.createElement("button");
  const sourceText = stringValue(block.source ?? block.text);
  const blockId = stringValue(block.id ?? block.blockId);
  element.type = "button";
  element.className = options.className || "source-block";
  element.dataset.blockId = blockId;
  element.textContent = sourceText;
  element.setAttribute("aria-label", sourceText || `原文区域 ${blockId}`);
  applyNormalizedBbox(element, block.bbox);
  return element;
}

export const createSourceBlock = createTextBlock;

/** Creates one bilingual translation card using textContent exclusively. */
export function createTranslationBlock(block = {}, options = {}) {
  const documentObject = requireDocument(options.document);
  const article = documentObject.createElement("article");
  const source = documentObject.createElement("p");
  const target = documentObject.createElement("p");
  const sourceText = stringValue(block.source ?? block.text);
  const targetText = stringValue(block.target ?? block.translation ?? block.translatedText);
  article.className = options.className || "translation-block";
  article.dataset.blockId = stringValue(block.id ?? block.blockId);
  article.tabIndex = 0;
  source.className = "translation-source-text";
  source.textContent = sourceText;
  target.className = "translation-target-text";
  target.textContent = targetText || options.pendingText || "等待译文…";
  if (!targetText) {
    target.classList.add("is-pending");
  }
  article.append(source, target);
  return article;
}

/**
 * Renders page blocks into the supplied containers and wires source/translation
 * hover highlighting. No block field is interpreted as HTML.
 */
export function renderPageBlocks({
  sourceContainer,
  translationContainer,
  blocks = [],
  document: documentOption,
  pendingText = "等待译文…",
  continuousTranslation = false,
} = {}) {
  if (!sourceContainer || !translationContainer) {
    throw new TypeError("需要 sourceContainer 和 translationContainer");
  }
  const documentObject = requireDocument(documentOption || sourceContainer.ownerDocument);
  const sourceFragment = documentObject.createDocumentFragment();
  const translationFragment = documentObject.createDocumentFragment();
  const sourceBlocks = [];
  const translationBlocks = [];

  const normalizedBlocks = Array.isArray(blocks) ? blocks : [];
  for (const block of normalizedBlocks) {
    if (normalizeBbox(block?.bbox)) {
      const sourceElement = createTextBlock(block, { document: documentObject });
      sourceBlocks.push(sourceElement);
      sourceFragment.append(sourceElement);
    }
    if (!continuousTranslation) {
      const translationElement = createTranslationBlock(block, { document: documentObject, pendingText });
      translationBlocks.push(translationElement);
      translationFragment.append(translationElement);
    }
  }

  if (continuousTranslation) {
    const article = documentObject.createElement("article");
    const target = documentObject.createElement("p");
    const translatedParts = normalizedBlocks
      .map((block) => stringValue(block.target ?? block.translation ?? block.translatedText).trim())
      .filter(Boolean);
    article.className = "translation-page";
    target.className = "translation-page-text";
    target.textContent = translatedParts.join("\n\n") || pendingText;
    target.classList.toggle("is-pending", translatedParts.length === 0);
    article.append(target);
    translationBlocks.push(article);
    translationFragment.append(article);
  }

  sourceContainer.replaceChildren(sourceFragment);
  translationContainer.replaceChildren(translationFragment);
  const unlink = linkHoverHighlights(sourceContainer, translationContainer);
  return { sourceBlocks, translationBlocks, destroy: unlink };
}

export const renderTextBlocks = renderPageBlocks;

/**
 * Links blocks by exact dataset value. It never interpolates a model-provided ID
 * into a CSS selector, so unusual IDs cannot alter selector semantics.
 */
export function linkHoverHighlights(sourceRoot, translationRoot, {
  activeClass = "is-linked-highlight",
  scrollOnClick = true,
} = {}) {
  if (!sourceRoot || !translationRoot) {
    return () => {};
  }

  const sourceElements = Array.from(sourceRoot.querySelectorAll("[data-block-id]"));
  const translationElements = Array.from(translationRoot.querySelectorAll("[data-block-id]"));
  const groups = new Map();
  const listeners = [];

  for (const element of [...sourceElements, ...translationElements]) {
    const blockId = element.dataset.blockId;
    if (!groups.has(blockId)) {
      groups.set(blockId, new Set());
    }
    groups.get(blockId).add(element);
  }

  const setActive = (blockId, active) => {
    for (const linkedElement of groups.get(blockId) || []) {
      linkedElement.classList.toggle(activeClass, active);
    }
  };

  const attach = (element, eventName, handler) => {
    element.addEventListener(eventName, handler);
    listeners.push(() => element.removeEventListener(eventName, handler));
  };

  for (const element of [...sourceElements, ...translationElements]) {
    const blockId = element.dataset.blockId;
    attach(element, "mouseenter", () => setActive(blockId, true));
    attach(element, "mouseleave", () => setActive(blockId, false));
    attach(element, "focus", () => setActive(blockId, true));
    attach(element, "blur", () => setActive(blockId, false));
  }

  if (scrollOnClick) {
    for (const sourceElement of sourceElements) {
      const blockId = sourceElement.dataset.blockId;
      attach(sourceElement, "click", () => {
        const target = translationElements.find((element) => element.dataset.blockId === blockId);
        target?.scrollIntoView?.({ behavior: "smooth", block: "center" });
        target?.focus?.({ preventScroll: true });
      });
    }
  }

  return () => {
    for (const removeListener of listeners) {
      removeListener();
    }
    for (const elements of groups.values()) {
      for (const element of elements) {
        element.classList.remove(activeClass);
      }
    }
  };
}

function cappedLimit(value, hardLimit) {
  return Math.max(1, Math.min(positiveNumber(value, hardLimit), hardLimit));
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function monotonicNow() {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : Date.now();
}

function isRenderingCancelled(error) {
  return error?.name === "RenderingCancelledException" || error?.name === "AbortError";
}

function requireDocument(documentObject) {
  const resolved = documentObject || globalThis.document;
  if (!resolved || typeof resolved.createElement !== "function") {
    throw new TypeError("当前环境没有可用的 document");
  }
  return resolved;
}

function stringValue(value) {
  return value == null ? "" : String(value);
}

function formatPercent(value) {
  return Number(value.toFixed(4)).toString();
}
