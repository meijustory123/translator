import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const background = readFileSync(resolve(extensionRoot, "background/service-worker.js"), "utf8");
const content = readFileSync(resolve(extensionRoot, "content/content.js"), "utf8");

test("图片翻译公开完整的可诊断阶段", () => {
  for (const phase of [
    "SCREENSHOT_CAPTURED",
    "IMAGE_PREPARED",
    "REQUEST_SENT",
    "RESPONSE_STARTED",
    "STREAMING",
  ]) {
    assert.match(background, new RegExp(`onProgress\\(["']${phase}["']`, "u"));
    assert.match(content, new RegExp(`${phase}:`, "u"));
  }
});

test("流超时按有效译文推进且直接中止底层请求", () => {
  const streamFunction = background.slice(
    background.indexOf("async function streamChatCompletion"),
    background.indexOf("async function readApiError"),
  );

  assert.match(streamFunction, /FIRST_CONTENT_TIMEOUT_MS/u);
  assert.match(streamFunction, /REQUEST_TOTAL_TIMEOUT_MS/u);
  assert.match(streamFunction, /requestController\.abort\("stream-idle-timeout"\)/u);
  assert.match(streamFunction, /onDelta\(delta\);\s*resetIdleTimer\(\);/u);
  assert.doesNotMatch(streamFunction, /while \(!receivedDone\)[\s\S]*?resetIdleTimer\(\);\s*buffer \+=/u);
});

test("错误响应和图片请求都有独立硬兜底", () => {
  assert.match(background, /MAX_ERROR_BODY_BYTES = 64 \* 1_024/u);
  assert.match(background, /ERROR_BODY_TIMEOUT_MS = 10_000/u);
  assert.match(background, /IMAGE_PROCESSING_TIMEOUT_MS = 20_000/u);
  assert.match(content, /IMAGE_REQUEST_WATCHDOG_MS = 195_000/u);
  assert.match(content, /CLIENT_REQUEST_TIMEOUT/u);
});

test("只有用户取消或端口断开造成的外层中止才保持静默", () => {
  const portHandler = background.slice(
    background.indexOf("async function handlePortMessage"),
    background.indexOf("function validateRequestId"),
  );
  assert.match(portHandler, /else if \(!controller\.signal\.aborted\)/u);
  assert.doesNotMatch(portHandler, /if \(!isAbortError\(error\)\)/u);
  assert.match(portHandler, /REQUEST_TOTAL_TIMEOUT/u);
});

test("翻译进行中不会被页面滚动静默取消", () => {
  const scrollHandler = content.slice(
    content.indexOf("function hidePanelWhileScrolling"),
    content.indexOf("function centerAnchor"),
  );
  assert.match(scrollHandler, /if \(activeRequest\) \{\s*return;/u);
});
