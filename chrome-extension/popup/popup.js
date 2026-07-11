const statusDot = document.querySelector("#statusDot");
const keyStatus = document.querySelector("#keyStatus");
const modelStatus = document.querySelector("#modelStatus");
const imageStatusDot = document.querySelector("#imageStatusDot");
const imageKeyStatus = document.querySelector("#imageKeyStatus");
const imageModelStatus = document.querySelector("#imageModelStatus");
const autoTranslate = document.querySelector("#autoTranslate");
const imageTranslate = document.querySelector("#imageTranslate");
const settingsShortcut = document.querySelector("#settingsShortcut");
const feedback = document.querySelector("#feedback");

void initialize();

async function initialize() {
  try {
    const settings = await chrome.runtime.sendMessage({ type: "GET_PUBLIC_SETTINGS" });
    if (!settings?.ok) {
      throw new Error(settings?.error || "读取设置失败");
    }

    autoTranslate.checked = settings.autoTranslate;
    autoTranslate.disabled = false;
    imageTranslate.disabled = !settings.hasSiliconFlowKey;

    statusDot.classList.remove("loading");
    imageStatusDot.classList.remove("loading");
    if (settings.hasApiKey) {
      statusDot.classList.remove("missing");
      if (settings.activeTextProvider === "deepseek") {
        keyStatus.textContent = `文本：DeepSeek 已就绪 ····${settings.deepSeekKeySuffix}`;
        modelStatus.textContent = settings.textModel;
      } else {
        keyStatus.textContent = `文本：硅基流动已就绪 ····${settings.siliconFlowKeySuffix}`;
        modelStatus.textContent = settings.textModel;
      }
    } else {
      statusDot.classList.add("missing");
      keyStatus.textContent = "文本翻译尚未配置可用密钥";
      modelStatus.textContent = "请打开设置页";
    }

    if (settings.hasSiliconFlowKey) {
      imageStatusDot.classList.remove("missing");
      imageKeyStatus.textContent = `图片：硅基流动已就绪 ····${settings.siliconFlowKeySuffix}`;
      imageModelStatus.textContent = settings.imageModel;
    } else {
      imageStatusDot.classList.add("missing");
      imageKeyStatus.textContent = "图片翻译需要硅基流动密钥";
      imageModelStatus.textContent = settings.imageModel;
    }

    if (!settings.hasApiKey || !settings.hasSiliconFlowKey) {
      feedback.textContent = "部分功能尚未配置，请到设置页补充密钥。";
    }
  } catch {
    statusDot.classList.remove("loading");
    statusDot.classList.add("missing");
    imageStatusDot.classList.remove("loading");
    imageStatusDot.classList.add("missing");
    keyStatus.textContent = "无法读取扩展设置";
    imageKeyStatus.textContent = "无法读取扩展设置";
    feedback.textContent = "请重新加载扩展后再试。";
  }
}

autoTranslate.addEventListener("change", async () => {
  const nextValue = autoTranslate.checked;
  autoTranslate.disabled = true;
  feedback.textContent = "";

  try {
    const result = await chrome.runtime.sendMessage({
      type: "SET_AUTO_TRANSLATE",
      autoTranslate: nextValue,
    });
    if (!result?.ok) {
      throw new Error(result?.error || "保存失败");
    }
  } catch {
    autoTranslate.checked = !nextValue;
    feedback.textContent = "自动翻译设置保存失败。";
  } finally {
    autoTranslate.disabled = false;
  }
});

imageTranslate.addEventListener("click", async () => {
  feedback.textContent = "";
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      throw new Error("NO_TAB");
    }

    const result = await chrome.tabs.sendMessage(tab.id, {
      type: "START_IMAGE_SELECTION",
    });
    if (!result?.ok) {
      throw new Error("CONTENT_UNAVAILABLE");
    }
    window.close();
  } catch {
    feedback.textContent = "此页面不允许扩展运行，请在普通网页中使用。";
  }
});

settingsShortcut.addEventListener("click", () => {
  void chrome.runtime.openOptionsPage();
  window.close();
});
