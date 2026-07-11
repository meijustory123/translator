import {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  DEFAULT_SILICONFLOW_MODEL,
  IMAGE_SYSTEM_PROMPT,
  IMAGE_USER_PROMPT,
  SILICONFLOW_API_URL,
  SILICONFLOW_MODELS,
  TEXT_SYSTEM_PROMPT,
} from "../shared/prompts.js";
import { buildChatRequestBody, consumeSseEvents } from "../shared/api-contract.js";
import { chooseTextProvider } from "../shared/routing.js";

const IMAGE_MENU_ID = "translate-image-with-siliconflow";
const TRANSLATION_PORT_NAME = "multi-provider-translation";
const MAX_TEXT_LENGTH = 20_000;
const MAX_IMAGE_SIDE = 2_560;
const MAX_IMAGE_PIXELS = 5_500_000;
const STREAM_IDLE_TIMEOUT_MS = 45_000;
const RESPONSE_HEADER_TIMEOUT_MS = 45_000;
const TEXT_PROVIDER_DEEPSEEK_FIRST = "deepseek_first";
const TEXT_PROVIDER_SILICONFLOW = "siliconflow";

void initializeStorage();

chrome.runtime.onInstalled.addListener(({ reason }) => {
  createContextMenu();
  void initializeStorage();

  if (reason === "install") {
    void chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup.addListener(() => {
  createContextMenu();
  void initializeStorage();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== IMAGE_MENU_ID || !tab?.id) {
    return;
  }

  void chrome.tabs
    .sendMessage(tab.id, { type: "TRANSLATE_CONTEXT_IMAGE" })
    .catch(() => undefined);
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== TRANSLATION_PORT_NAME || !isTrustedSender(port.sender)) {
    port.disconnect();
    return;
  }

  const state = {
    controller: null,
    requestId: "",
  };
  port.onMessage.addListener((message) => {
    void handlePortMessage(port, state, message);
  });

  port.onDisconnect.addListener(() => {
    state.controller?.abort("port-disconnected");
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedSender(sender) || !message || typeof message !== "object") {
    sendResponse({ ok: false, error: "无效请求。" });
    return false;
  }

  if (message.type === "GET_PUBLIC_SETTINGS") {
    void getPublicSettings().then((settings) => {
      if (sender.tab) {
        sendResponse({
          ok: settings.ok,
          autoTranslate: settings.autoTranslate,
          hasApiKey: settings.hasApiKey,
        });
        return;
      }
      sendResponse(settings);
    });
    return true;
  }

  if (message.type === "SET_AUTO_TRANSLATE" && !sender.tab) {
    const autoTranslate = Boolean(message.autoTranslate);
    void chrome.storage.local
      .set({ autoTranslate })
      .then(() => sendResponse({ ok: true, autoTranslate }))
      .catch(() => sendResponse({ ok: false, error: "设置保存失败。" }));
    return true;
  }

  if (message.type === "TEST_CONNECTION" && !sender.tab) {
    void testConnection(message.provider)
      .then((result) => sendResponse({ ok: true, result }))
      .catch((error) => sendResponse({ ok: false, error: toUserMessage(error) }));
    return true;
  }

  sendResponse({ ok: false, error: "不支持的请求。" });
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.autoTranslate) {
    return;
  }

  void broadcastPublicSettings(Boolean(changes.autoTranslate.newValue));
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: IMAGE_MENU_ID,
      title: "翻译这张图片",
      contexts: ["image"],
    });
  });
}

async function restrictStorageAccess() {
  if (typeof chrome.storage.local.setAccessLevel !== "function") {
    return;
  }

  try {
    await chrome.storage.local.setAccessLevel({
      accessLevel: "TRUSTED_CONTEXTS",
    });
  } catch {
    // Older managed Chrome builds may not expose this method.
  }
}

async function initializeStorage() {
  await restrictStorageAccess();
  await migrateLegacySettings();
}

