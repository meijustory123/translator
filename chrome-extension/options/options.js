const DEFAULT_SILICONFLOW_MODEL = "Qwen/Qwen3.5-4B";
const SILICONFLOW_MODELS = [
  DEFAULT_SILICONFLOW_MODEL,
  "Qwen/Qwen3.5-35B-A3B",
  "Qwen/Qwen3.5-397B-A17B",
];
const TEXT_PROVIDER_DEEPSEEK = "deepseek";
const TEXT_PROVIDER_SILICONFLOW = "siliconflow";
const LEGACY_TEXT_PROVIDER_DEEPSEEK_FIRST = "deepseek_first";

const textProviderMode = document.querySelector("#textProviderMode");
const routeHint = document.querySelector("#routeHint");
const siliconFlowModel = document.querySelector("#siliconFlowModel");

const providers = {
  siliconflow: createProviderElements({
    storageKey: "siliconFlowApiKey",
    inputId: "siliconFlowApiKey",
    toggleId: "toggleSiliconFlowKey",
    saveId: "saveSiliconFlow",
    testId: "testSiliconFlow",
    clearId: "clearSiliconFlow",
    statusId: "siliconFlowStatus",
    badgeId: "siliconFlowBadge",
    hintId: "siliconFlowHint",
    displayName: "硅基流动",
    emptyHint: "右键图片和框选图片始终需要此密钥。",
  }),
  deepseek: createProviderElements({
    storageKey: "deepSeekApiKey",
    inputId: "deepSeekApiKey",
    toggleId: "toggleDeepSeekKey",
    saveId: "saveDeepSeek",
    testId: "testDeepSeek",
    clearId: "clearDeepSeek",
    statusId: "deepSeekStatus",
    badgeId: "deepSeekBadge",
    hintId: "deepSeekHint",
    displayName: "DeepSeek",
    emptyHint: "选择 DeepSeek 作为文本供应商时，划词、划段和 PDF 文字翻译会使用此密钥。",
  }),
};

void initialize();

async function initialize() {
  bindProviderEvents("siliconflow");
  bindProviderEvents("deepseek");
  textProviderMode.addEventListener("change", () => void saveRoutingMode());
  siliconFlowModel.addEventListener("change", () => void saveSiliconFlowModel());

  try {
    const ready = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
    if (!ready?.ok) {
      throw new Error(ready?.error || "后台设置尚未就绪。");
    }
    const settings = await chrome.storage.local.get({
      apiKey: "",
      siliconFlowApiKey: "",
      siliconFlowModel: DEFAULT_SILICONFLOW_MODEL,
      deepSeekApiKey: "",
      deepseekApiKey: "",
      textProviderMode: LEGACY_TEXT_PROVIDER_DEEPSEEK_FIRST,
    });

    const legacyKey = normalizeSecret(settings.apiKey);
    const siliconFlowKey = normalizeSecret(settings.siliconFlowApiKey || legacyKey);
    const deepSeekKey = normalizeSecret(settings.deepSeekApiKey || settings.deepseekApiKey);

    if (legacyKey && !normalizeSecret(settings.siliconFlowApiKey)) {
      await chrome.storage.local.set({ siliconFlowApiKey: legacyKey });
    }
    if (settings.apiKey) {
      await chrome.storage.local.remove("apiKey");
    }
    if (deepSeekKey && !normalizeSecret(settings.deepSeekApiKey)) {
      await chrome.storage.local.set({ deepSeekApiKey: deepSeekKey });
    }
    if (settings.deepseekApiKey) {
      await chrome.storage.local.remove("deepseekApiKey");
    }

    const selectedProvider = normalizeTextProviderMode(settings.textProviderMode, deepSeekKey);
    textProviderMode.value = selectedProvider;
    if (settings.textProviderMode !== selectedProvider) {
      await chrome.storage.local.set({ textProviderMode: selectedProvider });
    }
    siliconFlowModel.value = SILICONFLOW_MODELS.includes(settings.siliconFlowModel)
      ? settings.siliconFlowModel
      : DEFAULT_SILICONFLOW_MODEL;

    updateProviderState("siliconflow", siliconFlowKey);
    updateProviderState("deepseek", deepSeekKey);
    updateRouteHint();
  } catch {
    setProviderStatus("siliconflow", "读取设置失败，请重新加载扩展。", "error");
    setProviderStatus("deepseek", "读取设置失败，请重新加载扩展。", "error");
  }
}

