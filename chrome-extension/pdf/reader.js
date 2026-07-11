import { analyzePdfDocument, buildTextBatches } from "./pdf-analyzer.js";
import { downloadBilingualHtml, printBilingualDocument } from "./export.js";
import { LazyPageCanvasRenderer, renderPageBlocks } from "./layout-renderer.js";
import { PdfJobClient } from "./pdf-job-client.js";

const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PAGE_COUNT = 500;
const MAX_PAGE_DIMENSION = 20_000;
const TEXT_CONCURRENCY = 10;
const KEEPALIVE_INTERVAL_MS = 25_000;
const RECONNECT_DELAYS_MS = [400, 1_200, 3_000];

const dropZone = document.querySelector("#dropZone");
const pdfFileInput = document.querySelector("#pdfFileInput");
const fileSummary = document.querySelector("#fileSummary");
const fileName = document.querySelector("#fileName");
const fileMeta = document.querySelector("#fileMeta");
const changeFileButton = document.querySelector("#changeFileButton");
const passwordPanel = document.querySelector("#passwordPanel");
const passwordForm = document.querySelector("#passwordForm");
const pdfPassword = document.querySelector("#pdfPassword");
const unlockPdfButton = document.querySelector("#unlockPdfButton");
const passwordFeedback = document.querySelector("#passwordFeedback");
const analysisPanel = document.querySelector("#analysisPanel");
const analysisStatus = document.querySelector("#analysisStatus");
const analysisSpinner = document.querySelector("#analysisSpinner");
const pageCount = document.querySelector("#pageCount");
const textPageCount = document.querySelector("#textPageCount");
const scanPageCount = document.querySelector("#scanPageCount");
const mixedPageCount = document.querySelector("#mixedPageCount");
const textBlockCount = document.querySelector("#textBlockCount");
const providerSummary = document.querySelector("#providerSummary");
const privacyConfirm = document.querySelector("#privacyConfirm");
const startTranslationButton = document.querySelector("#startTranslationButton");
const workspacePanel = document.querySelector("#workspacePanel");
const documentStatus = document.querySelector("#documentStatus");
const overallProgress = document.querySelector("#overallProgress");
const overallProgressText = document.querySelector("#overallProgressText");
const completedPageCount = document.querySelector("#completedPageCount");
const totalPageCount = document.querySelector("#totalPageCount");
const pauseTranslationButton = document.querySelector("#pauseTranslationButton");
const resumeTranslationButton = document.querySelector("#resumeTranslationButton");
const cancelTranslationButton = document.querySelector("#cancelTranslationButton");
const originalViewButton = document.querySelector("#originalViewButton");
const translatedViewButton = document.querySelector("#translatedViewButton");
const bilingualViewButton = document.querySelector("#bilingualViewButton");
const pagesContainer = document.querySelector("#pagesContainer");
const pagesEmptyState = document.querySelector("#pagesEmptyState");
const pageTemplate = document.querySelector("#pageTemplate");
const exportHtmlButton = document.querySelector("#exportHtmlButton");
const printButton = document.querySelector("#printButton");
const settingsButton = document.querySelector("#settingsButton");

const state = {
  generation: 0,
  phase: "idle",
  file: null,
  fingerprint: "",
  loadingTask: null,
  pendingPasswordUpdate: null,
  pdfDocument: null,
  pages: [],
  batches: [],
  batchByAttemptId: new Map(),
  activeBatchIds: new Set(),
  translations: new Map(),
  partialTranslations: new Map(),
  pendingStreamPageNumbers: new Set(),
  streamRenderFrame: null,
  pageCards: new Map(),
  blockRenderCleanup: new Map(),
  canvasRenderer: null,
  settings: null,
  jobClient: null,
  jobId: "",
  keepAliveTimer: null,
  reconnecting: false,
  reconnectToken: null,
  disposed: false,
};

configurePdfJs();
bindUiEvents();
void refreshPdfSettings();

function configurePdfJs() {
  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib?.getDocument || !pdfjsLib?.GlobalWorkerOptions) {
    setDocumentStatus("PDF.js 加载失败，请重新加载扩展。", "error");
    return;
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
    "vendor/pdfjs/pdf.worker.js",
  );
}

function bindUiEvents() {
  for (const eventName of ["dragenter", "dragover"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      if (!isBusy()) {
        dropZone.classList.add("is-dragging");
      }
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("is-dragging");
    });
  }
  dropZone.addEventListener("drop", (event) => {
    if (!isBusy()) {
      const [file] = event.dataTransfer?.files || [];
      if (file) void openPdfFile(file);
    }
  });
  dropZone.addEventListener("keydown", (event) => {
    if ((event.key === "Enter" || event.key === " ") && !isBusy()) {
      event.preventDefault();
      pdfFileInput.click();
    }
  });
  pdfFileInput.addEventListener("change", () => {
    const [file] = pdfFileInput.files || [];
    if (file) void openPdfFile(file);
  });
  changeFileButton.addEventListener("click", async () => {
    const resetPromise = resetDocument();
    const generation = state.generation;
    await resetPromise;
    if (generation === state.generation && state.phase === "idle" && !state.disposed) {
      pdfFileInput.click();
    }
  });
  passwordForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitPdfPassword();
  });
  privacyConfirm.addEventListener("change", updateStartButton);
  startTranslationButton.addEventListener("click", () => void startTranslation());
  pauseTranslationButton.addEventListener("click", pauseTranslation);
  resumeTranslationButton.addEventListener("click", resumeTranslation);
  cancelTranslationButton.addEventListener("click", cancelTranslation);
  settingsButton.addEventListener("click", () => void chrome.runtime.openOptionsPage());
  exportHtmlButton.addEventListener("click", exportHtml);
  printButton.addEventListener("click", printDocument);
  for (const button of [originalViewButton, translatedViewButton, bilingualViewButton]) {
    button.addEventListener("click", () => setReadingView(button.dataset.view));
  }
  window.addEventListener("resize", syncAllOverlaySizes);
  window.addEventListener("focus", () => void refreshPdfSettings());
  window.addEventListener("beforeunload", dispose);
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "PDF_PUBLIC_SETTINGS_CHANGED") {
      void refreshPdfSettings();
    }
  });
}

