import { createPdfTextBatchMessages } from "../shared/pdf-prompts.js";

export const PDF_JOB_LIMITS = Object.freeze({
  maxPages: 500,
  maxConcurrentJobs: 4,
  maxBatchesPerJob: 2_000,
  maxQueuedBatchesPerJob: 64,
  maxJobCharacters: 10_000_000,
  maxJobUtf8Bytes: 32 * 1_024 * 1_024,
  maxBatchCharacters: 20_000,
  maxBatchUtf8Bytes: 80 * 1_024,
  maxBlocksPerBatch: 1,
  maxResponseCharacters: 1_000_000,
  maxIdentifierLength: 100,
});

const TEXT_CONCURRENCY_PER_JOB = 10;
const PROGRESS_THROTTLE_MS = 64;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/iu;
const encoder = new TextEncoder();

export function createPdfJobManager({ resolveTextRoute, streamChatCompletion }) {
  if (typeof resolveTextRoute !== "function" || typeof streamChatCompletion !== "function") {
    throw new TypeError("PDF 任务管理器缺少路由或流式请求实现。");
  }

  const jobs = new Map();

  function connect(port) {
    if (
      !port ||
      typeof port.postMessage !== "function" ||
      typeof port.onMessage?.addListener !== "function" ||
      typeof port.onDisconnect?.addListener !== "function"
    ) {
      throw new TypeError("PDF 任务端口无效。");
    }

    const connection = {
      port,
      connected: true,
      jobIds: new Set(),
    };

    const onMessage = (message) => {
      void handleMessage(connection, message);
    };
    const onDisconnect = () => {
      disconnect(connection);
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);

    return Object.freeze({
      disconnect: onDisconnect,
    });
  }

  async function handleMessage(connection, message) {
    if (!connection.connected) {
      return;
    }
    if (!isRecord(message) || typeof message.type !== "string") {
      postJobError(connection, "", createManagerError("无效的 PDF 任务请求。", "INVALID_REQUEST"));
      return;
    }

    switch (message.type) {
      case "CREATE_PDF_JOB":
        await createJob(connection, message);
        break;
      case "TRANSLATE_TEXT_BATCH":
        enqueueTextBatch(connection, message);
        break;
      case "CANCEL_BATCH":
        cancelBatch(connection, message);
        break;
      case "CANCEL_JOB":
        cancelJobFromMessage(connection, message);
        break;
      case "KEEPALIVE":
        keepAlive(connection, message);
        break;
      default:
        postJobError(
          connection,
          safeIdentifier(message.jobId),
          createManagerError("不支持的 PDF 任务请求。", "INVALID_REQUEST"),
        );
    }
  }

  async function createJob(connection, message) {
    let details;
    try {
      details = validateCreateJob(message);
    } catch (error) {
      postJobError(connection, safeIdentifier(message.jobId), error);
      return;
    }

    if (jobs.has(details.jobId)) {
      postJobError(
        connection,
        details.jobId,
        createManagerError("PDF 任务标识已存在。", "JOB_ALREADY_EXISTS"),
      );
      return;
    }
    if (connection.jobIds.size >= 1) {
      postJobError(
        connection,
        details.jobId,
        createManagerError("每个 PDF 工作台连接只能运行一个任务。", "CONNECTION_JOB_LIMIT"),
      );
      return;
    }
    if (jobs.size >= PDF_JOB_LIMITS.maxConcurrentJobs) {
      postJobError(
        connection,
        details.jobId,
        createManagerError("同时运行的 PDF 任务过多，请稍后重试。", "PDF_JOB_CAPACITY_REACHED"),
      );
      return;
    }

    const job = {
      ...details,
      connection,
      status: "active",
      activeTextCount: 0,
      acceptedBatchCount: 0,
      acceptedCharacters: 0,
      acceptedUtf8Bytes: 0,
      queuedTextCount: 0,
      batches: new Map(),
      seenBatchIds: new Set(),
      queue: [],
    };
    jobs.set(job.jobId, job);
    connection.jobIds.add(job.jobId);

    safePost(connection, {
      type: "JOB_CREATED",
      jobId: job.jobId,
      dynamicRoute: true,
    });
  }

  function enqueueTextBatch(connection, message) {
    let jobId = "";
    let batchId = "";
    let job = null;
    try {
      jobId = validateIdentifier(message.jobId, "JOB_ID_INVALID");
      batchId = validateIdentifier(message.batchId, "BATCH_ID_INVALID");
      job = requireOwnedJob(connection, jobId);
      if (job.seenBatchIds.has(batchId)) {
        throw createManagerError("页面任务标识已存在。", "BATCH_ALREADY_EXISTS");
      }

      const validated = validateBlocks(message.blocks);
      assertJobCanAcceptBatch(job, validated);
      const batch = {
        batchId,
        blocks: validated.blocks,
        status: "queued",
        controller: null,
      };
      job.acceptedBatchCount += 1;
      job.acceptedCharacters += validated.characterCount;
      job.acceptedUtf8Bytes += validated.utf8Bytes;
      job.queuedTextCount += 1;
      job.seenBatchIds.add(batchId);
      job.batches.set(batchId, batch);
      job.queue.push(batchId);
      pumpTextQueue(job);
    } catch (error) {
      postBatchError(
        connection,
        jobId || safeIdentifier(message.jobId),
        batchId || safeIdentifier(message.batchId),
        error,
        undefined,
      );
    }
  }

  function pumpTextQueue(job) {
    while (
      job.status === "active" &&
      job.connection.connected &&
      job.activeTextCount < TEXT_CONCURRENCY_PER_JOB &&
      job.queue.length > 0
    ) {
      const batchId = job.queue.shift();
      const batch = job.batches.get(batchId);
      if (!batch || batch.status !== "queued") {
        continue;
      }
      job.queuedTextCount = Math.max(0, job.queuedTextCount - 1);
      startTextBatch(job, batch);
    }
  }

  function startTextBatch(job, batch) {
    const controller = new AbortController();
    batch.status = "active";
    batch.controller = controller;
    job.activeTextCount += 1;

    void runTextBatch(job, batch, controller);
  }

  async function runTextBatch(job, batch, controller) {
    let output = "";
    let progressTimer = null;
    let route = null;
    const inputIds = batch.blocks.map(({ id }) => id);
    const messages = createPdfTextBatchMessages(batch.blocks);
    const pageId = inputIds[0];
    let lastProgressLength = 0;
    const flushProgress = () => {
      progressTimer = null;
      if (!isCurrentActiveBatch(job, batch, controller)) {
        return;
      }
      if (output.length > lastProgressLength) {
        lastProgressLength = output.length;
        safePost(job.connection, {
          type: "BATCH_PROGRESS",
          jobId: job.jobId,
          batchId: batch.batchId,
          translations: [{ id: pageId, target: output }],
        });
      }
    };
    const scheduleProgress = () => {
      if (progressTimer === null) {
        progressTimer = setTimeout(flushProgress, PROGRESS_THROTTLE_MS);
      }
    };
    try {
      route = snapshotRoute(await resolveTextRoute());
      if (!isCurrentActiveBatch(job, batch, controller)) {
        return;
      }
      safePost(job.connection, {
        type: "BATCH_STARTED",
        jobId: job.jobId,
        batchId: batch.batchId,
        providerLabel: route.providerLabel,
        model: route.model,
      });
      await streamChatCompletion({
        route,
        messages,
        signal: controller.signal,
        requestKind: "text",
        onDelta(delta) {
          if (!isCurrentActiveBatch(job, batch, controller) || typeof delta !== "string" || !delta) {
            return;
          }
          if (output.length + delta.length > PDF_JOB_LIMITS.maxResponseCharacters) {
            throw createManagerError(
              "翻译服务返回内容异常过长，已停止当前页面翻译。",
              "BATCH_OUTPUT_TOO_LARGE",
            );
          }
          output += delta;
          scheduleProgress();
        },
      });

      if (!isCurrentActiveBatch(job, batch, controller)) {
        return;
      }

      const target = output.trim();
      if (!target) {
        throw createManagerError("翻译服务未返回整页译文。", "EMPTY_PAGE_RESPONSE");
      }
      finishBatch(job, batch, "completed");
      safePost(job.connection, {
        type: "BATCH_DONE",
        jobId: job.jobId,
        batchId: batch.batchId,
        translations: [{ id: pageId, target }],
      });
    } catch (error) {
      if (!isCurrentActiveBatch(job, batch, controller)) {
        return;
      }
      finishBatch(job, batch, "failed");
      postBatchError(
        job.connection,
        job.jobId,
        batch.batchId,
        error,
        route?.providerLabel,
      );
    } finally {
      clearTimeout(progressTimer);
      if (batch.controller === controller) {
        batch.controller = null;
        job.activeTextCount = Math.max(0, job.activeTextCount - 1);
      }
      pumpTextQueue(job);
    }
  }

  function cancelBatch(connection, message) {
    let jobId = "";
    let batchId = "";
    let job = null;
    try {
      jobId = validateIdentifier(message.jobId, "JOB_ID_INVALID");
      batchId = validateIdentifier(message.batchId, "BATCH_ID_INVALID");
      job = requireOwnedJob(connection, jobId);
      const batch = job.batches.get(batchId);

      // Cancellation is idempotent; late cancellation messages have no effect.
      if (!batch || batch.status === "completed" || batch.status === "failed" || batch.status === "cancelled") {
        return;
      }

      const controller = batch.controller;
      finishBatch(job, batch, "cancelled");
      controller?.abort("cancelled-by-user");
      safePost(connection, {
        type: "BATCH_CANCELLED",
        jobId,
        batchId,
      });
      pumpTextQueue(job);
    } catch (error) {
      postBatchError(
        connection,
        jobId || safeIdentifier(message.jobId),
        batchId || safeIdentifier(message.batchId),
        error,
        undefined,
      );
    }
  }

  function cancelJobFromMessage(connection, message) {
    let jobId = "";
    try {
      jobId = validateIdentifier(message.jobId, "JOB_ID_INVALID");
    } catch (error) {
      postJobError(connection, safeIdentifier(message.jobId), error);
      return;
    }

    let job;
    try {
      job = requireOwnedJob(connection, jobId);
    } catch (error) {
      postJobError(connection, jobId, error);
      return;
    }

    cancelWholeJob(job, true);
  }

  function keepAlive(connection, message) {
    let jobId = "";
    try {
      jobId = validateIdentifier(message.jobId, "JOB_ID_INVALID");
      requireOwnedJob(connection, jobId);
      safePost(connection, {
        type: "KEEPALIVE_ACK",
        jobId,
      });
    } catch (error) {
      postJobError(connection, jobId || safeIdentifier(message.jobId), error);
    }
  }

  function cancelWholeJob(job, notify) {
    if (job.status !== "active") {
      return;
    }
    job.status = "cancelled";
    jobs.delete(job.jobId);
    job.connection.jobIds.delete(job.jobId);
    job.queue.length = 0;

    for (const batch of job.batches.values()) {
      if (batch.status !== "queued" && batch.status !== "active") {
        continue;
      }
      const controller = batch.controller;
      finishBatch(job, batch, "cancelled");
      controller?.abort("job-cancelled");
      if (notify) {
        safePost(job.connection, {
          type: "BATCH_CANCELLED",
          jobId: job.jobId,
          batchId: batch.batchId,
        });
      }
    }

    if (notify) {
      safePost(job.connection, { type: "JOB_CANCELLED", jobId: job.jobId });
    }
  }

  function disconnect(connection) {
    if (!connection.connected) {
      return;
    }
    connection.connected = false;

    for (const jobId of [...connection.jobIds]) {
      const job = jobs.get(jobId);
      if (job?.connection === connection) {
        cancelWholeJob(job, false);
      }
    }
    connection.jobIds.clear();
  }

  function requireOwnedJob(connection, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "active" || job.connection !== connection) {
      throw createManagerError("PDF 任务不存在或已结束。", "JOB_NOT_FOUND");
    }
    return job;
  }

  function isCurrentActiveBatch(job, batch, controller) {
    return (
      job.status === "active" &&
      jobs.get(job.jobId) === job &&
      job.connection.connected &&
      batch.status === "active" &&
      batch.controller === controller &&
      !controller.signal.aborted
    );
  }

  function assertJobCanAcceptBatch(job, validated) {
    if (job.acceptedBatchCount >= PDF_JOB_LIMITS.maxBatchesPerJob) {
      throw createManagerError("PDF 页面任务数超过限制。", "JOB_BATCH_LIMIT");
    }
    if (job.queuedTextCount >= PDF_JOB_LIMITS.maxQueuedBatchesPerJob) {
      throw createManagerError("PDF 待翻译队列已满，请等待当前页面完成。", "JOB_QUEUE_FULL");
    }
    if (job.acceptedCharacters + validated.characterCount > PDF_JOB_LIMITS.maxJobCharacters) {
      throw createManagerError("PDF 任务累计文本字符数超过限制。", "JOB_TEXT_TOO_LONG");
    }
    if (job.acceptedUtf8Bytes + validated.utf8Bytes > PDF_JOB_LIMITS.maxJobUtf8Bytes) {
      throw createManagerError("PDF 任务累计文本 UTF-8 字节数超过限制。", "JOB_UTF8_TOO_LARGE");
    }
  }

  function finishBatch(job, batch, status) {
    if (batch.status === "queued") {
      job.queuedTextCount = Math.max(0, job.queuedTextCount - 1);
    }
    batch.status = status;
    batch.blocks = null;
    if (job.batches.get(batch.batchId) === batch) {
      job.batches.delete(batch.batchId);
    }
  }

  return Object.freeze({ connect });
}

