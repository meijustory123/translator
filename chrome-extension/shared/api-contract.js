export function buildChatRequestBody({ provider, model, messages }) {
  const body = {
    model,
    messages,
    stream: true,
  };

  if (provider === "deepseek") {
    body.thinking = { type: "disabled" };
  } else {
    body.enable_thinking = false;
  }

  return body;
}

export function consumeSseEvents(input, onDelta) {
  const normalized = input.replace(/^\uFEFF/u, "").replace(/\r\n|\r/gu, "\n");
  const events = normalized.split("\n\n");
  const remainder = events.pop() ?? "";
  let done = false;

  for (const event of events) {
    const data = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data) {
      continue;
    }
    if (data === "[DONE]") {
      done = true;
      break;
    }

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      throw createProtocolError("服务返回了无法解析的流式数据。", "INVALID_STREAM_DATA");
    }

    if (payload.error || (payload.code && payload.message && !payload.choices)) {
      throw createProtocolError(
        payload.error?.message || payload.message || "翻译服务返回错误。",
        "UPSTREAM_STREAM_ERROR",
      );
    }

    const delta = payload.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      onDelta(delta);
    }
  }

  return { remainder, done };
}

function createProtocolError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}