async function refreshPdfSettings() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: "GET_PDF_SETTINGS" });
    if (!settings?.ok) {
      throw new Error(settings?.error || "读取翻译设置失败。");
    }
    state.settings = settings;
  } catch {
    state.settings = {
      ok: false,
      hasTextProvider: false,
      providerLabel: "未配置",
      textModel: "—",
    };
  }
  updateAnalysisSummary();
  updateStartButton();
  return state.settings;
}

async function openPdfFile(file) {
  const generation = state.generation + 1;
  state.generation = generation;
  await resetDocument({ preserveGeneration: true });
  if (generation !== state.generation || state.disposed) return;
  state.file = file;
  state.phase = "analyzing";
  pdfFileInput.value = "";

  fileName.textContent = file.name || "未命名 PDF";
  fileMeta.textContent = formatFileSize(file.size);
  fileSummary.hidden = false;
  analysisPanel.hidden = false;
  analysisSpinner.hidden = false;
  analysisStatus.textContent = "正在检查文件…";
  setDocumentStatus("正在读取本地 PDF…", "working");
  setImportEnabled(false);

  try {
    validatePdfFile(file);
    const buffer = await file.arrayBuffer();
    assertCurrentGeneration(generation);
    const bytes = new Uint8Array(buffer);
    if (!hasPdfSignature(bytes)) {
      throw createReaderError("所选文件不是有效的 PDF。", "INVALID_PDF_SIGNATURE");
    }

    state.fingerprint = await sha256Hex(bytes);
    assertCurrentGeneration(generation);
    const pdfDocument = await loadPdfDocument(bytes, generation);
    assertCurrentGeneration(generation);
    validatePdfDocument(pdfDocument);
    state.pdfDocument = pdfDocument;
    state.loadingTask = null;
    clearPasswordPrompt();
    fileMeta.textContent = `${formatFileSize(file.size)} · ${pdfDocument.numPages} 页`;

    analysisStatus.textContent = `正在分析第 1 / ${pdfDocument.numPages} 页…`;
    const pages = await analyzePdfDocument(pdfDocument, {
      async onProgress(progress) {
        assertCurrentGeneration(generation);
        validateAnalyzedPage(progress.page);
        analysisStatus.textContent =
          `正在分析第 ${progress.completedPages} / ${progress.totalPages} 页…`;
        await yieldToUi();
      },
    });
    assertCurrentGeneration(generation);

    const lightweightPages = pages.map(createLightweightPage);
    state.pages = lightweightPages;
    state.batches = buildTextBatches(lightweightPages).map((batch) => ({
      ...batch,
      state: "pending",
      attempt: 0,
      attemptId: "",
      error: "",
      errorCode: "",
      retryable: false,
    }));
    analysisSpinner.hidden = true;
    analysisStatus.textContent = createAnalysisStatus(lightweightPages);
    setDocumentStatus("PDF 分析完成", "ready");
    state.phase = "ready";
    setImportEnabled(true);
    await refreshPdfSettings();
    if (generation !== state.generation || state.phase !== "ready" || state.disposed) return;
    renderWorkspace();
    updateAnalysisSummary();
    updateStartButton();
  } catch (error) {
    if (generation !== state.generation || state.disposed) {
      return;
    }
    analysisSpinner.hidden = true;
    state.phase = "error";
    analysisStatus.textContent = toReaderMessage(error);
    setDocumentStatus(toReaderMessage(error), "error");
    setImportEnabled(true);
  }
}

function validatePdfFile(file) {
  if (!(typeof globalThis.File === "function" && file instanceof globalThis.File) && typeof file?.arrayBuffer !== "function") {
    throw createReaderError("没有收到可读取的文件。", "INVALID_FILE");
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    throw createReaderError("PDF 文件为空。", "EMPTY_FILE");
  }
  if (file.size > MAX_FILE_BYTES) {
    throw createReaderError("单个 PDF 不能超过 200 MiB。", "FILE_TOO_LARGE");
  }
  const fileType = String(file.type || "").toLowerCase();
  const fileNameValue = String(file.name || "");
  if (fileType && fileType !== "application/pdf" && !fileNameValue.toLowerCase().endsWith(".pdf")) {
    throw createReaderError("请选择 PDF 文件。", "INVALID_FILE_TYPE");
  }
}

function hasPdfSignature(bytes) {
  const prefix = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(1_024, bytes.length)));
  return prefix.includes("%PDF-");
}

async function sha256Hex(bytes) {
  if (!globalThis.crypto?.subtle) {
    throw createReaderError("当前浏览器无法计算文件指纹。", "CRYPTO_UNAVAILABLE");
  }
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

async function loadPdfDocument(bytes, generation) {
  const pdfjsLib = globalThis.pdfjsLib;
  if (!pdfjsLib?.getDocument) {
    throw createReaderError("PDF.js 未正确加载。", "PDFJS_UNAVAILABLE");
  }
  const loadingTask = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: chrome.runtime.getURL("vendor/pdfjs/cmaps/"),
    cMapPacked: true,
    standardFontDataUrl: chrome.runtime.getURL("vendor/pdfjs/standard_fonts/"),
    isEvalSupported: false,
    useSystemFonts: true,
    stopAtErrors: false,
  });
  state.loadingTask = loadingTask;
  loadingTask.onPassword = (updatePassword, reason) => {
    if (generation !== state.generation) {
      void loadingTask.destroy();
      return;
    }
    state.pendingPasswordUpdate = updatePassword;
    passwordPanel.hidden = false;
    unlockPdfButton.disabled = false;
    const incorrect = reason === pdfjsLib.PasswordResponses?.INCORRECT_PASSWORD;
    passwordFeedback.textContent = incorrect ? "密码不正确，请重试。" : "请输入打开密码。";
    pdfPassword.value = "";
    pdfPassword.focus();
    setImportEnabled(true);
    setDocumentStatus("等待本地 PDF 密码", "working");
  };
  try {
    return await loadingTask.promise;
  } catch (error) {
    if (error?.name === "PasswordException") {
      throw createReaderError("未能解锁此 PDF。", "PDF_PASSWORD_ERROR");
    }
    throw error;
  }
}