export function parsePdfTextBatchResult(value, inputIds) {
  if (typeof value !== "string") {
    throw createManagerError("翻译服务返回的数据格式无效。", "INVALID_BATCH_RESPONSE");
  }

  let json = value.trim();
  if (json.startsWith("```")) {
    const fenced = json.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu);
    if (!fenced) {
      throw createManagerError("翻译服务返回了无效的 JSON 代码围栏。", "INVALID_BATCH_RESPONSE");
    }
    json = fenced[1].trim();
  }

  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw createManagerError("翻译服务返回的 JSON 无法解析。", "INVALID_BATCH_RESPONSE");
  }

  if (!Array.isArray(parsed) || !Array.isArray(inputIds) || parsed.length !== inputIds.length) {
    throw createManagerError("整页翻译结果结构不完整。", "INVALID_BATCH_RESPONSE");
  }

  const expectedIds = new Set(inputIds);
  if (expectedIds.size !== inputIds.length) {
    throw createManagerError("页面翻译标识重复。", "INVALID_BATCH_RESPONSE");
  }

  const returnedIds = new Set();
  const translations = parsed.map((entry) => {
    if (!isRecord(entry) || Object.keys(entry).length !== 2 || !("id" in entry) || !("target" in entry)) {
      throw createManagerError("翻译结果元素结构无效。", "INVALID_BATCH_RESPONSE");
    }
    if (
      typeof entry.id !== "string" ||
      typeof entry.target !== "string" ||
      !entry.target.trim() ||
      !expectedIds.has(entry.id) ||
      returnedIds.has(entry.id)
    ) {
      throw createManagerError("整页翻译结果包含无效的页面标识。", "INVALID_BATCH_RESPONSE");
    }
    returnedIds.add(entry.id);
    return { id: entry.id, target: entry.target };
  });

  if (returnedIds.size !== expectedIds.size) {
    throw createManagerError("整页翻译结果缺少页面标识。", "INVALID_BATCH_RESPONSE");
  }
  return translations;
}

