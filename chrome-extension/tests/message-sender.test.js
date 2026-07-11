import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMessageSender,
  isNamedExtensionPage,
  SENDER_KIND,
} from "../shared/message-sender.js";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";

test("标签页形式打开的设置页仍识别为可信扩展页", () => {
  const sender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
    tab: { id: 7, windowId: 1 },
  };

  assert.equal(classifyMessageSender(sender, EXTENSION_ID), SENDER_KIND.EXTENSION_PAGE);
  assert.equal(isNamedExtensionPage(sender, EXTENSION_ID, "options/options.html"), true);
  assert.equal(isNamedExtensionPage(sender, EXTENSION_ID, "popup/popup.html"), false);
});

test("弹窗与设置页按路径分别授权", () => {
  const popupSender = {
    id: EXTENSION_ID,
    url: `chrome-extension://${EXTENSION_ID}/popup/popup.html?source=toolbar`,
  };

  assert.equal(isNamedExtensionPage(popupSender, EXTENSION_ID, "popup/popup.html"), true);
  assert.equal(isNamedExtensionPage(popupSender, EXTENSION_ID, "options/options.html"), false);
});

test("网页内容脚本不能伪装为扩展设置页", () => {
  const sender = {
    id: EXTENSION_ID,
    url: "https://example.com/article",
    tab: { id: 9, windowId: 1 },
  };

  assert.equal(classifyMessageSender(sender, EXTENSION_ID), SENDER_KIND.CONTENT_SCRIPT);
  assert.equal(isNamedExtensionPage(sender, EXTENSION_ID, "options/options.html"), false);
});

test("其他扩展即使伪造 URL 字符串也不受信任", () => {
  const sender = {
    id: "different-extension-id",
    url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
    tab: { id: 11 },
  };

  assert.equal(classifyMessageSender(sender, EXTENSION_ID), SENDER_KIND.UNTRUSTED);
  assert.equal(isNamedExtensionPage(sender, EXTENSION_ID, "options/options.html"), false);
});