function submitPdfPassword() {
  const updatePassword = state.pendingPasswordUpdate;
  if (!updatePassword) {
    passwordFeedback.textContent = "当前没有等待解锁的 PDF。";
    return;
  }
  const password = pdfPassword.value;
  if (!password) {
    passwordFeedback.textContent = "请输入密码。";
    return;
  }
  state.pendingPasswordUpdate = null;
  unlockPdfButton.disabled = true;
  passwordFeedback.textContent = "正在本地解锁…";
  pdfPassword.value = "";
  setImportEnabled(false);
  updatePassword(password);
}

function clearPasswordPrompt() {
  state.pendingPasswordUpdate = null;
  pdfPassword.value = "";
  passwordFeedback.textContent = "";
  passwordPanel.hidden = true;
  unlockPdfButton.disabled = false;
}

function validatePdfDocument(pdfDocument) {
  const count = Number(pdfDocument?.numPages);
  if (!Number.isInteger(count) || count < 1) {
    throw createReaderError("PDF 没有可读取的页面。", "EMPTY_PDF");
  }
  if (count > MAX_PAGE_COUNT) {
    throw createReaderError("PDF 最多支持 500 页。", "TOO_MANY_PAGES");
  }
}

function validateAnalyzedPage(page) {
  if (
    !Number.isFinite(page?.width) ||
    !Number.isFinite(page?.height) ||
    page.width <= 0 ||
    page.height <= 0 ||
    page.width > MAX_PAGE_DIMENSION ||
    page.height > MAX_PAGE_DIMENSION
  ) {
    throw createReaderError(`第 ${page?.pageNumber || "?"} 页尺寸异常，已停止分析。`, "PAGE_SIZE_INVALID");
  }
}

function createAnalysisStatus(pages) {
  const scanned = pages.filter((page) => page.type === "scanned").length;
  if (scanned === pages.length) {
    return "未检测到可翻译的原生文字；扫描页将在当前版本中跳过。";
  }
  if (scanned > 0) {
    return `分析完成：${scanned} 个扫描页会跳过，其余页面翻译原生文字。`;
  }
  return "分析完成，可以确认发送范围并开始翻译。";
}

function createLightweightPage(page) {
  const { lines: _pageLines, items: _pageItems, blocks, ...pageFields } = page;
  return {
    ...pageFields,
    blocks: (blocks || []).map((block) => {
      const { lines: _blockLines, items: _blockItems, ...blockFields } = block;
      return blockFields;
    }),
  };
}

function updateAnalysisSummary() {
  if (!state.pages.length) {
    return;
  }
  const textPages = state.pages.filter((page) => page.type === "text").length;
  const scannedPages = state.pages.filter((page) => page.type === "scanned").length;
  const blockCount = state.pages.reduce((total, page) => total + page.blocks.length, 0);
  pageCount.textContent = String(state.pages.length);
  textPageCount.textContent = String(textPages);
  scanPageCount.textContent = String(scannedPages);
  mixedPageCount.textContent = "0";
  textBlockCount.textContent = String(blockCount);

  if (!state.settings?.hasTextProvider) {
    providerSummary.textContent =
      `检测到 ${blockCount} 个文字块；${state.settings?.configurationHint || "尚未配置可用的文本供应商，请先打开翻译设置。"}扫描页不会发送。`;
    return;
  }
  providerSummary.textContent =
    `原生文字将分 ${state.batches.length} 批发送；每个批次开始时使用当时的当前文本供应商和模型。` +
    `当前配置为 ${state.settings.providerLabel} / ${state.settings.textModel}；` +
    `${scannedPages} 个扫描页不会发送。原始 PDF、文件名和页面图像都不会上传。`;
}

function updateStartButton() {
  const hasText = state.batches.length > 0;
  const ready = state.phase === "ready";
  startTranslationButton.disabled = !(
    ready &&
    hasText &&
    state.settings?.hasTextProvider &&
    privacyConfirm.checked
  );
}

function renderWorkspace() {
  destroyRenderedPages();
  workspacePanel.hidden = false;
  pagesEmptyState?.remove();
  state.canvasRenderer = new LazyPageCanvasRenderer({
    pdfDocument: state.pdfDocument,
    requestedScale: Math.min(2, Math.max(1.25, globalThis.devicePixelRatio || 1.5)),
    onError(error, pageNumber) {
      const card = state.pageCards.get(pageNumber);
      const renderStatus = card?.querySelector('[data-role="render-status"]');
      if (renderStatus) renderStatus.textContent = "原页渲染失败";
    },
  });

  for (const page of state.pages) {
    const fragment = pageTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".page-card");
    card.dataset.pageNumber = String(page.pageNumber);
    card.querySelector('[data-role="page-title"]').textContent = `第 ${page.pageNumber} 页`;
    card.querySelector('[data-role="page-type"]').textContent =
      page.type === "scanned" ? "扫描页 · 当前版本跳过" : createPageTypeLabel(page);
    const retryButton = card.querySelector('[data-role="retry-page"]');
    retryButton.addEventListener("click", () => void retryPage(page.pageNumber));
    pagesContainer.append(fragment);
    state.pageCards.set(page.pageNumber, card);

    const canvas = card.querySelector('[data-role="page-canvas"]');
    const canvasStage = card.querySelector('[data-role="canvas-stage"]');
    const sourceOverlay = card.querySelector('[data-role="source-overlay"]');
    state.canvasRenderer.registerPage({
      pageNumber: page.pageNumber,
      canvas,
      container: card,
      onRendered() {
        card.querySelector('[data-role="render-status"]').textContent = "原页已渲染";
        syncOverlaySize(canvasStage, canvas, sourceOverlay);
      },
      onError() {
        card.querySelector('[data-role="render-status"]').textContent = "原页渲染失败";
      },
    });
    renderPageTextBlocks(page);
    updatePageState(page.pageNumber);
  }

  totalPageCount.textContent = String(state.pages.length);
  setJobControls(false);
  updateProgress();
}