/**
 * Conservatively extracts safe translation progress from an incomplete JSON
 * response. Only IDs from the current input batch are ever returned; the final
 * response still goes through parsePdfTextBatchResult's strict validation.
 */
export function parsePdfTextBatchProgress(value, inputIds) {
  if (typeof value !== "string" || !Array.isArray(inputIds)) {
    return [];
  }
  const expectedIds = new Set(inputIds);
  if (expectedIds.size !== inputIds.length || inputIds.some((id) => typeof id !== "string")) {
    return [];
  }

  let index = skipJsonWhitespace(value, 0);
  if (value.startsWith("```", index)) {
    index += 3;
    if (value.slice(index, index + 4).toLowerCase() === "json") {
      index += 4;
    }
    index = skipJsonWhitespace(value, index);
  }
  if (value[index] !== "[") {
    return [];
  }
  index += 1;

  const translations = [];
  const returnedIds = new Set();
  while (index < value.length) {
    index = skipJsonWhitespace(value, index);
    if (value[index] === "]") {
      break;
    }
    if (value[index] !== "{") {
      break;
    }

    const parsed = readProgressObject(value, index, expectedIds);
    const translation = parsed.translation;
    if (
      translation
      && !returnedIds.has(translation.id)
      && typeof translation.target === "string"
      && translation.target.length > 0
    ) {
      returnedIds.add(translation.id);
      translations.push(translation);
    }
    if (!parsed.complete) {
      break;
    }

    index = skipJsonWhitespace(value, parsed.end);
    if (value[index] === ",") {
      index += 1;
      continue;
    }
    if (value[index] === "]") {
      break;
    }
    break;
  }
  return translations;
}