function createProviderElements(config) {
  return {
    ...config,
    input: document.querySelector(`#${config.inputId}`),
    toggle: document.querySelector(`#${config.toggleId}`),
    save: document.querySelector(`#${config.saveId}`),
    test: document.querySelector(`#${config.testId}`),
    clear: document.querySelector(`#${config.clearId}`),
    status: document.querySelector(`#${config.statusId}`),
    badge: document.querySelector(`#${config.badgeId}`),
    hint: document.querySelector(`#${config.hintId}`),
    hasSavedKey: false,
    keySuffix: "",
  };
}

function bindProviderEvents(providerName) {
  const provider = providers[providerName];

  provider.toggle.addEventListener("click", () => {
    const shouldShow = provider.input.type === "password";
    provider.input.type = shouldShow ? "text" : "password";
    provider.toggle.textContent = shouldShow ? "隐藏" : "显示";
    provider.toggle.setAttribute(
      "aria-label",
      `${shouldShow ? "隐藏" : "显示"}${provider.displayName} API Key`,
    );
    provider.input.focus();
  });

  provider.save.addEventListener("click", () => void saveProvider(providerName, false));
  provider.test.addEventListener("click", () => void saveProvider(providerName, true));
  provider.clear.addEventListener("click", () => void clearProvider(providerName));
  provider.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveProvider(providerName, false);
    }
  });
}

async function saveRoutingMode() {
  const mode = textProviderMode.value === TEXT_PROVIDER_DEEPSEEK
    ? TEXT_PROVIDER_DEEPSEEK
    : TEXT_PROVIDER_SILICONFLOW;
  try {
    await persistSettings({ textProviderMode: mode });
    updateRouteHint();
  } catch {
    routeHint.textContent = "供应商偏好保存失败，请重试。";
    routeHint.classList.add("error-text");
  }
}

async function saveSiliconFlowModel() {
  const model = SILICONFLOW_MODELS.includes(siliconFlowModel.value)
    ? siliconFlowModel.value
    : DEFAULT_SILICONFLOW_MODEL;
  try {
    await persistSettings({ siliconFlowModel: model });
    setProviderStatus("siliconflow", `已切换为 ${model}。`, "success");
    updateRouteHint();
  } catch {
    setProviderStatus("siliconflow", "模型切换保存失败，请重试。", "error");
  }
}

async function saveProvider(providerName, shouldTest) {
  const provider = providers[providerName];
  const enteredKey = provider.input.value.trim();
  if (!enteredKey && !provider.hasSavedKey) {
    setProviderStatus(providerName, `请输入${provider.displayName} API Key。`, "error");
    provider.input.focus();
    return;
  }

  setProviderButtonsDisabled(providerName, true);
  setProviderStatus(providerName, shouldTest ? "正在保存并测试连接…" : "正在保存…", "");

  try {
    const updates = {};
    if (enteredKey) {
      updates[provider.storageKey] = enteredKey;
    }
    if (providerName === "siliconflow") {
      updates.siliconFlowModel = SILICONFLOW_MODELS.includes(siliconFlowModel.value)
        ? siliconFlowModel.value
        : DEFAULT_SILICONFLOW_MODEL;
    }
    const selectedProviderName = textProviderMode.value === TEXT_PROVIDER_DEEPSEEK
      ? "deepseek"
      : "siliconflow";
    if (
      enteredKey
      && providerName !== selectedProviderName
      && !providers[selectedProviderName].hasSavedKey
    ) {
      updates.textProviderMode = providerName === "deepseek"
        ? TEXT_PROVIDER_DEEPSEEK
        : TEXT_PROVIDER_SILICONFLOW;
    }
    const persisted = await persistSettings(updates);

    if (enteredKey) {
      updateProviderState(providerName, persisted[provider.storageKey]);
      provider.input.value = "";
    }
    if (persisted.textProviderMode) {
      textProviderMode.value = persisted.textProviderMode;
    }

    if (!shouldTest) {
      const detail = enteredKey ? "API Key 与设置已保存。" : "已保留现有 API Key 并保存设置。";
      setProviderStatus(providerName, detail, "success");
      updateRouteHint();
      return;
    }

    const result = await chrome.runtime.sendMessage({
      type: "TEST_CONNECTION",
      provider: providerName,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "连接测试失败。 ");
    }
    setProviderStatus(providerName, `连接成功：${result.result}`, "success");
    updateRouteHint();
  } catch (error) {
    setProviderStatus(
      providerName,
      error?.message || `${provider.displayName}设置保存或测试失败，请重试。`,
      "error",
    );
  } finally {
    setProviderButtonsDisabled(providerName, false);
  }
}