function createPageTypeLabel(page) {
  const roleLabels = new Set(page.blocks.map((block) => block.type));
  const details = [];
  if (page.columnCount > 1) details.push(`${page.columnCount} 栏`);
  if (roleLabels.has("table")) details.push("含表格");
  if (roleLabels.has("footnote")) details.push("含脚注");
  return details.length ? `文本页 · ${details.join(" · ")}` : "文本页";
}

function renderPageTextBlocks(page) {
  const card = state.pageCards.get(page.pageNumber);
  if (!card) return;
  state.blockRenderCleanup.get(page.pageNumber)?.();
  const sourceContainer = card.querySelector('[data-role="source-overlay"]');
  const translationContainer = card.querySelector('[data-role="translation-blocks"]');
  if (page.type === "scanned") {
    sourceContainer.replaceChildren();
    const message = document.createElement("p");
    message.className = "page-empty-message";
    message.textContent = "此页没有足够的原生文字层。阶段 A 不发送页面像素，请使用带 OCR 文字层的 PDF。";
    translationContainer.replaceChildren(message);
    card.querySelector('[data-role="translation-status"]').textContent = "扫描页已跳过";
    return;
  }

  const displayBlocks = page.blocks.map((block) => ({
    ...block,
    source: block.text,
    target: state.translations.get(block.id) || state.partialTranslations.get(block.id) || "",
  }));
  const rendered = renderPageBlocks({
    sourceContainer,
    translationContainer,
    blocks: displayBlocks,
    pendingText: "等待译文…",
  });
  state.blockRenderCleanup.set(page.pageNumber, rendered.destroy);
  const canvas = card.querySelector('[data-role="page-canvas"]');
  syncOverlaySize(card.querySelector('[data-role="canvas-stage"]'), canvas, sourceContainer);
}

async function startTranslation() {
  if (startTranslationButton.disabled || state.phase !== "ready") return;
  const generation = state.generation;
  setDocumentStatus("正在创建 PDF 翻译任务…", "working");
  state.phase = "starting";
  startTranslationButton.disabled = true;
  await refreshPdfSettings();
  if (generation !== state.generation || state.phase !== "starting" || state.disposed) return;
  if (!state.settings?.hasTextProvider) {
    state.phase = "ready";
    updateStartButton();
    setDocumentStatus("未配置可用的文本翻译密钥。", "error");
    return;
  }

  try {
    await createBackgroundJob({ generation });
    if (generation !== state.generation || state.phase !== "starting" || state.disposed) return;
    state.phase = "translating";
    setJobControls(true);
    startKeepAlive();
    setDocumentStatus("正在翻译 PDF", "working");
    overallProgressText.textContent = "正在分批翻译原生文字…";
    scheduleBatches();
  } catch (error) {
    if (generation !== state.generation || state.disposed) return;
    state.phase = "ready";
    setDocumentStatus(toReaderMessage(error), "error");
    overallProgressText.textContent = toReaderMessage(error);
    updateStartButton();
  }
}

async function createBackgroundJob({ generation }) {
  state.jobClient?.cancelJob();
  state.jobClient?.disconnect();
  const jobId = createSafeId("pdf-job");
  const client = new PdfJobClient({
    onEvent: handleJobEvent,
    onDisconnect: handleJobDisconnect,
  });
  state.jobId = jobId;
  state.jobClient = client;
  try {
    await client.createJob({
      jobId,
      fingerprint: state.fingerprint,
      pageCount: state.pages.length,
    });
  } catch (error) {
    client.cancelJob();
    client.disconnect();
    if (state.jobClient === client) state.jobClient = null;
    if (state.jobId === jobId) state.jobId = "";
    throw error;
  }
  if (
    generation !== state.generation
    || state.phase !== "starting"
    || state.jobId !== jobId
    || state.jobClient !== client
    || state.disposed
  ) {
    client.cancelJob();
    client.disconnect();
    if (state.jobClient === client) state.jobClient = null;
    if (state.jobId === jobId) state.jobId = "";
    throw new DOMException("Aborted", "AbortError");
  }
  providerSummary.textContent =
    "每个文本批次都会在开始时读取当前供应商与模型；仅发送当前文字批次，扫描页和原始 PDF 不会上传。";
}

function scheduleBatches() {
  if (state.phase !== "translating" || !state.jobClient) return;
  while (state.activeBatchIds.size < TEXT_CONCURRENCY) {
    const batch = state.batches.find((candidate) => candidate.state === "pending");
    if (!batch) break;
    batch.attempt += 1;
    batch.attemptId = createBatchAttemptId(batch);
    batch.state = "translating";
    batch.error = "";
    clearPartialTranslations(batch);
    state.batchByAttemptId.set(batch.attemptId, batch);
    state.activeBatchIds.add(batch.attemptId);
    try {
      state.jobClient.translateTextBatch({
        batchId: batch.attemptId,
        blocks: batch.blocks.map((block) => ({ id: block.id, text: block.text })),
      });
    } catch (error) {
      state.activeBatchIds.delete(batch.attemptId);
      state.batchByAttemptId.delete(batch.attemptId);
      state.jobClient.forgetBatch(batch.attemptId);
      batch.state = "failed";
      batch.error = toReaderMessage(error);
      batch.errorCode = "SEND_FAILED";
    }
    updatePageState(batch.pageNumber);
  }
  updateProgress();
  finishIfSettled();
}