function readProgressObject(source, start, expectedIds) {
  let index = start + 1;
  let id;
  let target;
  let fieldCount = 0;
  let safeShape = true;
  const fieldNames = new Set();

  const currentTranslation = () => (
    safeShape && expectedIds.has(id) && typeof target === "string"
      ? { id, target }
      : null
  );

  while (index < source.length) {
    index = skipJsonWhitespace(source, index);
    if (source[index] === "}") {
      const exactShape = safeShape
        && fieldCount === 2
        && fieldNames.has("id")
        && fieldNames.has("target");
      return {
        complete: true,
        end: index + 1,
        translation: exactShape ? currentTranslation() : null,
      };
    }

    const keyResult = readJsonStringProgress(source, index);
    if (!keyResult.valid || !keyResult.complete) {
      return { complete: false, end: source.length, translation: currentTranslation() };
    }
    const key = keyResult.value;
    index = skipJsonWhitespace(source, keyResult.end);
    if (source[index] !== ":") {
      return { complete: false, end: source.length, translation: currentTranslation() };
    }
    index = skipJsonWhitespace(source, index + 1);

    const valueResult = readJsonStringProgress(source, index);
    if (!valueResult.valid) {
      return { complete: false, end: source.length, translation: currentTranslation() };
    }
    if (fieldNames.has(key)) {
      safeShape = false;
    }
    fieldNames.add(key);
    fieldCount += 1;
    if (key === "id" && valueResult.complete) {
      id = valueResult.value;
    } else if (key === "target") {
      target = valueResult.value;
    } else if (key !== "id") {
      safeShape = false;
    }

    if (!valueResult.complete) {
      return { complete: false, end: source.length, translation: currentTranslation() };
    }
    index = skipJsonWhitespace(source, valueResult.end);
    if (source[index] === ",") {
      index += 1;
      continue;
    }
    if (source[index] === "}") {
      continue;
    }
    return { complete: false, end: source.length, translation: currentTranslation() };
  }
  return { complete: false, end: source.length, translation: currentTranslation() };
}

