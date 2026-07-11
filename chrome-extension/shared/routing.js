export function chooseTextProvider({ textProviderMode, deepSeekApiKey, siliconFlowApiKey }) {
  if (textProviderMode !== "siliconflow" && deepSeekApiKey) {
    return "deepseek";
  }
  if (siliconFlowApiKey) {
    return "siliconflow";
  }
  return "";
}