function handleJobEvent(message) {
  if (message.jobId !== state.jobId) return;
  if (message.type === "BATCH_STARTED" || message.type === "DELTA") {
    const batch = state.batchByAttemptId.get(message.batchId);
    if (batch) {
      const card = state.pageCards.get(batch.pageNumber);
      card.querySelector('[data-role="translation-status"]').textContent =
        message.type === "DELTA" ? "正在接收结构化译文…" : "已发送当前批次";
      if (
        message.type === "BATCH_STARTED"
        && typeof message.providerLabel === "string"
        && typeof message.model === "string"
      ) {
        providerSummary.textContent =
          `当前批次使用 ${message.providerLabel} / ${message.model}；后续批次仍会读取届时的当前配置。`;
      }
    }
    return;
  }
  if (message.type === "BATCH_PROGRESS") {
    const batch = state.batchByAttemptId.get(message.batchId);
    if (!batch || batch.attemptId !== message.batchId) return;
    let changed = false;
    const allowedIds = new Set(batch.blocks.map((block) => block.id));
    for (const translation of Array.isArray(message.translations) ? message.translations : []) {
      if (
        !translation
        || typeof translation.id !== "string"
        || typeof translation.target !== "string"
        || !allowedIds.has(translation.id)
        || !translation.target
      ) continue;
      if (state.partialTranslations.get(translation.id) === translation.target) continue;
      state.partialTranslations.set(translation.id, translation.target);
      changed = true;
    }
    if (changed) queueStreamingPageRender(batch.pageNumber);
    const card = state.pageCards.get(batch.pageNumber);
    const translationStatus = card?.querySelector('[data-role="translation-status"]');
    if (translationStatus) translationStatus.textContent = "正在流式生成译文…";
    return;
  }
  if (message.type === "BATCH_DONE") {
    const batch = takeActiveBatch(message.batchId);
    if (!batch) return;
    clearPartialTranslations(batch);
    for (const translation of message.translations || []) {
      state.translations.set(translation.id, translation.target);
    }
    batch.state = "completed";
    renderPageTextBlocks(state.pages[batch.pageNumber - 1]);
    updatePageState(batch.pageNumber);
    scheduleBatches();
    return;
  }
  if (message.type === "BATCH_ERROR") {
    const batch = takeActiveBatch(message.batchId);
    if (!batch) return;
    clearPartialTranslations(batch);
    batch.state = "failed";
    batch.error = message.error || "当前批次翻译失败。";
    batch.errorCode = message.code || "BATCH_FAILED";
    batch.retryable = Boolean(message.retryable);
    queueStreamingPageRender(batch.pageNumber);
    updatePageState(batch.pageNumber);
    scheduleBatches();
    return;
  }
  if (message.type === "BATCH_CANCELLED") {
    const batch = takeActiveBatch(message.batchId);
    if (!batch) return;
    clearPartialTranslations(batch);
    queueStreamingPageRender(batch.pageNumber);
    batch.state = state.phase === "paused" ? "pending" : "cancelled";
    updatePageState(batch.pageNumber);
    scheduleBatches();
  }
}

function takeActiveBatch(attemptId) {
  const batch = state.batchByAttemptId.get(attemptId);
  if (!batch || batch.attemptId !== attemptId) return null;
  state.batchByAttemptId.delete(attemptId);
  state.activeBatchIds.delete(attemptId);
  return batch;
}

function clearPartialTranslations(batch) {
  let changed = false;
  for (const block of batch?.blocks || []) {
    changed = state.partialTranslations.delete(block.id) || changed;
  }
  return changed;
}

function queueStreamingPageRender(pageNumber) {
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || state.disposed) return;
  state.pendingStreamPageNumbers.add(pageNumber);
  if (state.streamRenderFrame != null) return;
  state.streamRenderFrame = requestAnimationFrame(() => {
    state.streamRenderFrame = null;
    const pageNumbers = [...state.pendingStreamPageNumbers];
    state.pendingStreamPageNumbers.clear();
    for (const pendingPageNumber of pageNumbers) {
      refreshStreamingTranslationTargets(pendingPageNumber);
    }
  });
}

function refreshStreamingTranslationTargets(pageNumber) {
  const page = state.pages[pageNumber - 1];
  const card = state.pageCards.get(pageNumber);
  const container = card?.querySelector('[data-role="translation-blocks"]');
  if (!page || !container) return;
  const textById = new Map(page.blocks.map((block) => [
    block.id,
    state.translations.get(block.id) || state.partialTranslations.get(block.id) || "",
  ]));
  for (const element of container.querySelectorAll("[data-block-id]")) {
    const target = textById.get(element.dataset.blockId);
    if (target == null) continue;
    const targetElement = element.querySelector(".translation-target-text");
    if (!targetElement) continue;
    targetElement.textContent = target || "等待译文…";
    targetElement.classList.toggle("is-pending", !target);
  }
}

function pauseTranslation() {
  if (state.phase !== "translating") return;
  state.phase = "paused";
  for (const attemptId of [...state.activeBatchIds]) {
    const batch = state.batchByAttemptId.get(attemptId);
    state.jobClient?.cancelBatch(attemptId);
    state.batchByAttemptId.delete(attemptId);
    if (batch) {
      clearPartialTranslations(batch);
      queueStreamingPageRender(batch.pageNumber);
      batch.state = "pending";
      batch.attemptId = "";
      updatePageState(batch.pageNumber);
    }
  }
  state.activeBatchIds.clear();
  pauseTranslationButton.hidden = true;
  resumeTranslationButton.hidden = false;
  cancelTranslationButton.disabled = false;
  overallProgressText.textContent = "已暂停；在途批次已取消，继续时只重跑未完成批次。";
  setDocumentStatus("PDF 翻译已暂停", "ready");
  stopKeepAlive();
  updateProgress();
}

function resumeTranslation() {
  if (state.phase !== "paused") return;
  state.phase = "translating";
  pauseTranslationButton.hidden = false;
  resumeTranslationButton.hidden = true;
  overallProgressText.textContent = "正在继续翻译未完成批次…";
  setDocumentStatus("正在继续翻译 PDF", "working");
  startKeepAlive();
  if (!state.jobClient?.port) {
    void reconnectBackgroundJob();
    return;
  }
  scheduleBatches();
}

