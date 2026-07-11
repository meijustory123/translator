import assert from "node:assert/strict";
import test from "node:test";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const storageData = {
  siliconFlowApiKey: "test-siliconflow-key",
  siliconFlowModel: "Qwen/Qwen3.5-4B",
  deepSeekApiKey: "test-deepseek-key",
  textProviderMode: "deepseek_first",
  autoTranslate: true,
};
const storageSetCalls = [];
const fetchCalls = [];
let runtimeMessageListener;

globalThis.chrome = createChromeMock();
globalThis.fetch = async (url, options) => {
  fetchCalls.push({ url, options });
  return new Response(
    [
      'data: {"choices":[{"delta":{"content":"连接成功"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
};

await import(`../background/service-worker.js?runtime-message-test=${Date.now()}`);
await Promise.resolve();

test("带 tab 的设置页可以真正发起连接测试", async () => {
  fetchCalls.length = 0;
  const response = await sendRuntimeMessage(
    { type: "TEST_CONNECTION", provider: "siliconflow" },
    {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/options/options.html`,
      tab: { id: 7, windowId: 1 },
    },
  );

  assert.equal(response.ok, true);
  assert.match(response.result, /连接成功/u);
  assert.equal(fetchCalls.length, 1);
  const requestBody = JSON.parse(fetchCalls[0].options.body);
  assert.equal(requestBody.model, "Qwen/Qwen3.5-4B");
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.enable_thinking, false);
});

test("网页内容脚本只能读取精简公开设置", async () => {
  const response = await sendRuntimeMessage(
    { type: "GET_PUBLIC_SETTINGS" },
    {
      id: EXTENSION_ID,
      url: "https://example.com/article",
      tab: { id: 8, windowId: 1 },
    },
  );

  assert.deepEqual(response, {
    ok: true,
    autoTranslate: true,
    hasApiKey: true,
  });
});

test("网页内容脚本不能修改自动翻译设置", async () => {
  const callsBefore = storageSetCalls.length;
  const response = await sendRuntimeMessage(
    { type: "SET_AUTO_TRANSLATE", autoTranslate: false },
    {
      id: EXTENSION_ID,
      url: "https://example.com/article",
      tab: { id: 8, windowId: 1 },
    },
  );

  assert.deepEqual(response, { ok: false, error: "不支持的请求。" });
  assert.equal(storageSetCalls.length, callsBefore);
  assert.equal(storageData.autoTranslate, true);
});

test("弹窗仍可修改自动翻译设置", async () => {
  const response = await sendRuntimeMessage(
    { type: "SET_AUTO_TRANSLATE", autoTranslate: false },
    {
      id: EXTENSION_ID,
      url: `chrome-extension://${EXTENSION_ID}/popup/popup.html`,
    },
  );

  assert.deepEqual(response, { ok: true, autoTranslate: false });
  assert.equal(storageData.autoTranslate, false);
});

function sendRuntimeMessage(message, sender) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`消息未响应：${message.type}`)), 2_000);
    const respond = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    const keepChannelOpen = runtimeMessageListener(message, sender, respond);
    if (keepChannelOpen === false) {
      queueMicrotask(() => respond(undefined));
    }
  });
}

function createChromeMock() {
  const event = () => ({ addListener() {} });
  return {
    runtime: {
      id: EXTENSION_ID,
      onInstalled: event(),
      onStartup: event(),
      onConnect: event(),
      onMessage: {
        addListener(listener) {
          runtimeMessageListener = listener;
        },
      },
      openOptionsPage: async () => undefined,
    },
    contextMenus: {
      onClicked: event(),
      removeAll(callback) {
        callback?.();
      },
      create() {},
    },
    storage: {
      local: {
        async get(defaults) {
          if (typeof defaults === "string") {
            return { [defaults]: storageData[defaults] };
          }
          return { ...defaults, ...storageData };
        },
        async set(values) {
          storageSetCalls.push(values);
          Object.assign(storageData, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storageData[key];
          }
        },
        async setAccessLevel() {},
      },
      onChanged: event(),
    },
    tabs: {
      async query() {
        return [];
      },
      async sendMessage() {
        return undefined;
      },
    },
  };
}