async function migrateLegacySettings() {
  try {
    const settings = await chrome.storage.local.get({
      apiKey: "",
      siliconFlowApiKey: "",
    });
    const legacyKey = normalizeSecret(settings.apiKey);
    const currentKey = normalizeSecret(settings.siliconFlowApiKey);

    if (legacyKey && !currentKey) {
      await chrome.storage.local.set({ siliconFlowApiKey: legacyKey });
    }
    if (settings.apiKey) {
      await chrome.storage.local.remove("apiKey");
    }
  } catch {
    // Migration is best-effort; read helpers still understand the legacy key.
  }
}

function isTrustedSender(sender) {
  return sender?.id === chrome.runtime.id;
}

async function getPublicSettings() {
  const settings = await chrome.storage.local.get({
    apiKey: "",
    siliconFlowApiKey: "",
    siliconFlowModel: DEFAULT_SILICONFLOW_MODEL,
    deepSeekApiKey: "",
    textProviderMode: TEXT_PROVIDER_DEEPSEEK_FIRST,
    autoTranslate: true,
  });

  const siliconFlowApiKey = normalizeSecret(settings.siliconFlowApiKey || settings.apiKey);
  const deepSeekApiKey = normalizeSecret(settings.deepSeekApiKey);
  const siliconFlowModel = normalizeSiliconFlowModel(settings.siliconFlowModel);
  const textProviderMode = normalizeTextProviderMode(settings.textProviderMode);
  const activeTextProvider =
    chooseTextProvider({ textProviderMode, deepSeekApiKey, siliconFlowApiKey }) || "siliconflow";
  return {
    ok: true,
    autoTranslate: settings.autoTranslate !== false,
    hasApiKey: activeTextProvider === "deepseek" ? Boolean(deepSeekApiKey) : Boolean(siliconFlowApiKey),
    hasSiliconFlowKey: Boolean(siliconFlowApiKey),
    hasDeepSeekKey: Boolean(deepSeekApiKey),
    siliconFlowKeySuffix: siliconFlowApiKey ? siliconFlowApiKey.slice(-4) : "",
    deepSeekKeySuffix: deepSeekApiKey ? deepSeekApiKey.slice(-4) : "",
    siliconFlowModel,
    textProviderMode,
    activeTextProvider,
    textModel: activeTextProvider === "deepseek" ? DEEPSEEK_MODEL : siliconFlowModel,
    imageModel: siliconFlowModel,
  };
}

function normalizeSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeSiliconFlowModel(value) {
  return SILICONFLOW_MODELS.includes(value) ? value : DEFAULT_SILICONFLOW_MODEL;
}

function normalizeTextProviderMode(value) {
  return value === TEXT_PROVIDER_SILICONFLOW
    ? TEXT_PROVIDER_SILICONFLOW
    : TEXT_PROVIDER_DEEPSEEK_FIRST;
}

async function broadcastPublicSettings(autoTranslate) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch {
    return;
  }

  await Promise.allSettled(
    tabs
      .filter((tab) => Number.isInteger(tab.id))
      .map((tab) =>
        chrome.tabs.sendMessage(tab.id, {
          type: "PUBLIC_SETTINGS_CHANGED",
          autoTranslate,
        }),
      ),
  );
}

