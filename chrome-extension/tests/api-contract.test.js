import assert from "node:assert/strict";
import test from "node:test";

import { buildChatRequestBody, consumeSseEvents } from "../shared/api-contract.js";
import {
  DEEPSEEK_API_URL,
  DEEPSEEK_MODEL,
  SILICONFLOW_API_URL,
  SILICONFLOW_MODELS,
} from "../shared/prompts.js";
import { chooseTextProvider } from "../shared/routing.js";

const messages = [
  { role: "system", content: "translate" },
  { role: "user", content: "hello" },
];

test("供应商端点与可选模型保持精确配置", () => {
  assert.equal(SILICONFLOW_API_URL, "https://api.siliconflow.cn/v1/chat/completions");
  assert.deepEqual([...SILICONFLOW_MODELS], [
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-35B-A3B",
  ]);
  assert.equal(DEEPSEEK_API_URL, "https://api.deepseek.com/chat/completions");
  assert.equal(DEEPSEEK_MODEL, "deepseek-v4-flash");
});

test("SiliconFlow 请求关闭思考、开启流式且省略 max_tokens", () => {
  const body = buildChatRequestBody({
    provider: "siliconflow",
    model: "Qwen/Qwen3.5-35B-A3B",
    messages,
  });

  assert.equal(body.model, "Qwen/Qwen3.5-35B-A3B");
  assert.equal(body.stream, true);
  assert.equal(body.enable_thinking, false);
  assert.equal("thinking" in body, false);
  assert.equal("max_tokens" in body, false);
});

test("DeepSeek 请求关闭思考、开启流式且省略 max_tokens", () => {
  const body = buildChatRequestBody({
    provider: "deepseek",
    model: "deepseek-v4-flash",
    messages,
  });

  assert.equal(body.model, "deepseek-v4-flash");
  assert.equal(body.stream, true);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal("enable_thinking" in body, false);
  assert.equal("max_tokens" in body, false);
});

test("文本路由优先 DeepSeek，并在未配置时回退硅基流动", () => {
  assert.equal(
    chooseTextProvider({
      textProviderMode: "deepseek_first",
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "siliconflow-key",
    }),
    "deepseek",
  );
  assert.equal(
    chooseTextProvider({
      textProviderMode: "deepseek_first",
      deepSeekApiKey: "",
      siliconFlowApiKey: "siliconflow-key",
    }),
    "siliconflow",
  );
  assert.equal(
    chooseTextProvider({
      textProviderMode: "siliconflow",
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "siliconflow-key",
    }),
    "siliconflow",
  );
});

test("SSE 解析器保留跨网络分块的半条事件", () => {
  const first = 'data: {"choices":[{"delta":{"content":"你';
  const firstResult = consumeSseEvents(first, () => assert.fail("不应提前输出"));
  assert.equal(firstResult.remainder, first);
  assert.equal(firstResult.done, false);

  const output = [];
  const completed = consumeSseEvents(
    `${firstResult.remainder}好"}}]}\r\n\r\ndata: [DONE]\r\n\r\n`,
    (delta) => output.push(delta),
  );
  assert.deepEqual(output, ["你好"]);
  assert.equal(completed.done, true);
  assert.equal(completed.remainder, "");
});

test("SSE 解析器忽略 usage 空 choices 帧", () => {
  const output = [];
  const result = consumeSseEvents(
    'data: {"choices":[],"usage":{"total_tokens":3}}\n\ndata: [DONE]\n\n',
    (delta) => output.push(delta),
  );
  assert.deepEqual(output, []);
  assert.equal(result.done, true);
});

test("SSE 解析器暴露流内错误", () => {
  assert.throws(
    () =>
      consumeSseEvents(
        'data: {"error":{"message":"upstream failed"}}\n\n',
        () => undefined,
      ),
    (error) => error.code === "UPSTREAM_STREAM_ERROR" && error.message === "upstream failed",
  );
});
