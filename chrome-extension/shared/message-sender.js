export const SENDER_KIND = Object.freeze({
  UNTRUSTED: "untrusted",
  EXTENSION_PAGE: "extension_page",
  CONTENT_SCRIPT: "content_script",
  TRUSTED_OTHER: "trusted_other",
});

export function classifyMessageSender(sender, extensionId) {
  if (!sender || sender.id !== extensionId) {
    return SENDER_KIND.UNTRUSTED;
  }

  const extensionBaseUrl = `chrome-extension://${extensionId}/`;
  if (typeof sender.url === "string" && sender.url.startsWith(extensionBaseUrl)) {
    return SENDER_KIND.EXTENSION_PAGE;
  }

  if (Number.isInteger(sender.tab?.id)) {
    return SENDER_KIND.CONTENT_SCRIPT;
  }

  return SENDER_KIND.TRUSTED_OTHER;
}

export function isNamedExtensionPage(sender, extensionId, relativePath) {
  if (classifyMessageSender(sender, extensionId) !== SENDER_KIND.EXTENSION_PAGE) {
    return false;
  }

  const senderUrl = sender.url.split(/[?#]/u, 1)[0];
  return senderUrl === `chrome-extension://${extensionId}/${relativePath}`;
}