function readJsonStringProgress(source, start) {
  if (source[start] !== "\"") {
    return { valid: false, complete: false, value: "", end: start };
  }
  let value = "";
  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === "\"") {
      return { valid: true, complete: true, value, end: index + 1 };
    }
    if (character === "\\") {
      if (index + 1 >= source.length) {
        return { valid: true, complete: false, value, end: source.length };
      }
      const escape = source[index + 1];
      const simpleEscapes = {
        "\"": "\"",
        "\\": "\\",
        "/": "/",
        b: "\b",
        f: "\f",
        n: "\n",
        r: "\r",
        t: "\t",
      };
      if (escape in simpleEscapes) {
        value += simpleEscapes[escape];
        index += 2;
        continue;
      }
      if (escape !== "u") {
        return { valid: false, complete: false, value, end: index };
      }
      const firstHex = source.slice(index + 2, index + 6);
      if (firstHex.length < 4) {
        return /^[0-9a-f]*$/iu.test(firstHex)
          ? { valid: true, complete: false, value, end: source.length }
          : { valid: false, complete: false, value, end: index };
      }
      if (!/^[0-9a-f]{4}$/iu.test(firstHex)) {
        return { valid: false, complete: false, value, end: index };
      }
      const firstCodeUnit = Number.parseInt(firstHex, 16);
      index += 6;
      if (firstCodeUnit >= 0xd800 && firstCodeUnit <= 0xdbff) {
        if (index >= source.length) {
          return { valid: true, complete: false, value, end: source.length };
        }
        if (source[index] === "\\" && index + 1 >= source.length) {
          return { valid: true, complete: false, value, end: source.length };
        }
        if (source[index] === "\\" && source[index + 1] === "u") {
          const secondHex = source.slice(index + 2, index + 6);
          if (secondHex.length < 4) {
            return /^[0-9a-f]*$/iu.test(secondHex)
              ? { valid: true, complete: false, value, end: source.length }
              : { valid: false, complete: false, value, end: index };
          }
          if (/^[0-9a-f]{4}$/iu.test(secondHex)) {
            const secondCodeUnit = Number.parseInt(secondHex, 16);
            if (secondCodeUnit >= 0xdc00 && secondCodeUnit <= 0xdfff) {
              value += String.fromCharCode(firstCodeUnit, secondCodeUnit);
              index += 6;
              continue;
            }
          }
        }
      }
      value += String.fromCharCode(firstCodeUnit);
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      return { valid: false, complete: false, value, end: index };
    }
    const codeUnit = character.charCodeAt(0);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 >= source.length) {
      return { valid: true, complete: false, value, end: source.length };
    }
    value += character;
    index += 1;
  }
  return { valid: true, complete: false, value, end: source.length };
}

