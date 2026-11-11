import {
  ImageGenerationFailedError,
  ImageGenerationTimeoutError,
  ImageServiceAuthFailedError,
  ImageServiceUnavailableError,
  ImageWorkflowInvalidError,
} from "../domain/errors.js";
import type { ComfyNodeInfo, ImageServiceProbe } from "../domain/image-service.js";
import {
  requiredNodeTypes,
  type ComfyWorkflow,
} from "./comfyui-workflow.js";

export interface ComfyUiClientOptions {
  baseUrl: string;
  /** 反向代理常用的 Bearer 令牌；ComfyUI 自身不校验。 */
  token?: string | undefined;
  requestTimeoutMs?: number;
  generationTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ComfyUiImage {
  data: Buffer;
  mediaType: string;
  fileName: string;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/**
 * ComfyUI HTTP 客户端。只用公开接口：
 * GET /system_stats、GET /object_info、POST /prompt、GET /history/{id}、GET /view。
 * 不依赖 websocket，轮询足以覆盖单机出图。
 */
export class ComfyUiClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly requestTimeoutMs: number;
  private readonly generationTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: ComfyUiClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.generationTimeoutMs =
      options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** 探测服务能力：节点是否齐全、有哪些可用模型。 */
  async probe(
    workflow: ComfyWorkflow,
    signal?: AbortSignal,
  ): Promise<ImageServiceProbe> {
    const stats = await this.systemStats(signal);
    const nodes = await this.objectInfo(signal);
    const required = requiredNodeTypes(workflow);
    const missingNodes = required.filter((type) => nodes[type] === undefined);
    return {
      reachable: true,
      comfyuiVersion: stats.version,
      devices: stats.devices,
      workflowReady: missingNodes.length === 0,
      missingNodes,
      models: listModels(nodes),
    };
  }

  async systemStats(
    signal?: AbortSignal,
  ): Promise<{ version: string | null; devices: string[] }> {
    const body = await this.json("GET", "/system_stats", signal);
    const system = asRecord(body.system);
    const version =
      typeof system?.comfyui_version === "string"
        ? system.comfyui_version
        : null;
    const devices = Array.isArray(body.devices)
      ? body.devices
          .map((device) => asRecord(device)?.name)
          .filter((name): name is string => typeof name === "string")
      : [];
    return { version, devices };
  }

  async objectInfo(
    signal?: AbortSignal,
  ): Promise<Record<string, ComfyNodeInfo>> {
    const body = await this.json("GET", "/object_info", signal);
    const nodes: Record<string, ComfyNodeInfo> = {};
    for (const [type, info] of Object.entries(body)) {
      if (info !== null && typeof info === "object" && !Array.isArray(info)) {
        nodes[type] = info as ComfyNodeInfo;
      }
    }
    if (Object.keys(nodes).length === 0) {
      throw new ImageServiceUnavailableError("生图服务没有返回节点清单");
    }
    return nodes;
  }

  /**
   * 提交工作流并等待出图。轮询到 history 出现结果为止，
   * 中途的排队与执行状态不单独暴露，失败原因写进错误详情。
   */
  async run(
    workflow: ComfyWorkflow,
    options: {
      signal?: AbortSignal | undefined;
      outputNodeId?: string | null;
    } = {},
  ): Promise<ComfyUiImage> {
    const deadline = Date.now() + this.generationTimeoutMs;
    const promptId = await this.submit(workflow, options.signal);
    let cleaned = false;
    const cancelRemote = async (): Promise<void> => {
      cleaned = true;
      await this.cancel(promptId);
    };
    try {
      for (;;) {
        if (options.signal?.aborted === true) {
          await cancelRemote();
          throw new ImageGenerationFailedError("生图已取消");
        }
        const entry = await this.history(promptId, options.signal);
        if (entry !== null) {
          if (entry.failed) {
            throw new ImageGenerationFailedError("ComfyUI 执行工作流失败", {
              promptId,
              detail: entry.failed,
            });
          }
          const image = pickImage(entry.outputs, options.outputNodeId ?? null);
          if (image !== null) {
            return this.view(image, options.signal);
          }
        }
        if (Date.now() >= deadline) {
          await cancelRemote();
          throw new ImageGenerationTimeoutError(this.generationTimeoutMs);
        }
        await delay(this.pollIntervalMs, options.signal);
      }
    } catch (error) {
      // 轮询请求在等待中被中止时不会回到循环顶部，这里补一次远端清理。
      if (!cleaned && options.signal?.aborted === true) {
        await cancelRemote();
      }
      throw error;
    }
  }

  async submit(
    workflow: ComfyWorkflow,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await this.send("POST", "/prompt", {
      body: JSON.stringify({ prompt: workflow, client_id: "nowadays" }),
      signal,
    });
    if (response.status === 400) {
      const body = await readJson(response);
      throw new ImageWorkflowInvalidError("ComfyUI 拒绝了工作流", {
        nodeErrors: body.node_errors ?? null,
        error: body.error ?? null,
      });
    }
    assertOk(response.status, "提交工作流");
    const body = await readJson(response);
    const promptId = body.prompt_id;
    if (typeof promptId !== "string" || promptId.length === 0) {
      throw new ImageWorkflowInvalidError("ComfyUI 没有返回任务 id");
    }
    return promptId;
  }

  /** 取消排队或执行中的任务；失败只影响服务端资源，不改变本地结论。 */
  async cancel(promptId: string): Promise<void> {
    try {
      await this.send("POST", "/queue", {
        body: JSON.stringify({ delete: [promptId] }),
      });
    } catch {
      // 任务可能已经开始执行，取消失败不覆盖原本的超时或取消原因。
    }
  }

  private async history(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry | null> {
    const body = await this.json(
      "GET",
      `/history/${encodeURIComponent(promptId)}`,
      signal,
    );
    const entry = asRecord(body[promptId]);
    if (entry === undefined || entry === null) {
      return null;
    }
    const status = asRecord(entry.status);
    const statusStr = typeof status?.status_str === "string" ? status.status_str : "";
    const failed =
      statusStr === "error"
        ? failureMessage(status?.messages) ?? "ComfyUI 执行工作流失败"
        : null;
    const outputs = asRecord(entry.outputs) ?? {};
    return { failed, outputs };
  }

  private async view(
    image: ComfyImageRef,
    signal?: AbortSignal,
  ): Promise<ComfyUiImage> {
    const query = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const response = await this.send("GET", `/view?${query.toString()}`, {
      signal,
    });
    assertOk(response.status, "读取生成结果");
    const headerType = (response.headers.get("content-type") ?? "").split(";")[0]!;
    const mediaType = headerType.startsWith("image/")
      ? headerType
      : mediaTypeOf(image.filename);
    if (mediaType === null) {
      throw new ImageGenerationFailedError("生图结果不是图片", {
        contentType: headerType,
        fileName: image.filename,
      });
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (data.length === 0) {
      throw new ImageGenerationFailedError("生图结果为空");
    }
    if (data.length > MAX_IMAGE_BYTES) {
      throw new ImageGenerationFailedError("生图结果超过 32 MiB 上限");
    }
    return { data, mediaType, fileName: image.filename };
  }

  private async json(
    method: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.send(method, path, { signal });
    assertOk(response.status, path);
    return readJson(response);
  }

  private async send(
    method: string,
    path: string,
    init: { body?: string; signal?: AbortSignal | undefined },
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal =
      init.signal === undefined
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        redirect: "manual",
        headers: {
          ...(init.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...(this.token === undefined
            ? {}
            : { authorization: `Bearer ${this.token}` }),
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal,
      });
      if (response.status >= 300 && response.status < 400) {
        throw new ImageServiceUnavailableError("生图服务返回重定向，已拒绝跟随", {
          status: response.status,
        });
      }
      if (response.status === 401 || response.status === 403) {
        throw new ImageServiceAuthFailedError(response.status);
      }
      return response;
    } catch (error) {
      if (error instanceof ImageServiceAuthFailedError) {
        throw error;
      }
      if (timeout.aborted) {
        throw new ImageGenerationTimeoutError(this.requestTimeoutMs);
      }
      if (init.signal?.aborted === true) {
        throw new ImageGenerationFailedError("生图已取消");
      }
      if (error instanceof ImageServiceUnavailableError) {
        throw error;
      }
      throw new ImageServiceUnavailableError(
        `连不上生图服务：${error instanceof Error ? error.message : String(error)}`,
        { path },
      );
    }
  }
}

interface ComfyImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

interface HistoryEntry {
  failed: string | null;
  outputs: Record<string, unknown>;
}

function pickImage(
  outputs: Record<string, unknown>,
  outputNodeId: string | null,
): ComfyImageRef | null {
  const nodes =
    outputNodeId === null
      ? Object.values(outputs)
      : [outputs[outputNodeId]].filter((value) => value !== undefined);
  for (const raw of nodes) {
    const images = asRecord(raw)?.images;
    if (!Array.isArray(images)) {
      continue;
    }
    for (const item of images) {
      const image = asRecord(item);
      if (image === undefined || image === null) {
        continue;
      }
      if (typeof image.filename !== "string" || image.filename.length === 0) {
        continue;
      }
      // type 为 temp 的是预览图，正式结果取 output。
      if (image.type === "temp") {
        continue;
      }
      return {
        filename: image.filename,
        subfolder: typeof image.subfolder === "string" ? image.subfolder : "",
        type: typeof image.type === "string" ? image.type : "output",
      };
    }
  }
  return null;
}

function listModels(nodes: Record<string, ComfyNodeInfo>): string[] {
  const models = new Set<string>();
  for (const [type, key] of [
    ["CheckpointLoaderSimple", "ckpt_name"],
    ["MOSSImageUNETLoader", "unet_name"],
    ["UNETLoader", "unet_name"],
  ] as const) {
    const declaration = nodes[type]?.input?.required?.[key];
    for (const value of comboOptions(declaration)) {
      models.add(value);
    }
  }
  return [...models].sort();
}

/** ComfyUI 的下拉候选既可能是字符串数组，也可能是 ["COMBO", {options}]。 */
function comboOptions(declaration: unknown): string[] {
  if (!Array.isArray(declaration) || declaration.length === 0) {
    return [];
  }
  const first = declaration[0];
  if (Array.isArray(first)) {
    return first.filter((value): value is string => typeof value === "string");
  }
  if (first === "COMBO") {
    const options = asRecord(declaration[1])?.options;
    return Array.isArray(options)
      ? options.filter((value): value is string => typeof value === "string")
      : [];
  }
  return [];
}

function failureMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  for (const item of messages) {
    if (!Array.isArray(item) || item.length < 2) {
      continue;
    }
    if (item[0] !== "execution_error") {
      continue;
    }
    const detail = asRecord(item[1]);
    const message = detail?.exception_message;
    if (typeof message === "string" && message.length > 0) {
      return message.slice(0, 300);
    }
  }
  return null;
}

function assertOk(status: number, action: string): void {
  if (status >= 200 && status < 300) {
    return;
  }
  throw new ImageServiceUnavailableError(
    `生图服务在${action}时返回 ${status}`,
    { status },
  );
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return asRecord(parsed) ?? {};
  } catch {
    throw new ImageServiceUnavailableError("生图服务返回的不是 JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 服务没有给出 content-type 时按扩展名兜底，真正的格式仍由解码校验。 */
function mediaTypeOf(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
