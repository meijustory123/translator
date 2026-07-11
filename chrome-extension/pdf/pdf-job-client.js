const PORT_NAME = "pdf-translation-job";
const CREATE_TIMEOUT_MS = 15_000;

export class PdfJobClient {
  constructor({
    runtime = globalThis.chrome?.runtime,
    onEvent = () => undefined,
    onDisconnect,
    createTimeoutMs = CREATE_TIMEOUT_MS,
  }) {
    if (!runtime?.connect) {
      throw new Error("扩展消息通道不可用。");
    }
    this.runtime = runtime;
    this.onEvent = onEvent;
    this.onDisconnect = onDisconnect || (() => undefined);
    this.createTimeoutMs = Number.isFinite(createTimeoutMs) && createTimeoutMs > 0
      ? createTimeoutMs
      : CREATE_TIMEOUT_MS;
    this.port = null;
    this.jobId = "";
    this.activeBatchIds = new Set();
    this.createWaiter = null;
    this.closedByClient = false;
  }

  connect() {
    if (this.port) {
      return;
    }
    this.closedByClient = false;
    const port = this.runtime.connect({ name: PORT_NAME });
    this.port = port;
    port.onMessage.addListener((message) => this.#handleMessage(message));
    port.onDisconnect.addListener(() => this.#handleDisconnect(port));
  }

  createJob({ jobId, fingerprint, pageCount }) {
    this.connect();
    if (this.createWaiter) {
      return this.createWaiter.promise;
    }

    this.jobId = jobId;
    let resolveWaiter;
    let rejectWaiter;
    const promise = new Promise((resolve, reject) => {
      resolveWaiter = resolve;
      rejectWaiter = reject;
    });
    const timer = setTimeout(() => {
      if (this.createWaiter?.promise !== promise) {
        return;
      }
      this.createWaiter = null;
      const error = new Error("PDF 翻译后台响应超时，请重新加载扩展。");
      error.code = "CREATE_TIMEOUT";
      rejectWaiter(error);
      this.#tryPost({ type: "CANCEL_JOB", jobId: this.jobId });
      this.disconnect();
      this.jobId = "";
    }, this.createTimeoutMs);
    this.createWaiter = {
      promise,
      resolve(value) {
        clearTimeout(timer);
        resolveWaiter(value);
      },
      reject(error) {
        clearTimeout(timer);
        rejectWaiter(error);
      },
    };

    try {
      this.#post({ type: "CREATE_PDF_JOB", jobId, fingerprint, pageCount });
    } catch (error) {
      const waiter = this.createWaiter;
      this.createWaiter = null;
      waiter?.reject(error);
    }
    return promise;
  }

  translateTextBatch({ batchId, blocks }) {
    if (!this.jobId) {
      throw new Error("PDF 翻译任务尚未创建。");
    }
    this.activeBatchIds.add(batchId);
    try {
      this.#post({
        type: "TRANSLATE_TEXT_BATCH",
        jobId: this.jobId,
        batchId,
        blocks,
      });
    } catch (error) {
      this.activeBatchIds.delete(batchId);
      throw error;
    }
  }

  cancelBatch(batchId) {
    if (!this.jobId || !batchId) {
      return false;
    }
    this.activeBatchIds.delete(batchId);
    return this.#tryPost({ type: "CANCEL_BATCH", jobId: this.jobId, batchId });
  }

  forgetBatch(batchId) {
    this.activeBatchIds.delete(batchId);
  }

  cancelJob() {
    this.activeBatchIds.clear();
    const waiter = this.createWaiter;
    this.createWaiter = null;
    waiter?.reject(new Error("PDF 翻译任务已取消。"));
    if (!this.jobId || !this.port) {
      return false;
    }
    return this.#tryPost({ type: "CANCEL_JOB", jobId: this.jobId });
  }

  keepAlive() {
    if (this.jobId && this.port) {
      return this.#tryPost({ type: "KEEPALIVE", jobId: this.jobId });
    }
    return false;
  }

  disconnect() {
    this.closedByClient = true;
    this.activeBatchIds.clear();
    this.createWaiter?.reject(new Error("PDF 翻译任务已关闭。"));
    this.createWaiter = null;
    const port = this.port;
    this.port = null;
    try {
      port?.disconnect();
    } catch {
      // The service worker may already have closed the port.
    }
  }

  #post(message) {
    if (!this.port) {
      throw new Error("PDF 翻译后台连接已断开。");
    }
    try {
      this.port.postMessage(message);
    } catch {
      throw new Error("无法向 PDF 翻译后台发送任务。");
    }
  }

  #tryPost(message) {
    try {
      this.#post(message);
      return true;
    } catch {
      return false;
    }
  }

  #handleMessage(message) {
    if (!message || typeof message !== "object" || message.jobId !== this.jobId) {
      return;
    }

    if (message.type === "JOB_CREATED") {
      const waiter = this.createWaiter;
      this.createWaiter = null;
      waiter?.resolve(message);
      this.onEvent(message);
      return;
    }

    if (message.type === "JOB_ERROR") {
      const waiter = this.createWaiter;
      this.createWaiter = null;
      const error = new Error(message.error || "PDF 翻译任务创建失败。");
      error.code = message.code || "PDF_JOB_FAILED";
      waiter?.reject(error);
      this.onEvent(message);
      return;
    }

    if (message.type === "JOB_CANCELLED") {
      const waiter = this.createWaiter;
      this.createWaiter = null;
      waiter?.reject(new Error("PDF 翻译任务已取消。"));
      this.onEvent(message);
      return;
    }

    if (typeof message.batchId === "string") {
      if (!this.activeBatchIds.has(message.batchId)) {
        return;
      }
      if (
        message.type === "BATCH_DONE" ||
        message.type === "BATCH_ERROR" ||
        message.type === "BATCH_CANCELLED"
      ) {
        this.activeBatchIds.delete(message.batchId);
      }
    }

    this.onEvent(message);
  }

  #handleDisconnect(port) {
    if (this.port !== port) {
      return;
    }
    this.port = null;
    const error = new Error("PDF 翻译后台连接已断开。");
    this.createWaiter?.reject(error);
    this.createWaiter = null;
    const activeBatchIds = [...this.activeBatchIds];
    this.activeBatchIds.clear();
    if (!this.closedByClient) {
      this.onDisconnect({ jobId: this.jobId, activeBatchIds, error });
    }
  }
}

export const PDF_JOB_PORT_NAME = PORT_NAME;
