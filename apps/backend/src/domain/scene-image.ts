import { z } from "zod";
import type { MessageSegmentRecord } from "./conversation.js";
import type { ImageServiceProtocol } from "./image-service.js";
import type { SceneImageSettingsRecord } from "./scene-image-settings.js";

/** 过场图触发来源：用户从指定回复发起，或整轮完成后由系统判断。 */
export type SceneImageTrigger = "manual" | "auto";

/** 纯背景图只覆盖背景层；整幅图临时覆盖背景与立绘两层。 */
export type SceneImageLayerMode = "background" | "full_scene";

export type SceneImageStatus =
  | "queued"
  | "planning"
  | "generating"
  | "succeeded"
  | "skipped"
  | "failed";

export const SCENE_IMAGE_LAYER_MODES: readonly SceneImageLayerMode[] = [
  "background",
  "full_scene",
];

export const SCENE_IMAGE_TERMINAL_STATUSES: readonly SceneImageStatus[] = [
  "succeeded",
  "skipped",
  "failed",
];

/** 本镜头实际入画的人物。服饰跟随同一人保存，防止多人画面串衣。 */
export const sceneCastSchema = z.array(z.object({
  name: z.string().trim().min(1).max(100),
  appearance: z.string().trim().max(2000),
  clothing: z.string().trim().max(1000),
})).max(16);
export type SceneCast = z.infer<typeof sceneCastSchema>;

export interface SceneImagePlanRecord {
  description: string;
  cast?: SceneCast;
  layerMode: SceneImageLayerMode;
  startSegmentId: string;
  endSegmentId: string;
}

export interface SceneImageResultRecord {
  assetId: string;
  mediaType: string;
  width: number;
  height: number;
  byteSize: number;
  createdAt: string;
}

/** 受管图片记录：相对路径只在后端使用，不通过接口暴露。 */
export interface SceneImageAssetRecord extends SceneImageResultRecord {
  taskId: string;
  roleId: string;
  windowId: string;
  messageId: string;
  relativePath: string;
}

export interface SceneImageTaskRecord {
  taskId: string;
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  trigger: SceneImageTrigger;
  layerMode: SceneImageLayerMode;
  startSegmentId: string;
  endSegmentId: string;
  status: SceneImageStatus;
  attempt: number;
  plan: SceneImagePlanRecord | null;
  errorCode: string | null;
  errorSummary: string | null;
  result: SceneImageResultRecord | null;
  createdAt: string;
  updatedAt: string;
}

/** 目标轮之前的一轮对话，用于规划器理解场景来龙去脉。 */
export interface SceneImageContextMessage {
  sender: "user" | "assistant";
  content: string;
  sequence?: number;
}

/** 目标回复实际使用的服饰；参考图是否存在由后端判定，不暴露路径。 */
export interface SceneImageOutfitInput {
  outfitId: string | null;
  name: string | null;
  description: string | null;
  hasCharacterReference: boolean;
}

export interface SceneImagePlannerInput {
  trigger?: SceneImageTrigger;
  roleId: string;
  windowId: string;
  messageId: string;
  executionId: string;
  content: string;
  segments: readonly MessageSegmentRecord[];
  outfit: SceneImageOutfitInput;
  context: readonly SceneImageContextMessage[];
  textAnchors?: {
    roleName: string;
    appearance: string;
    clothing: string;
    previousScene: { cast: SceneCast; sequence: number; outfitId: string | null } | null;
  };
  requestedLayerMode: SceneImageLayerMode | null;
}

/** 画面规划端口。模型规划与固定规划都实现该端口，缺绑定时可回退。 */
export class SceneImageNotSelected extends Error {}

export interface SceneImagePlannerPort {
  plan(
    input: SceneImagePlannerInput,
    signal?: AbortSignal,
  ): Promise<SceneImagePlanRecord>;
}

/** 生图参考图：首版只用目标回复保存的角色服饰素材。 */
export interface SceneImageReferenceImage {
  role: "character";
  mediaType: string;
  data: Buffer;
}

/** 生成器在任务接收时固定的运行配置；settings 为 null 表示当时未配置真实服务。 */
export interface SceneImageConfigSnapshot {
  version: 1;
  settings: SceneImageSettingsRecord | null;
  service: {
    protocol: ImageServiceProtocol;
    baseUrl: string;
    timeoutMs: number | null;
  } | null;
}

export interface SceneImageGenerationInput {
  roleId: string;
  prompt: string;
  cast?: SceneCast;
  layerMode: SceneImageLayerMode;
  /** 目标回复实际使用的服饰；生成器据此取该服饰的锚点提示词。 */
  outfit: SceneImageOutfitRef;
  /** 任务接收时固定的配置；缺省时按当前配置解析。 */
  config?: SceneImageConfigSnapshot | null;
  /** 只在整幅图模式下提供；纯背景图不传角色参考。 */
  references?: readonly SceneImageReferenceImage[];
  signal?: AbortSignal;
}

export interface SceneImageOutfitRef {
  outfitId: string | null;
  name: string | null;
  description: string | null;
}

export interface GeneratedSceneImage {
  data: Buffer;
  mediaType: string;
  width: number;
  height: number;
}

/** 生图适配端口。首轮使用本地假生成器，真实服务在适配时固定。 */
export interface SceneImageGeneratorPort {
  /** 任务接收时固定当前生效配置；没有可固定的配置时返回 null。 */
  lock?(roleId: string): SceneImageConfigSnapshot | null;
  generate(input: SceneImageGenerationInput): Promise<GeneratedSceneImage>;
}
