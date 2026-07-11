export function chooseTextProvider({ deepSeekApiKey, siliconFlowApiKey }) {
  if (deepSeekApiKey) {
    return "deepseek";
  }
  if (siliconFlowApiKey) {
    return "siliconflow";
  }
  return "";
}
