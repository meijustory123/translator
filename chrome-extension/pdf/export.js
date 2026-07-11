const EXPORT_CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const HTML_ESCAPE_MAP = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});

/** Escapes a value for both HTML text and quoted HTML attributes. */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, (character) => HTML_ESCAPE_MAP[character]);
}

/**
 * Builds a standalone, script-free UTF-8 bilingual document.
 *
 * Expected input:
 *   { fileName, title?, pages: [{ pageNumber, blocks: [{ id, source, target }] }] }
 * `textBlocks` or `translations` may be used in place of `blocks`.
 */
export function buildBilingualHtml(documentData = {}) {
  const data = documentData && typeof documentData === "object" ? documentData : {};
  const fileName = textValue(data.fileName || data.name || "PDF 文档");
  const title = textValue(data.title || `${stripPdfExtension(fileName)} · 双语译文`);
  const generatedAt = formatGeneratedAt(data.generatedAt);
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const pageSections = pages.map((page, index) => renderPage(page, index)).join("\n");
  const emptyState = pages.length === 0
    ? '<p class="empty-state">当前没有可导出的页面。</p>'
    : "";

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(EXPORT_CSP)}">
  <meta name="referrer" content="no-referrer">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; color: #1c2538; background: #f3f5f9; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f3f5f9; }
    .document { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 32px 0 56px; }
    .document-header { margin-bottom: 22px; padding: 24px 26px; border: 1px solid #e0e4ed; background: #fff; border-radius: 15px; box-shadow: 0 8px 28px rgba(35, 48, 78, .07); }
    h1 { margin: 0; overflow-wrap: anywhere; font-size: 24px; line-height: 1.35; }
    .meta { display: flex; flex-wrap: wrap; gap: 8px 20px; margin-top: 10px; color: #6c778b; font-size: 12px; }
    .page { margin-top: 18px; overflow: hidden; border: 1px solid #e0e4ed; background: #fff; border-radius: 14px; box-shadow: 0 7px 22px rgba(35, 48, 78, .055); break-after: page; }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 48px; padding: 11px 16px; border-bottom: 1px solid #e5e8ef; background: #fafbfc; }
    .page-header h2 { margin: 0; font-size: 15px; }
    .page-header span { color: #788296; font-size: 11px; }
    .block { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); border-top: 1px solid #eceef3; break-inside: avoid; }
    .block:first-child { border-top: 0; }
    .column { min-width: 0; padding: 15px 17px; }
    .column + .column { border-left: 1px solid #e5e8ef; background: #fcfcfe; }
    .column-label { display: block; margin-bottom: 7px; color: #7a8496; font-size: 10px; font-weight: 700; letter-spacing: .05em; }
    .text { margin: 0; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 13px; line-height: 1.75; }
    .target { color: #172237; font-size: 14px; }
    .pending { color: #9299a7; font-style: italic; }
    .empty-page, .empty-state { margin: 0; padding: 30px; color: #7b8494; text-align: center; }
    .empty-state { border: 1px dashed #cfd5e1; background: #fff; border-radius: 12px; }
    @media (max-width: 720px) { .document { width: min(100% - 18px, 620px); padding-top: 14px; } .document-header { padding: 18px; } .block { grid-template-columns: minmax(0, 1fr); } .column + .column { border-top: 1px solid #e5e8ef; border-left: 0; } }
    @media print { @page { margin: 12mm; } body { background: #fff; } .document { width: 100%; padding: 0; } .document-header { border: 0; box-shadow: none; } .page { margin-top: 0; border: 0; border-radius: 0; box-shadow: none; } }
  </style>
</head>
<body>
  <main class="document">
    <header class="document-header">
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">
        <span>来源：${escapeHtml(fileName)}</span>
        <span>共 ${pages.length} 页</span>
        <span>导出时间：${escapeHtml(generatedAt)}</span>
      </div>
    </header>
    ${pageSections}${emptyState}
  </main>
</body>
</html>`;
}

/** Downloads a freshly built bilingual HTML document as UTF-8. */
export function downloadBilingualHtml(documentData = {}, options = {}) {
  const documentObject = options.document || globalThis.document;
  const BlobConstructor = options.Blob || globalThis.Blob;
  const urlApi = options.URL || globalThis.URL;
  if (!documentObject?.createElement || !documentObject.body) {
    throw new Error("当前环境无法创建下载链接");
  }
  if (typeof BlobConstructor !== "function" || typeof urlApi?.createObjectURL !== "function") {
    throw new Error("当前环境不支持 Blob 下载");
  }

  const html = buildBilingualHtml(documentData);
  const blob = new BlobConstructor([html], { type: "text/html;charset=utf-8" });
  const objectUrl = urlApi.createObjectURL(blob);
  const anchor = documentObject.createElement("a");
  const inferredName = `${stripPdfExtension(documentData?.fileName || documentData?.name || "PDF-翻译")}-双语.html`;
  const filename = sanitizeDownloadFilename(options.filename || inferredName);
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  documentObject.body.append(anchor);

  try {
    anchor.click();
  } finally {
    anchor.remove();
    const schedule = options.setTimeout || globalThis.setTimeout;
    if (typeof schedule === "function") {
      schedule(() => urlApi.revokeObjectURL?.(objectUrl), 0);
    } else {
      urlApi.revokeObjectURL?.(objectUrl);
    }
  }

  return { html, blob, objectUrl, filename };
}

/** Opens the safe standalone document and invokes the browser print dialog. */
export function printBilingualDocument(documentData = {}, options = {}) {
  const hostWindow = options.window || globalThis.window;
  if (!hostWindow || typeof hostWindow.open !== "function") {
    throw new Error("当前环境无法打开打印窗口");
  }

  const printWindow = hostWindow.open("", "_blank");
  if (!printWindow) {
    throw new Error("打印窗口被浏览器拦截，请允许此扩展打开窗口后重试");
  }

  const html = buildBilingualHtml(documentData);
  try {
    printWindow.opener = null;
  } catch {
    // Some browser policies expose opener as read-only; the exported page has no script.
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();

  let printed = false;
  const triggerPrint = () => {
    if (printed) {
      return;
    }
    printed = true;
    printWindow.focus?.();
    printWindow.print();
  };
  if (printWindow.document.readyState === "complete") {
    triggerPrint();
  } else {
    printWindow.addEventListener("load", triggerPrint, { once: true });
  }
  return printWindow;
}

export const downloadHtmlExport = downloadBilingualHtml;
export const printBilingualHtml = printBilingualDocument;

function renderPage(pageValue, index) {
  const page = pageValue && typeof pageValue === "object" ? pageValue : {};
  const pageNumber = positiveInteger(page.pageNumber ?? page.number, index + 1);
  const blocks = Array.isArray(page.blocks)
    ? page.blocks
    : Array.isArray(page.textBlocks)
      ? page.textBlocks
      : Array.isArray(page.translations)
        ? page.translations
        : [];
  const blockMarkup = blocks.map((block, blockIndex) => renderBlock(block, blockIndex)).join("\n");
  const typeLabel = textValue(page.typeLabel || page.pageType || "文本页");
  return `<section class="page" data-page-number="${pageNumber}">
      <header class="page-header">
        <h2>第 ${pageNumber} 页</h2>
        <span>${escapeHtml(typeLabel)}</span>
      </header>
      <div class="blocks">${blockMarkup || '<p class="empty-page">本页没有可导出的文字。</p>'}</div>
    </section>`;
}

function renderBlock(blockValue, index) {
  const block = blockValue && typeof blockValue === "object" ? blockValue : {};
  const source = textValue(block.source ?? block.text);
  const target = textValue(block.target ?? block.translation ?? block.translatedText);
  const blockId = textValue(block.id ?? block.blockId ?? `block-${index + 1}`);
  return `<article class="block" data-block-id="${escapeHtml(blockId)}">
          <section class="column source-column" aria-label="原文">
            <span class="column-label">原文</span>
            <p class="text source">${escapeHtml(source)}</p>
          </section>
          <section class="column target-column" aria-label="译文">
            <span class="column-label">译文</span>
            <p class="text target${target ? "" : " pending"}">${escapeHtml(target || "尚无译文")}</p>
          </section>
        </article>`;
}

function sanitizeDownloadFilename(value) {
  const sanitized = textValue(value)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "-")
    .replace(/[. ]+$/gu, "")
    .trim();
  return sanitized || "PDF-双语翻译.html";
}

function stripPdfExtension(value) {
  return textValue(value).replace(/\.pdf$/iu, "") || "PDF 文档";
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatGeneratedAt(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  if (value != null && textValue(value).trim()) {
    return textValue(value);
  }
  return new Date().toISOString();
}

function textValue(value) {
  return value == null ? "" : String(value);
}