function cancelTranslation() {
  if (!state.jobClient || !["translating", "paused"].includes(state.phase)) return;
  state.phase = "cancelled";
  const cancelledClient = state.jobClient;
  state.jobClient = null;
  state.jobId = "";
  cancelledClient.cancelJob();
  cancelledClient.disconnect();
  for (const batch of state.batches) {
    if (batch.state === "translating" || batch.state === "pending") batch.state = "cancelled";
  }
  state.activeBatchIds.clear();
  state.batchByAttemptId.clear();
  state.partialTranslations.clear();
  for (const page of state.pages) queueStreamingPageRender(page.pageNumber);
  stopKeepAlive();
  setJobControls(false);
  overallProgressText.textContent = "任务已取消；已完成译文仍可导出。";
  setDocumentStatus("PDF 翻译已取消", "ready");
  updateAllPageStates();
  updateProgress();
}

async function retryPage(pageNumber) {
  if (
    !["translating", "paused", "finished_with_errors"].includes(state.phase)
    || (["translating", "paused"].includes(state.phase) && !state.jobId)
  ) return;
  const retryPlan = createPageRetryPlan(pageNumber);
  if (!retryPlan) return;
  if (state.phase === "finished_with_errors") {
    await rebuildJobForPageRetry(pageNumber, retryPlan);
    return;
  }

  state.batches = retryPlan.nextBatches;
  if (state.phase !== "paused") {
    state.phase = "translating";
    setJobControls(true);
    startKeepAlive();
    if (state.jobClient?.port) {
      scheduleBatches();
    } else {
      void reconnectBackgroundJob();
    }
  }
  updatePageState(pageNumber);
}

async function rebuildJobForPageRetry(pageNumber, retryPlan) {
  const generation = state.generation;
  state.phase = "retry_preparing";
  overallProgressText.textContent = "正在刷新设置并为失败页面重建翻译任务…";
  setDocumentStatus("正在准备重试失败页面", "working");

  const settings = await refreshPdfSettings();
  if (
    generation !== state.generation
    || state.phase !== "retry_preparing"
    || state.disposed
  ) return;
  if (!settings?.hasTextProvider) {
    state.phase = "finished_with_errors";
    setDocumentStatus("未配置可用的文本翻译密钥。", "error");
    overallProgressText.textContent = "请先在设置页修正 API Key，再重试失败页面。";
    updatePageState(pageNumber);
    return;
  }

  state.batches = retryPlan.nextBatches;
  state.phase = "starting";
  updatePageState(pageNumber);
  try {
    await createBackgroundJob({ generation });
    if (generation !== state.generation || state.phase !== "starting" || state.disposed) return;
    state.phase = "translating";
    setJobControls(true);
    startKeepAlive();
    setDocumentStatus("正在重试失败页面", "working");
    overallProgressText.textContent = "后台任务已刷新，正在重试本页未完成批次…";
    scheduleBatches();
  } catch (error) {
    if (generation !== state.generation || state.disposed) return;
    state.batches = retryPlan.previousBatches;
    state.phase = "finished_with_errors";
    stopKeepAlive();
    setJobControls(false);
    setDocumentStatus(toReaderMessage(error), "error");
    overallProgressText.textContent = `${toReaderMessage(error)} 请修正后重试本页。`;
    updatePageState(pageNumber);
    updateProgress();
  }
}

function createPageRetryPlan(pageNumber) {
  let changed = false;
  const nextBatches = [];
  for (const batch of state.batches) {
    if (batch.pageNumber !== pageNumber || batch.state !== "failed") {
      nextBatches.push(batch);
      continue;
    }

    changed = true;
    if (batch.errorCode === "INVALID_BATCH_RESPONSE" && batch.blocks.length > 1) {
      nextBatches.push(...splitBatchForManualRetry(batch));
      continue;
    }
    nextBatches.push({
      ...batch,
      state: "pending",
      attemptId: "",
      error: "",
      errorCode: "",
      retryable: false,
    });
  }
  if (!changed) return null;
  return {
    previousBatches: state.batches,
    nextBatches,
  };
}

function splitBatchForManualRetry(batch) {
  const middle = Math.ceil(batch.blocks.length / 2);
  return [batch.blocks.slice(0, middle), batch.blocks.slice(middle)]
    .filter((blocks) => blocks.length > 0)
    .map((blocks, index) => ({
      ...batch,
      id: `${batch.id}.r${batch.attempt + 1}.${index + 1}`,
      batchId: `${batch.id}.r${batch.attempt + 1}.${index + 1}`,
      blocks,
      characterCount: blocks.reduce(
        (total, block) => total + Array.from(block.text).length,
        0,
      ),
      state: "pending",
      attempt: 0,
      attemptId: "",
      error: "",
      errorCode: "",
      retryable: false,
    }));
}

function handleJobDisconnect({ activeBatchIds }) {
  if (
    !["translating", "paused", "finished_with_errors"].includes(state.phase)
    || state.disposed
  ) return;
  for (const attemptId of activeBatchIds) {
    const batch = state.batchByAttemptId.get(attemptId);
    if (batch) {
      clearPartialTranslations(batch);
      queueStreamingPageRender(batch.pageNumber);
      batch.state = "pending";
      batch.attemptId = "";
    }
  }
  state.batchByAttemptId.clear();
  state.activeBatchIds.clear();
  updateAllPageStates();
  if (state.phase === "translating") {
    void reconnectBackgroundJob();
  } else if (state.phase === "finished_with_errors") {
    overallProgressText.textContent = "后台连接已休眠；重试失败页面时会重新连接。";
  }
}