async function handlePortMessage(port, state, message) {
  if (!message || typeof message !== "object") {
    postPortError(port, "", "无效请求。", "INVALID_REQUEST");
    return;
  }

  if (message.type === "CANCEL") {
    if (!message.requestId || message.requestId === state.requestId) {
      state.controller?.abort("cancelled-by-user");
    }
    return;
  }

  if (message.type !== "TRANSLATE_TEXT" && message.type !== "TRANSLATE_IMAGE") {
    postPortError(port, message.requestId, "不支持的请求。", "INVALID_REQUEST");
    return;
  }

  const requestId = validateRequestId(message.requestId);
  if (!requestId) {
    postPortError(port, "", "请求标识无效。", "INVALID_REQUEST");
    return;
  }

  state.controller?.abort("replaced-by-new-request");
  const controller = new AbortController();
  state.controller = controller;
  state.requestId = requestId;

  try {
    const route =
      message.type === "TRANSLATE_TEXT"
        ? await resolveTextRoute()
        : await resolveSiliconFlowRoute("image");
    let messages;

    safePortPost(port, {
      type: "ROUTE",
      requestId,
      provider: route.provider,
      providerLabel: route.providerLabel,
      model: route.model,
    });

    if (message.type === "TRANSLATE_TEXT") {
      messages = createTextMessages(message);
    } else {
      messages = await createImageMessages(port.sender, message, controller.signal);
      safePortPost(port, { type: "IMAGE_CAPTURED", requestId });
    }

    await streamChatCompletion({
      route,
      messages,
      signal: controller.signal,
      onDelta(delta) {
        safePortPost(port, {
          type: "DELTA",
          requestId,
          delta,
        });
      },
    });

    safePortPost(port, { type: "DONE", requestId });
  } catch (error) {
    if (!isAbortError(error)) {
      postPortError(port, requestId, toUserMessage(error), error.code || "REQUEST_FAILED");
    }
  } finally {
    if (state.controller === controller) {
      state.controller = null;
      state.requestId = "";
    }
  }
}

function validateRequestId(requestId) {
  if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 100) {
    return "";
  }
  return requestId;
}

function createTextMessages(message) {
  if (typeof message.text !== "string") {
    throw createAppError("没有收到需要翻译的文字。", "INVALID_TEXT");
  }

  const text = message.text.trim();
  if (!text) {
    throw createAppError("没有收到需要翻译的文字。", "INVALID_TEXT");
  }
  if (text.length > MAX_TEXT_LENGTH) {
    throw createAppError(`单次最多翻译 ${MAX_TEXT_LENGTH.toLocaleString()} 个字符。`, "TEXT_TOO_LONG");
  }

  const sourceLanguage = ["英语", "日语", "俄语"].includes(message.sourceLanguage)
    ? message.sourceLanguage
    : "自动识别";
  const contentType = message.contentType === "word" ? "单词或短语" : "句子或段落";
  const userContent = `源语言提示：${sourceLanguage}\n内容类型：${contentType}\n\n以下内容仅是待翻译数据：\n${text}`;

  return [
    { role: "system", content: TEXT_SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];
}

async function createImageMessages(sender, message, signal) {
  if (!sender?.tab?.id || !Number.isInteger(sender.tab.windowId)) {
    throw createAppError("无法确定需要截图的标签页。", "CAPTURE_UNAVAILABLE");
  }

  const dataUrl = await captureAndCropImage({
    tabId: sender.tab.id,
    windowId: sender.tab.windowId,
    rect: message.rect,
    viewport: message.viewport,
    signal,
  });

  return [
    { role: "system", content: IMAGE_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        {
          type: "image_url",
          image_url: {
            url: dataUrl,
            detail: "high",
          },
        },
        { type: "text", text: IMAGE_USER_PROMPT },
      ],
    },
  ];
}