function skipJsonWhitespace(value, start) {
  let index = start;
  while (index < value.length && /\s/u.test(value[index])) {
    index += 1;
  }
  return index;
}

function validateCreateJob(message) {
  const jobId = validateIdentifier(message.jobId, "JOB_ID_INVALID");
  if (typeof message.fingerprint !== "string" || !FINGERPRINT_PATTERN.test(message.fingerprint)) {
    throw createManagerError("PDF 文件指纹无效。", "FINGERPRINT_INVALID");
  }
  if (
    !Number.isInteger(message.pageCount) ||
    message.pageCount < 1 ||
    message.pageCount > PDF_JOB_LIMITS.maxPages
  ) {
    throw createManagerError("PDF 页数无效或超过限制。", "PAGE_COUNT_INVALID");
  }

  return Object.freeze({
    jobId,
    fingerprint: message.fingerprint.toLowerCase(),
    pageCount: message.pageCount,
  });
}

function validateBlocks(blocks) {
  if (
    !Array.isArray(blocks)
    || blocks.length === 0
    || blocks.length > PDF_JOB_LIMITS.maxBlocksPerBatch
  ) {
    throw createManagerError(
      "每次页面翻译必须包含一份整页文字。",
      "BLOCKS_INVALID",
    );
  }

  const ids = new Set();
  const normalized = [];
  let characterCount = 0;
  let utf8Bytes = 0;

  for (const block of blocks) {
    if (!isRecord(block)) {
      throw createManagerError("整页文字格式无效。", "BLOCKS_INVALID");
    }
    const id = validateIdentifier(block.id, "BLOCK_ID_INVALID");
    if (ids.has(id)) {
      throw createManagerError("页面标识不能重复。", "DUPLICATE_BLOCK_ID");
    }
    if (typeof block.text !== "string" || !block.text.trim()) {
      throw createManagerError("整页文字不能为空。", "BLOCK_TEXT_INVALID");
    }

    ids.add(id);
    characterCount += countCodePoints(block.text);
    utf8Bytes += encoder.encode(block.text).byteLength;
    if (characterCount > PDF_JOB_LIMITS.maxBatchCharacters) {
      throw createManagerError(
        `整页文字超过 ${PDF_JOB_LIMITS.maxBatchCharacters.toLocaleString("en-US")} 个字符。`,
        "BATCH_TEXT_TOO_LONG",
      );
    }
    if (utf8Bytes > PDF_JOB_LIMITS.maxBatchUtf8Bytes) {
      throw createManagerError("整页文字超过 UTF-8 字节限制。", "BATCH_UTF8_TOO_LARGE");
    }

    normalized.push(Object.freeze({ id, text: block.text }));
  }

  return Object.freeze({
    blocks: Object.freeze(normalized),
    characterCount,
    utf8Bytes,
  });
}

