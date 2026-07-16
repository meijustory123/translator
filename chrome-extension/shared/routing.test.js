import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseTextProvider,
  LEGACY_TEXT_PROVIDER_DEEPSEEK_FIRST,
  TEXT_PROVIDER_DEEPSEEK,
  TEXT_PROVIDER_SILICONFLOW,
} from "./routing.js";

test("uses the explicitly selected DeepSeek provider", () => {
  assert.equal(
    chooseTextProvider({
      textProviderMode: TEXT_PROVIDER_DEEPSEEK,
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "siliconflow-key",
    }),
    TEXT_PROVIDER_DEEPSEEK,
  );
});

test("uses the explicitly selected SiliconFlow provider and does not prefer DeepSeek", () => {
  assert.equal(
    chooseTextProvider({
      textProviderMode: TEXT_PROVIDER_SILICONFLOW,
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "siliconflow-key",
    }),
    TEXT_PROVIDER_SILICONFLOW,
  );
});

test("does not silently fall back when the selected provider has no key", () => {
  assert.equal(
    chooseTextProvider({
      textProviderMode: TEXT_PROVIDER_DEEPSEEK,
      deepSeekApiKey: "",
      siliconFlowApiKey: "siliconflow-key",
    }),
    "",
  );
  assert.equal(
    chooseTextProvider({
      textProviderMode: TEXT_PROVIDER_SILICONFLOW,
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "",
    }),
    "",
  );
});

test("keeps the old DeepSeek-first fallback during migration", () => {
  assert.equal(
    chooseTextProvider({
      textProviderMode: LEGACY_TEXT_PROVIDER_DEEPSEEK_FIRST,
      deepSeekApiKey: "",
      siliconFlowApiKey: "siliconflow-key",
    }),
    TEXT_PROVIDER_SILICONFLOW,
  );
});

test("keeps the pre-1.3 call shape compatible while callers migrate", () => {
  assert.equal(
    chooseTextProvider({
      deepSeekApiKey: "deepseek-key",
      siliconFlowApiKey: "siliconflow-key",
    }),
    TEXT_PROVIDER_DEEPSEEK,
  );
});