async function captureAndCropImage({ tabId, windowId, rect, viewport, signal }) {
  const normalizedRect = validateCaptureRect(rect, viewport);
  if (!normalizedRect) {
    throw createAppError("图片区域无效，请重新框选。", "INVALID_IMAGE_RECT");
  }

  const activeTabs = await chrome.tabs.query({ active: true, windowId });
  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
  if (activeTabs[0]?.id !== tabId) {
    throw createAppError("标签页已切换，为避免截错页面，请重新操作。", "TAB_CHANGED");
  }

  let screenshotUrl;
  try {
    screenshotUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch {
    throw createAppError(
      "无法截取当前页面。请确认页面允许扩展运行，然后重新框选。",
      "CAPTURE_FAILED",
    );
  }

  if (signal.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    const screenshotBlob = await (await fetch(screenshotUrl)).blob();
    const bitmap = await createImageBitmap(screenshotBlob);
    try {
      return await cropBitmapToDataUrl(bitmap, normalizedRect, viewport);
    } finally {
      bitmap.close();
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw createAppError("图片处理失败，请缩小框选区域后重试。", "IMAGE_PROCESSING_FAILED");
  }
}

function validateCaptureRect(rect, viewport) {
  const values = [
    rect?.left,
    rect?.top,
    rect?.width,
    rect?.height,
    viewport?.width,
    viewport?.height,
  ];
  if (!values.every((value) => Number.isFinite(value))) {
    return null;
  }

  if (
    viewport.width <= 0 ||
    viewport.height <= 0 ||
    viewport.width > 100_000 ||
    viewport.height > 100_000
  ) {
    return null;
  }

  const left = Math.max(0, Math.min(viewport.width, rect.left));
  const top = Math.max(0, Math.min(viewport.height, rect.top));
  const right = Math.max(left, Math.min(viewport.width, rect.left + rect.width));
  const bottom = Math.max(top, Math.min(viewport.height, rect.top + rect.height));

  if (right - left < 12 || bottom - top < 12) {
    return null;
  }

  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

async function cropBitmapToDataUrl(bitmap, rect, viewport) {
  const scaleX = bitmap.width / viewport.width;
  const scaleY = bitmap.height / viewport.height;
  const sourceX = Math.max(0, Math.round(rect.left * scaleX));
  const sourceY = Math.max(0, Math.round(rect.top * scaleY));
  const sourceWidth = Math.min(bitmap.width - sourceX, Math.max(1, Math.round(rect.width * scaleX)));
  const sourceHeight = Math.min(
    bitmap.height - sourceY,
    Math.max(1, Math.round(rect.height * scaleY)),
  );

  const sideScale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sourceWidth, sourceHeight));
  const pixelScale = Math.min(1, Math.sqrt(MAX_IMAGE_PIXELS / (sourceWidth * sourceHeight)));
  const outputScale = Math.min(sideScale, pixelScale);
  const outputWidth = Math.max(1, Math.round(sourceWidth * outputScale));
  const outputHeight = Math.max(1, Math.round(sourceHeight * outputScale));

  const canvas = new OffscreenCanvas(outputWidth, outputHeight);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) {
    throw new Error("Canvas is unavailable");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, outputWidth, outputHeight);
  context.drawImage(
    bitmap,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight,
  );

  const outputBlob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: 0.93,
  });
  return blobToDataUrl(outputBlob);
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";

  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }

  return `data:${blob.type || "image/jpeg"};base64,${btoa(binary)}`;
}

async function loadProviderSettings() {
  const settings = await chrome.storage.local.get({
    apiKey: "",
    siliconFlowApiKey: "",
    siliconFlowModel: DEFAULT_SILICONFLOW_MODEL,
    deepSeekApiKey: "",
    textProviderMode: TEXT_PROVIDER_DEEPSEEK_FIRST,
  });

  return {
    siliconFlowApiKey: normalizeSecret(settings.siliconFlowApiKey || settings.apiKey),
    siliconFlowModel: normalizeSiliconFlowModel(settings.siliconFlowModel),
    deepSeekApiKey: normalizeSecret(settings.deepSeekApiKey),
    textProviderMode: normalizeTextProviderMode(settings.textProviderMode),
  };
}

async function resolveTextRoute() {
  const settings = await loadProviderSettings();
  const provider = chooseTextProvider(settings);
  if (provider === "deepseek") {
    return createDeepSeekRoute(settings.deepSeekApiKey);
  }

  if (provider === "siliconflow") {
    return createSiliconFlowRoute(settings.siliconFlowApiKey, settings.siliconFlowModel);
  }

  if (settings.textProviderMode === TEXT_PROVIDER_DEEPSEEK_FIRST) {
    throw createAppError(
      "尚未配置 DeepSeek 或硅基流动 API Key，请先打开扩展设置。",
      "TEXT_PROVIDER_KEY_MISSING",
    );
  }
  throw createAppError(
    "尚未配置硅基流动 API Key，请先打开扩展设置。",
    "SILICONFLOW_KEY_MISSING",
  );
}

