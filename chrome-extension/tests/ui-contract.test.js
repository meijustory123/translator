import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Manifest 引用的本地入口文件全部存在", () => {
  const manifest = JSON.parse(readFileSync(resolve(extensionRoot, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(resolve(extensionRoot, "package.json"), "utf8"));
  const contentScript = readFileSync(resolve(extensionRoot, "content/content.js"), "utf8");
  const referencedFiles = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    manifest.options_ui.page,
    ...manifest.content_scripts.flatMap((entry) => entry.js || []),
  ];

  for (const file of referencedFiles) {
    assert.equal(existsSync(resolve(extensionRoot, file)), true, `缺少 ${file}`);
  }
  assert.deepEqual(manifest.permissions.sort(), [
    "activeTab",
    "contextMenus",
    "scripting",
    "storage",
  ]);
  assert.deepEqual(manifest.host_permissions.sort(), [
    "https://api.deepseek.com/*",
    "https://api.siliconflow.cn/*",
  ]);
  assert.equal(packageJson.version, manifest.version);
  assert.match(
    contentScript,
    new RegExp(`CONTENT_SCRIPT_VERSION = ["']${escapeRegExp(manifest.version)}["']`, "u"),
  );
});

test("设置页脚本引用的 ID 都存在于 HTML", () => {
  assertScriptSelectorsExist("options/options.js", "options/options.html");
});

test("弹窗脚本引用的 ID 都存在于 HTML", () => {
  assertScriptSelectorsExist("popup/popup.js", "popup/popup.html");
});

function assertScriptSelectorsExist(scriptPath, htmlPath) {
  const script = readFileSync(resolve(extensionRoot, scriptPath), "utf8");
  const html = readFileSync(resolve(extensionRoot, htmlPath), "utf8");
  const ids = new Set(Array.from(html.matchAll(/\sid="([^"]+)"/gu), (match) => match[1]));
  const referencedIds = Array.from(
    script.matchAll(/querySelector\(["']#([^"']+)["']\)/gu),
    (match) => match[1],
  );

  for (const id of referencedIds) {
    assert.equal(ids.has(id), true, `${scriptPath} 引用了不存在的 #${id}`);
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