async function clearProvider(providerName) {
  const provider = providers[providerName];
  setProviderButtonsDisabled(providerName, true);

  try {
    const keysToRemove = providerName === "deepseek"
      ? [provider.storageKey, "deepseekApiKey"]
      : [provider.storageKey];
    await chrome.storage.local.remove(keysToRemove);
    const persisted = await chrome.storage.local.get(keysToRemove);
    if (keysToRemove.some((key) => normalizeSecret(persisted[key]))) {
      throw new Error("密钥未能从本地存储中清除，请重试。");
    }
    provider.input.value = "";
    updateProviderState(providerName, "");
    setProviderStatus(providerName, `已清除${provider.displayName} API Key。`, "success");
    updateRouteHint();
  } catch {
    setProviderStatus(providerName, "清除失败，请重试。", "error");
  } finally {
    setProviderButtonsDisabled(providerName, false);
  }
}

function updateProviderState(providerName, apiKey) {
  const provider = providers[providerName];
  const normalized = normalizeSecret(apiKey);
  provider.hasSavedKey = Boolean(normalized);
  provider.keySuffix = normalized ? normalized.slice(-4) : "";
  provider.badge.textContent = normalized ? `已配置 ····${provider.keySuffix}` : "未配置";
  provider.badge.classList.toggle("configured", Boolean(normalized));
  provider.clear.disabled = !normalized;
  provider.input.placeholder = normalized
    ? `输入新密钥可替换现有${provider.displayName} API Key`
    : `输入${provider.displayName} API Key`;
  provider.hint.textContent = normalized
    ? `已保存末四位为 ${provider.keySuffix} 的密钥；出于安全考虑不会回显完整内容。`
    : provider.emptyHint;
}

function updateRouteHint() {
  routeHint.classList.remove("error-text");
  if (textProviderMode.value === TEXT_PROVIDER_SILICONFLOW) {
    routeHint.textContent = providers.siliconflow.hasSavedKey
      ? `当前文本翻译使用硅基流动 ${siliconFlowModel.value}；图片使用同一模型。`
      : "当前选择了硅基流动，但尚未配置其 API Key。";
    return;
  }

  if (providers.deepseek.hasSavedKey) {
    routeHint.textContent =
      "当前文本翻译使用 DeepSeek deepseek-v4-flash；图片仍使用硅基流动。";
  } else {
    routeHint.textContent = "当前选择了 DeepSeek，但尚未配置其 API Key。";
  }
}

function setProviderButtonsDisabled(providerName, disabled) {
  const provider = providers[providerName];
  provider.save.disabled = disabled;
  provider.test.disabled = disabled;
  provider.clear.disabled = disabled || !provider.hasSavedKey;
}

function setProviderStatus(providerName, message, type) {
  const status = providers[providerName].status;
  status.textContent = message;
  status.classList.toggle("success", type === "success");
  status.classList.toggle("error", type === "error");
}

function normalizeSecret(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeTextProviderMode(value, deepSeekKey) {
  if (value === TEXT_PROVIDER_DEEPSEEK || value === TEXT_PROVIDER_SILICONFLOW) {
    return value;
  }
  return deepSeekKey ? TEXT_PROVIDER_DEEPSEEK : TEXT_PROVIDER_SILICONFLOW;
}

async function persistSettings(updates) {
  await chrome.storage.local.set(updates);
  const persisted = await chrome.storage.local.get(Object.keys(updates));
  const isPersisted = Object.entries(updates).every(([key, value]) => persisted[key] === value);
  if (!isPersisted) {
    throw new Error("设置未能持久化，请重试。");
  }
  return persisted;
}