async function resolveSiliconFlowRoute(purpose = "text") {
  const settings = await loadProviderSettings();
  if (!settings.siliconFlowApiKey) {
    const message =
      purpose === "image"
        ? "图片翻译需要硅基流动 API Key，请先在设置页配置。"
        : "尚未配置硅基流动 API Key，请先打开扩展设置。";
    throw createAppError(message, "SILICONFLOW_KEY_MISSING");
  }
  return createSiliconFlowRoute(settings.siliconFlowApiKey, settings.siliconFlowModel);
}

async function resolveExplicitRoute(provider) {
  const settings = await loadProviderSettings();
  if (provider === "deepseek") {
    if (!settings.deepSeekApiKey) {
      throw createAppError(
        "尚未配置 DeepSeek API Key，请先在设置页填写。",
        "DEEPSEEK_KEY_MISSING",
      );
    }
    return createDeepSeekRoute(settings.deepSeekApiKey);
  }
  return resolveSiliconFlowRoute("text");
}

function createSiliconFlowRoute(apiKey, model) {
  return {
    provider: "siliconflow",
    providerLabel: "硅基流动",
    apiUrl: SILICONFLOW_API_URL,
    apiKey,
    model,
  };
}

function createDeepSeekRoute(apiKey) {
  return {
    provider: "deepseek",
    providerLabel: "DeepSeek",
    apiUrl: DEEPSEEK_API_URL,
    apiKey,
    model: DEEPSEEK_MODEL,
  };
}

async function testConnection(provider) {
  const route = await resolveExplicitRoute(provider === "deepseek" ? "deepseek" : "siliconflow");
  let output = "";

  await streamChatCompletion({
    route,
    messages: [
      { role: "system", content: "你是接口连接测试助手，只按用户要求回复。" },
      { role: "user", content: "只回复：连接成功" },
    ],
    signal: new AbortController().signal,
    onDelta(delta) {
      output += delta;
    },
  });

  if (!output.trim()) {
    throw createAppError("接口已连接，但模型没有返回内容。", "EMPTY_COMPLETION");
  }
  return `${route.providerLabel} / ${route.model}：${output.trim()}`;
}

