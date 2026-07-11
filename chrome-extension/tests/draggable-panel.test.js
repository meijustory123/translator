import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const content = readFileSync(resolve(extensionRoot, "content/content.js"), "utf8");

test("拖动位置会被限制在视口四边内", () => {
  const clamp = loadClampFunction({ innerWidth: 1_000, innerHeight: 700 });
  const bounds = { width: 300, height: 200 };

  assert.deepEqual({ ...clamp(-100, -50, bounds, 12) }, { left: 12, top: 12 });
  assert.deepEqual({ ...clamp(2_000, 1_500, bounds, 12) }, { left: 688, top: 488 });
  assert.deepEqual({ ...clamp(240, 160, bounds, 12) }, { left: 240, top: 160 });
});

test("小视口下仍至少保留固定边距", () => {
  const clamp = loadClampFunction({ innerWidth: 320, innerHeight: 240 });
  assert.deepEqual(
    { ...clamp(200, 100, { width: 310, height: 230 }, 12) },
    { left: 12, top: 12 },
  );
});

test("标题栏拖动排除操作按钮并覆盖所有 Pointer 终态", () => {
  assert.match(content, /event\.composedPath\(\)\.includes\(actions\)/u);
  assert.match(content, /event\.button !== 0/u);
  assert.match(content, /event\.isPrimary === false/u);
  assert.match(content, /setPointerCapture\(event\.pointerId\)/u);
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    assert.match(content, new RegExp(`addEventListener\\(["']${eventName}["']`, "u"));
  }
});

test("手动位置在流式刷新和窗口缩放时保持并重新夹紧", () => {
  const positionFunction = content.slice(
    content.indexOf("function positionPanel"),
    content.indexOf("function clampPanelPosition"),
  );
  assert.match(positionFunction, /if \(manualPanelPosition\)/u);
  assert.match(positionFunction, /clampPanelPosition/u);
  assert.match(content, /cursor: grab/u);
  assert.match(content, /cursor: grabbing/u);
  assert.match(content, /touch-action: none/u);
  assert.match(content, /ui\.cancelPanelDrag\?\.\(\)/u);
});

function loadClampFunction(viewport) {
  const start = content.indexOf("function clampPanelPosition");
  const end = content.indexOf("function applyPanelPosition", start);
  assert.ok(start >= 0 && end > start, "未找到位置边界函数");
  const source = content.slice(start, end).trim();
  return runInNewContext(`(${source})`, {
    window: viewport,
    ui: {
      panel: {
        getBoundingClientRect() {
          return { width: 0, height: 0 };
        },
      },
    },
  });
}