async function reconnectBackgroundJob() {
  if (state.reconnecting || state.disposed || state.phase !== "translating") return;
  const generation = state.generation;
  const jobId = state.jobId;
  const reconnectToken = {};
  state.reconnecting = true;
  state.reconnectToken = reconnectToken;
  overallProgressText.textContent = "后台连接中断，正在恢复未完成批次…";
  stopKeepAlive();
  let lastError = null;
  for (const delay of RECONNECT_DELAYS_MS) {
    await wait(delay);
    if (!isCurrentReconnect(reconnectToken, generation, jobId)) break;
    let client = null;
    try {
      client = new PdfJobClient({
        onEvent: handleJobEvent,
        onDisconnect(info) {
          if (state.jobClient === client) handleJobDisconnect(info);
        },
      });
      await client.createJob({
        jobId,
        fingerprint: state.fingerprint,
        pageCount: state.pages.length,
      });
      if (!isCurrentReconnect(reconnectToken, generation, jobId)) {
        client.cancelJob();
        client.disconnect();
        break;
      }
      state.jobClient = client;
      state.reconnecting = false;
      state.reconnectToken = null;
      startKeepAlive();
      overallProgressText.textContent = "连接已恢复，正在重排未完成批次…";
      scheduleBatches();
      return;
    } catch (error) {
      lastError = error;
      client?.cancelJob();
      client?.disconnect();
    }
  }
  if (state.reconnectToken !== reconnectToken) return;
  state.reconnecting = false;
  state.reconnectToken = null;
  if (state.phase === "translating") {
    state.phase = "paused";
    pauseTranslationButton.hidden = true;
    resumeTranslationButton.hidden = false;
    overallProgressText.textContent = `${toReaderMessage(lastError)} 请点击“继续”重试连接。`;
    setDocumentStatus("PDF 翻译连接已暂停", "error");
  }
}

function isCurrentReconnect(token, generation, jobId) {
  return (
    state.reconnectToken === token
    && state.reconnecting
    && state.phase === "translating"
    && state.generation === generation
    && state.jobId === jobId
    && !state.disposed
  );
}

function updatePageState(pageNumber) {
  const page = state.pages[pageNumber - 1];
  const card = state.pageCards.get(pageNumber);
  if (!page || !card) return;
  const status = card.querySelector('[data-role="page-status"]');
  const retry = card.querySelector('[data-role="retry-page"]');
  const translationStatus = card.querySelector('[data-role="translation-status"]');
  if (page.type === "scanned") {
    setStatus(status, "completed", "扫描页已跳过");
    retry.hidden = true;
    translationStatus.textContent = "未发送页面像素";
    return;
  }
  const batches = state.batches.filter((batch) => batch.pageNumber === pageNumber);
  const failed = batches.find((batch) => batch.state === "failed");
  if (failed) {
    setStatus(status, "failed", "翻译失败");
    retry.hidden = false;
    const retryHint = failed.errorCode === "INVALID_BATCH_RESPONSE"
      ? " 重试时会自动拆小这个批次。"
      : failed.retryable
        ? " 可手动重试。"
        : "";
    translationStatus.textContent = `${failed.error}${retryHint}`;
  } else if (batches.some((batch) => batch.state === "translating")) {
    setStatus(status, "translating", "翻译中");
    retry.hidden = true;
    translationStatus.textContent = "正在翻译本页文字…";
  } else if (batches.every((batch) => batch.state === "completed")) {
    setStatus(status, "completed", "已完成");
    retry.hidden = true;
    translationStatus.textContent = "本页译文已完成";
  } else if (
    batches.every((batch) => batch.state === "cancelled") ||
    (state.phase === "cancelled" && batches.some((batch) => batch.state === "cancelled"))
  ) {
    setStatus(status, "cancelled", "已取消");
    retry.hidden = true;
    translationStatus.textContent = "本页未完成批次已取消";
  } else {
    setStatus(status, "pending", state.phase === "paused" ? "已暂停" : "等待翻译");
    retry.hidden = true;
    translationStatus.textContent = state.phase === "paused" ? "等待继续" : "等待翻译";
  }
}

function setStatus(element, value, label) {
  element.dataset.status = value;
  element.textContent = label;
}

function updateAllPageStates() {
  for (const page of state.pages) updatePageState(page.pageNumber);
}

function updateProgress() {
  const scanned = state.pages.filter((page) => page.type === "scanned").length;
  const translatedPages = state.pages.filter((page) => {
    if (page.type === "scanned") return false;
    const batches = state.batches.filter((batch) => batch.pageNumber === page.pageNumber);
    return batches.length > 0 && batches.every((batch) => batch.state === "completed");
  }).length;
  const completed = scanned + translatedPages;
  const total = state.pages.length || 1;
  completedPageCount.textContent = String(completed);
  totalPageCount.textContent = String(state.pages.length);
  const percent = Math.round((completed / total) * 100);
  overallProgress.value = percent;
  overallProgress.textContent = `${percent}%`;
  const hasTranslations = state.translations.size > 0;
  exportHtmlButton.disabled = !hasTranslations;
  printButton.disabled = !hasTranslations;
}

function finishIfSettled() {
  if (state.phase !== "translating" || state.activeBatchIds.size > 0) return;
  if (state.batches.some((batch) => batch.state === "pending" || batch.state === "translating")) return;
  stopKeepAlive();
  const failures = state.batches.filter((batch) => batch.state === "failed").length;
  state.phase = failures ? "finished_with_errors" : "completed";
  const settledClient = state.jobClient;
  state.jobClient = null;
  state.jobId = "";
  settledClient?.cancelJob();
  settledClient?.disconnect();
  setJobControls(false);
  if (failures) {
    overallProgressText.textContent = `${failures} 个批次失败，可在对应页面单独重试。`;
    setDocumentStatus("PDF 翻译部分完成", "error");
  } else {
    overallProgressText.textContent = "全部可提取文字已翻译完成。";
    setDocumentStatus("PDF 翻译完成", "ready");
  }
  updateProgress();
}

function setJobControls(active) {
  pauseTranslationButton.disabled = !active;
  pauseTranslationButton.hidden = false;
  resumeTranslationButton.hidden = true;
  cancelTranslationButton.disabled = !active;
}

function setReadingView(view) {
  const allowed = new Set(["original", "translated", "bilingual"]);
  if (!allowed.has(view)) return;
  pagesContainer.dataset.view = view;
  for (const button of [originalViewButton, translatedViewButton, bilingualViewButton]) {
    const active = button.dataset.view === view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  }
  requestAnimationFrame(syncAllOverlaySizes);
}

function buildExportData() {
  return {
    fileName: state.file?.name || "PDF 文档",
    pages: state.pages.map((page) => ({
      pageNumber: page.pageNumber,
      pageType: page.type === "scanned" ? "扫描页（未翻译）" : "文本页",
      blocks: page.blocks.map((block) => ({
        id: block.id,
        source: block.text,
        target: state.translations.get(block.id) || "",
      })),
    })),
  };
}