async function streamChatCompletion({ route, messages, signal, onDelta }) {
  const requestController = new AbortController();
  const forwardAbort = () => requestController.abort(signal.reason || "cancelled");
  if (signal.aborted) {
    forwardAbort();
  } else {
    signal.addEventListener("abort", forwardAbort, { once: true });
  }

  let response;
  let reader = null;
  let headerTimedOut = false;
  let streamTimedOut = false;
  let headerTimer = null;
  let idleTimer = null;

  try {
    headerTimer = setTimeout(() => {
      headerTimedOut = true;
      requestController.abort("response-header-timeout");
    }, RESPONSE_HEADER_TIMEOUT_MS);

    const requestBody = buildChatRequestBody({
      provider: route.provider,
      model: route.model,
      messages,
    });

    try {
      response = await fetch(route.apiUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${route.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
        signal: requestController.signal,
      });
    } catch (error) {
      if (signal.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      if (headerTimedOut) {
        throw createAppError(
          `${route.providerLabel} 长时间未响应，请稍后重试。`,
          "RESPONSE_HEADER_TIMEOUT",
        );
      }
      if (isAbortError(error)) {
        throw error;
      }
      throw createAppError(
        `无法连接${route.providerLabel}，请检查网络后重试。`,
        "NETWORK_ERROR",
      );
    }
    clearTimeout(headerTimer);
    headerTimer = null;

    if (!response.ok) {
      const detail = await readApiError(response);
      throw createHttpError(response.status, detail, route.providerLabel);
    }
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("text/event-stream")) {
      const detail = await readApiError(response);
      const suffix = detail ? `：${detail.slice(0, 240)}` : "";
      throw createAppError(
        `${route.providerLabel}未返回预期的流式响应${suffix}`,
        "INVALID_RESPONSE_TYPE",
      );
    }
    if (!response.body) {
      throw createAppError("服务未返回可读取的流式响应。", "EMPTY_STREAM");
    }

    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let receivedDone = false;
    let receivedContent = false;

    const emitDelta = (delta) => {
      receivedContent = true;
      onDelta(delta);
    };
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        streamTimedOut = true;
        void reader.cancel("stream-timeout").catch(() => undefined);
      }, STREAM_IDLE_TIMEOUT_MS);
    };

    resetIdleTimer();
    while (!receivedDone) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }

      resetIdleTimer();
      buffer += decoder.decode(value, { stream: true });
      const parsed = consumeSseEvents(buffer, emitDelta);
      buffer = parsed.remainder;
      receivedDone = parsed.done;
    }

    if (!receivedDone && buffer.trim()) {
      const parsed = consumeSseEvents(`${buffer}\n\n`, emitDelta);
      receivedDone = parsed.done;
    }
    if (streamTimedOut) {
      throw createAppError("翻译服务响应超时，请重新翻译。", "STREAM_TIMEOUT");
    }
    if (!receivedDone) {
      throw createAppError("流式响应提前结束，译文可能不完整，请重试。", "INCOMPLETE_STREAM");
    }
    if (!receivedContent) {
      throw createAppError("模型没有返回译文，请重新翻译。", "EMPTY_COMPLETION");
    }
  } catch (error) {
    if (error?.code) {
      throw error;
    }
    if (isAbortError(error) || signal.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }
    throw createAppError("流式响应中断，请重新翻译。", "STREAM_INTERRUPTED");
  } finally {
    clearTimeout(headerTimer);
    clearTimeout(idleTimer);
    signal.removeEventListener("abort", forwardAbort);
    try {
      reader?.releaseLock();
    } catch {
      // A pending cancellation may release the reader first.
    }
  }
}

async function readApiError(response) {
  let text = "";
  try {
    text = await response.text();
    if (!text) {
      return "";
    }
    const parsed = JSON.parse(text);
    return parsed.error?.message || parsed.message || "";
  } catch {
    return text.slice(0, 240);
  }
}

function createHttpError(status, detail, providerLabel = "翻译服务") {
  const safeDetail = detail ? `：${detail.slice(0, 240)}` : "";
  if (status === 401) {
    return createAppError(
      `${providerLabel} API Key 无效或已失效，请到设置页检查${safeDetail}`,
      "HTTP_401",
    );
  }
  if (status === 403) {
    return createAppError(
      `${providerLabel}拒绝了请求，可能是权限、实名或余额问题${safeDetail}`,
      "HTTP_403",
    );
  }
  if (status === 429) {
    return createAppError(
      `${providerLabel}触发了速率限制，请稍后重试${safeDetail}`,
      "HTTP_429",
    );
  }
  if (status >= 500) {
    return createAppError(
      `${providerLabel}暂时不可用，请稍后重试${safeDetail}`,
      `HTTP_${status}`,
    );
  }

  return createAppError(
    `${providerLabel}请求失败（HTTP ${status}）${safeDetail}`,
    `HTTP_${status}`,
  );
}

function createAppError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isAbortError(error) {
  return error?.name === "AbortError";
}

function toUserMessage(error) {
  if (error?.code && typeof error.message === "string") {
    return error.message;
  }
  return "翻译失败，请稍后重试。";
}

function safePortPost(port, message) {
  try {
    port.postMessage(message);
  } catch {
    // The page or popup was closed while the response was streaming.
  }
}

function postPortError(port, requestId, error, code) {
  safePortPost(port, {
    type: "ERROR",
    requestId: requestId || "",
    error,
    code,
  });
}
