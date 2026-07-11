import assert from "node:assert/strict";
import test from "node:test";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const nativeFetch = globalThis.fetch;
const apiCalls = [];
let connectListener;

globalThis.chrome = createChromeMock();
globalThis.createImageBitmap = async () => ({
  width: 1_200,
  height: 800,
  close() {},
});
globalThis.OffscreenCanvas = class OffscreenCanvasMock {
  constructor(width, height) {
    this.width = width;
    this.height = height;
  }

  getContext() {
    return {
      fillStyle: "",
      fillRect() {},
      drawImage() {},
    };
  }

  async convertToBlob() {
    return new Blob([new Uint8Array(2_048)], { type: "image/jpeg" });
  }
};
globalThis.fetch = async (url, options) => {
  if (String(url).startsWith("data:")) {
    return nativeFetch(url, options);
  }

  apiCalls.push({ url, options });
  return new Response(
    [
      ": keep-alive\n\n",
      'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"图片译文"}}]}\n\n',
      "data: [DONE]\n\n",
    ].join(""),
    {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8" },
    },
  );
};

await import(`../background/service-worker.js?image-request-test=${Date.now()}`);
await Promise.resolve();

test("图片请求经过分阶段处理并构造受限的硅基流动多模态请求", async () => {
  const messages = [];
  let incomingMessageListener;
  let resolveTerminal;
  const terminalPromise = new Promise((resolve) => {
    resolveTerminal = resolve;
  });
  const port = {
    name: "multi-provider-translation",
    sender: {
      id: EXTENSION_ID,
      url: "https://example.com/image-page",
      tab: { id: 17, windowId: 3 },
    },
    onMessage: {
      addListener(listener) {
        incomingMessageListener = listener;
      },
    },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      messages.push(message);
      if (message.type === "DONE" || message.type === "ERROR") {
        resolveTerminal(message);
      }
    },
    disconnect() {
      assert.fail("合法内容脚本端口不应被断开");
    },
  };

  connectListener(port);
  incomingMessageListener({
    type: "TRANSLATE_IMAGE",
    requestId: "image-request-123",
    rect: { left: 10, top: 20, width: 600, height: 400 },
    viewport: { width: 1_200, height: 800 },
  });

  let terminalTimeout = null;
  const terminal = await Promise.race([
    terminalPromise,
    new Promise((_, reject) => {
      terminalTimeout = setTimeout(() => reject(new Error("图片请求没有返回终态")), 2_000);
    }),
  ]);
  clearTimeout(terminalTimeout);

  assert.equal(terminal.type, "DONE");
  assert.deepEqual(
    messages.filter((message) => message.type === "PROGRESS").map((message) => message.phase),
    ["SCREENSHOT_CAPTURED", "IMAGE_PREPARED", "REQUEST_SENT", "RESPONSE_STARTED", "STREAMING"],
  );
  assert.equal(apiCalls.length, 1);
  assert.equal(apiCalls[0].url, "https://api.siliconflow.cn/v1/chat/completions");

  const body = JSON.parse(apiCalls[0].options.body);
  assert.equal(body.model, "Qwen/Qwen3.5-4B");
  assert.equal(body.stream, true);
  assert.equal(body.enable_thinking, false);
  assert.equal("max_tokens" in body, false);
  assert.match(body.messages[1].content[0].image_url.url, /^data:image\/jpeg;base64,/u);
  assert.equal(body.messages[1].content[0].image_url.detail, "high");
});

function createChromeMock() {
  const event = () => ({ addListener() {} });
  return {
    runtime: {
      id: EXTENSION_ID,
      onInstalled: event(),
      onStartup: event(),
      onConnect: {
        addListener(listener) {
          connectListener = listener;
        },
      },
      onMessage: event(),
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
          return {
            ...defaults,
            siliconFlowApiKey: "test-siliconflow-key",
            siliconFlowModel: "Qwen/Qwen3.5-4B",
            autoTranslate: true,
          };
        },
        async set() {},
        async remove() {},
        async setAccessLevel() {},
      },
      onChanged: event(),
    },
    tabs: {
      async query() {
        return [{ id: 17, windowId: 3 }];
      },
      async captureVisibleTab() {
        return "data:image/png;base64,AA==";
      },
      async sendMessage() {
        return undefined;
      },
    },
  };
}