function exportHtml() {
  try {
    downloadBilingualHtml(buildExportData());
    setDocumentStatus("双语 HTML 已生成", "ready");
  } catch (error) {
    setDocumentStatus(toReaderMessage(error), "error");
  }
}

function printDocument() {
  try {
    printBilingualDocument(buildExportData());
  } catch (error) {
    setDocumentStatus(toReaderMessage(error), "error");
  }
}

function startKeepAlive() {
  stopKeepAlive();
  state.keepAliveTimer = setInterval(() => state.jobClient?.keepAlive(), KEEPALIVE_INTERVAL_MS);
}

function stopKeepAlive() {
  clearInterval(state.keepAliveTimer);
  state.keepAliveTimer = null;
}

function syncAllOverlaySizes() {
  for (const card of state.pageCards.values()) {
    syncOverlaySize(
      card.querySelector('[data-role="canvas-stage"]'),
      card.querySelector('[data-role="page-canvas"]'),
      card.querySelector('[data-role="source-overlay"]'),
    );
  }
}

function syncOverlaySize(stage, canvas, overlay) {
  if (!stage || !canvas || !overlay || !canvas.dataset.rendered) return;
  const canvasRect = canvas.getBoundingClientRect();
  const stageRect = stage.getBoundingClientRect();
  overlay.style.left = `${Math.max(0, canvasRect.left - stageRect.left)}px`;
  overlay.style.top = `${Math.max(0, canvasRect.top - stageRect.top)}px`;
  overlay.style.width = `${canvasRect.width}px`;
  overlay.style.height = `${canvasRect.height}px`;
  overlay.style.right = "auto";
  overlay.style.bottom = "auto";
}

async function resetDocument({ preserveGeneration = false } = {}) {
  if (!preserveGeneration) state.generation += 1;
  const loadingTask = state.loadingTask;
  const pdfDocument = state.pdfDocument;
  const canvasRenderer = state.canvasRenderer;
  const jobClient = state.jobClient;
  stopKeepAlive();
  jobClient?.cancelJob();
  jobClient?.disconnect();
  state.jobClient = null;
  state.jobId = "";
  state.loadingTask = null;
  state.pendingPasswordUpdate = null;
  canvasRenderer?.destroy();
  state.canvasRenderer = null;
  state.pdfDocument = null;
  state.file = null;
  state.fingerprint = "";
  state.pages = [];
  state.batches = [];
  state.batchByAttemptId.clear();
  state.activeBatchIds.clear();
  state.translations.clear();
  state.partialTranslations.clear();
  state.pendingStreamPageNumbers.clear();
  if (state.streamRenderFrame != null) cancelAnimationFrame(state.streamRenderFrame);
  state.streamRenderFrame = null;
  state.reconnecting = false;
  state.reconnectToken = null;
  destroyRenderedPages();
  state.phase = "idle";
  fileSummary.hidden = true;
  passwordPanel.hidden = true;
  analysisPanel.hidden = true;
  workspacePanel.hidden = true;
  privacyConfirm.checked = false;
  setImportEnabled(true);
  setDocumentStatus("等待选择 PDF", "");

  const destroyOperations = [];
  if (loadingTask?.destroy) {
    destroyOperations.push(Promise.resolve().then(() => loadingTask.destroy()));
  }
  if (pdfDocument?.destroy) {
    destroyOperations.push(Promise.resolve().then(() => pdfDocument.destroy()));
  }
  await Promise.allSettled(destroyOperations);
}

function destroyRenderedPages() {
  for (const cleanup of state.blockRenderCleanup.values()) cleanup();
  state.blockRenderCleanup.clear();
  state.canvasRenderer?.destroy();
  state.pageCards.clear();
  pagesContainer.replaceChildren();
}

function dispose() {
  state.disposed = true;
  state.generation += 1;
  stopKeepAlive();
  if (state.streamRenderFrame != null) cancelAnimationFrame(state.streamRenderFrame);
  state.streamRenderFrame = null;
  state.pendingStreamPageNumbers.clear();
  state.partialTranslations.clear();
  const jobClient = state.jobClient;
  const loadingTask = state.loadingTask;
  const pdfDocument = state.pdfDocument;
  jobClient?.cancelJob();
  jobClient?.disconnect();
  state.canvasRenderer?.destroy();
  void Promise.allSettled([
    ...(loadingTask?.destroy
      ? [Promise.resolve().then(() => loadingTask.destroy())]
      : []),
    ...(pdfDocument?.destroy
      ? [Promise.resolve().then(() => pdfDocument.destroy())]
      : []),
  ]);
}

function setImportEnabled(enabled) {
  pdfFileInput.disabled = !enabled;
  changeFileButton.disabled = !enabled;
  dropZone.setAttribute("aria-disabled", String(!enabled));
}

function isBusy() {
  return ["analyzing", "starting"].includes(state.phase);
}

function setDocumentStatus(message, status) {
  documentStatus.textContent = message;
  documentStatus.dataset.status = status || "idle";
}

function createBatchAttemptId(batch) {
  return `${batch.id}-a${batch.attempt}-${randomToken(8)}`;
}

function createSafeId(prefix) {
  const uuid = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : randomToken(32);
  return `${prefix}-${uuid}`;
}

function randomToken(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function assertCurrentGeneration(generation) {
  if (generation !== state.generation || state.disposed) {
    throw new DOMException("Aborted", "AbortError");
  }
}

function createReaderError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function toReaderMessage(error) {
  if (error?.name === "AbortError") return "操作已取消。";
  if (error?.name === "InvalidPDFException" || error?.name === "FormatError") {
    return "PDF 已损坏或格式不受支持。";
  }
  if (error?.name === "MissingPDFException") return "无法读取所选 PDF。";
  if (typeof error?.message === "string" && error.message) return error.message;
  return "处理 PDF 时发生错误。";
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function yieldToUi() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
