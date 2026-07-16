export const TEXT_PROVIDER_DEEPSEEK = "deepseek";
export const TEXT_PROVIDER_SILICONFLOW = "siliconflow";
export const LEGACY_TEXT_PROVIDER_DEEPSEEK_FIRST = "deepseek_first";

export function chooseTextProvider({ textProviderMode, deepSeekApiKey, siliconFlowApiKey }) {
  if (textProviderMode === TEXT_PROVIDER_DEEPSEEK) {
    return deepSeekApiKey ? TEXT_PROVIDER_DEEPSEEK : "";
  }
  if (textProviderMode === TEXT_PROVIDER_SILICONFLOW) {
    return siliconFlowApiKey ? TEXT_PROVIDER_SILICONFLOW : "";
  }

  // Versions up to 1.2.0 stored "deepseek_first" and silently fell back to
  // SiliconFlow. Keep that behavior while the background migration rewrites it
  // to an explicit provider selection.
  if (deepSeekApiKey) {
    return TEXT_PROVIDER_DEEPSEEK;
  }
  if (siliconFlowApiKey) {
    return TEXT_PROVIDER_SILICONFLOW;
  }
  return "";
}
