import { z } from "zod";
import { credentialRefSchema, modelBaseUrlSchema } from "./resource.js";

/**
 * 首版只适配 ComfyUI：它本身不规定模型，同一套接口可以跑
 * MOSS-Image、Flux、SDXL 等不同开源模型，差异落在工作流模板上。
 */
export const IMAGE_SERVICE_PROTOCOLS = ["comfyui"] as const;
export type ImageServiceProtocol = (typeof IMAGE_SERVICE_PROTOCOLS)[number];

export const imageServiceConfigSchema = z
  .object({
    protocol: z.literal("comfyui"),
    baseUrl: modelBaseUrlSchema,
    /** 全局默认生图模型名（通常为 ComfyUI checkpoints 文件名）；未设置时需在角色配置里手动填写或探测选择。 */
    modelName: z.string().trim().min(1).max(300).optional(),
    credentialRef: credentialRefSchema.optional(),
    /** 单次生成的整体等待上限；ComfyUI 首次加载大模型可能很慢。 */
    timeoutMs: z.number().int().min(5_000).max(900_000).optional(),
  })
  .strict();

export type ImageServiceConfig = z.infer<typeof imageServiceConfigSchema>;

export interface ImageServiceRecord {
  serviceId: string;
  name: string;
  enabled: boolean;
  config: ImageServiceConfig;
  createdAt: string;
  updatedAt: string;
}

/** 读接口使用的服务视图：只暴露凭据状态，不回明文。 */
export interface ImageServiceView extends ImageServiceRecord {
  credential: {
    status: "stored" | "reference" | "missing" | "unavailable";
    reference: string | null;
    resolvable: boolean;
  };
}

/** 探测结果：能跑什么、缺什么。 */
export interface ImageServiceProbe {
  reachable: boolean;
  comfyuiVersion: string | null;
  devices: string[];
  /** 内置或当前工作流所需的节点是否齐全。 */
  workflowReady: boolean;
  missingNodes: string[];
  /** 探测到的可用模型标识（unet_name／ckpt_name）。 */
  models: string[];
}

export interface ImageServiceProbeResult {
  probe: ImageServiceProbe;
  elapsedMs: number;
}

/** 协议与 origin 相同才算同一个服务；换域名或端口需要重新确认凭据。 */
export function imageServiceSiteIdentity(
  config: Pick<ImageServiceConfig, "protocol" | "baseUrl">,
): string {
  try {
    return `${config.protocol} ${new URL(config.baseUrl).origin}`;
  } catch {
    return `${config.protocol} ${config.baseUrl}`;
  }
}

/** ComfyUI /object_info 里与生图相关的节点声明，只保留会用到的字段。 */
export interface ComfyNodeInfo {
  input?: {
    required?: Record<string, unknown>;
    optional?: Record<string, unknown>;
  };
  output?: unknown;
  output_node?: boolean;
}