function countCodePoints(value) {
  let count = 0;
  for (const _character of value) {
    count += 1;
  }
  return count;
}

function validateIdentifier(value, code) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > PDF_JOB_LIMITS.maxIdentifierLength ||
    !IDENTIFIER_PATTERN.test(value)
  ) {
    throw createManagerError("任务或页面标识无效。", code);
  }
  return value;
}

function safeIdentifier(value) {
  try {
    return validateIdentifier(value, "IDENTIFIER_INVALID");
  } catch {
    return "";
  }
}

function snapshotRoute(route) {
  if (
    !isRecord(route) ||
    typeof route.provider !== "string" ||
    !route.provider ||
    typeof route.providerLabel !== "string" ||
    !route.providerLabel.trim() ||
    typeof route.model !== "string" ||
    !route.model.trim()
  ) {
    throw createManagerError("当前文本翻译路由无效。", "INVALID_TEXT_ROUTE");
  }
  return Object.freeze({ ...route });
}

function postJobError(connection, jobId, error, providerLabel) {
  safePost(connection, {
    type: "JOB_ERROR",
    jobId: jobId || "",
    error: toErrorMessage(error),
    code: toErrorCode(error),
    providerLabel: normalizeProviderLabel(providerLabel || error?.providerLabel),
    retryable: isRetryableError(error),
  });
}

function postBatchError(connection, jobId, batchId, error, providerLabel) {
  safePost(connection, {
    type: "BATCH_ERROR",
    jobId: jobId || "",
    batchId: batchId || "",
    error: toErrorMessage(error),
    code: toErrorCode(error),
    providerLabel: normalizeProviderLabel(providerLabel || error?.providerLabel),
    retryable: isRetryableError(error),
  });
}

function isRetryableError(error) {
  const status = Number(error?.status ?? error?.httpStatus);
  if (status === 429 || (status >= 500 && status <= 599)) {
    return true;
  }
  return /^HTTP_(?:429|5\d\d)$/u.test(toErrorCode(error));
}

function toErrorCode(error) {
  return typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
    ? error.code
    : "PDF_JOB_FAILED";
}

function toErrorMessage(error) {
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message.slice(0, 500);
  }
  return "PDF 翻译失败，请重试。";
}

function normalizeProviderLabel(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : "翻译服务";
}

function safePost(connection, message) {
  if (!connection.connected) {
    return;
  }
  try {
    connection.port.postMessage(message);
  } catch {
    // The workbench closed while an asynchronous result was being delivered.
  }
}

function createManagerError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
