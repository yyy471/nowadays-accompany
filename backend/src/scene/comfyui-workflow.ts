import { ImageWorkflowInvalidError } from "../domain/errors.js";

/**
 * ComfyUI 工作流（API 格式）与参数打补丁。
 *
 * ComfyUI 本身不规定模型：换模型换的是工作流里的加载节点和采样参数。
 * 因此这里不按节点 id 写死，而是按 class_type 定位——用户从 ComfyUI
 * 「Save (API Format)」导出的官方工作流节点 id 各不相同，也能直接用。
 */

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export type ComfyWorkflow = Record<string, ComfyNode>;

/** 加载节点的候选与对应的模型参数键，按优先级排列。 */
const LOADER_INPUTS: ReadonlyArray<readonly [string, string]> = [
  ["MOSSImageHFLoader", "model_path"],
  ["MOSSImageUNETLoader", "unet_name"],
  ["CheckpointLoaderSimple", "ckpt_name"],
  ["UNETLoader", "unet_name"],
];

/**
 * 首版默认工作流：MOSS-Image 官方推荐参数（50 steps、CFG 3、Shift 5、
 * 负分支跳层 22、Euler + sgm_uniform、1024×1024）。
 * 官方示例在 comfyui/moss-image/example_workflows/moss-image-api.json。
 */
const MOSS_IMAGE_WORKFLOW: ComfyWorkflow = {
  "1": {
    class_type: "MOSSImageHFLoader",
    inputs: {
      model_path: "MOSS-Image-Base",
      weight_dtype: "default",
      text_device: "default",
    },
    _meta: { title: "MOSS-Image HF Loader" },
  },
  "2": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["1", 1] },
    _meta: { title: "正向提示词" },
  },
  "3": {
    class_type: "CLIPTextEncode",
    inputs: { text: "", clip: ["1", 1] },
    _meta: { title: "负向提示词" },
  },
  "4": {
    class_type: "EmptyFlux2LatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  "5": {
    class_type: "ModelSamplingSD3",
    inputs: { shift: 5, model: ["1", 0] },
  },
  "6": {
    class_type: "SkipLayerGuidanceDiTSimple",
    inputs: {
      model: ["5", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      double_layers: "",
      single_layers: "22",
      start_percent: 0,
      end_percent: 1,
    },
  },
  "7": {
    class_type: "KSampler",
    inputs: {
      model: ["6", 0],
      positive: ["2", 0],
      negative: ["3", 0],
      latent_image: ["4", 0],
      seed: 42,
      steps: 50,
      cfg: 3,
      sampler_name: "euler",
      scheduler: "sgm_uniform",
      denoise: 1,
    },
  },
  "8": {
    class_type: "VAEDecode",
    inputs: { samples: ["7", 0], vae: ["1", 2] },
  },
  "9": {
    class_type: "SaveImage",
    inputs: { images: ["8", 0], filename_prefix: "nowadays" },
  },
};

export function defaultComfyWorkflow(): ComfyWorkflow {
  return cloneWorkflow(MOSS_IMAGE_WORKFLOW);
}

/** 校验工作流形状：至少一个节点，每个节点有 class_type 与 inputs。 */
export function parseComfyWorkflow(value: unknown): ComfyWorkflow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("工作流必须是节点 id 到节点定义的映射");
  }
  const workflow: ComfyWorkflow = {};
  for (const [id, raw] of Object.entries(value as Record<string, unknown>)) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`节点 ${id} 的定义不是对象`);
    }
    const node = raw as { class_type?: unknown; inputs?: unknown };
    if (typeof node.class_type !== "string" || node.class_type.length === 0) {
      throw new Error(`节点 ${id} 缺少 class_type`);
    }
    if (
      node.inputs === null ||
      typeof node.inputs !== "object" ||
      Array.isArray(node.inputs)
    ) {
      throw new Error(`节点 ${id} 缺少 inputs`);
    }
    const meta = (raw as { _meta?: Record<string, unknown> })._meta;
    workflow[id] = {
      class_type: node.class_type,
      inputs: { ...(node.inputs as Record<string, unknown>) },
      ...(meta === undefined ? {} : { _meta: meta }),
    };
  }
  if (Object.keys(workflow).length === 0) {
    throw new Error("工作流没有任何节点");
  }
  return workflow;
}

/** 校验自定义工作流并在指定输出节点时确认节点存在。 */
export function validateComfyWorkflow(
  value: Record<string, unknown>,
  outputNodeId: string | null = null,
): ComfyWorkflow {
  let workflow: ComfyWorkflow;
  try {
    workflow = parseComfyWorkflow(value);
  } catch (error) {
    throw new ImageWorkflowInvalidError(
      error instanceof Error ? error.message : "工作流结构不正确",
    );
  }
  if (outputNodeId !== null && workflow[outputNodeId] === undefined) {
    throw new ImageWorkflowInvalidError("输出节点不在工作流里", {
      outputNodeId,
    });
  }
  return workflow;
}

export function requiredNodeTypes(workflow: ComfyWorkflow): string[] {
  return [...new Set(Object.values(workflow).map((node) => node.class_type))].sort();
}

export interface SceneImageWorkflowParams {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number;
  /** MOSS-Image 的本地模型目录，写入加载节点的模型参数。 */
  modelPath: string;
}

export interface PatchedWorkflow {
  workflow: ComfyWorkflow;
  /** 输出节点 id；找不到 SaveImage 时为 null。 */
  outputNodeId: string | null;
}

/**
 * 把本次生成的参数写进工作流。只改存在的键，不新增未知键，
 * 避免把模型不需要的参数塞给 ComfyUI 导致校验失败。
 */
export function applyWorkflowParams(
  source: ComfyWorkflow,
  params: SceneImageWorkflowParams,
  outputNodeId: string | null = null,
): PatchedWorkflow {
  const workflow = cloneWorkflow(source);
  const nodes = Object.entries(workflow);

  const loader = LOADER_INPUTS.map(([type, key]) => ({
    node: nodes.find(([, node]) => node.class_type === type),
    key,
  })).find((candidate) => candidate.node !== undefined);
  if (loader?.node !== undefined) {
    setInput(loader.node[1], loader.key, params.modelPath);
  }

  const sampler = nodes.find(
    ([, node]) =>
      node.class_type === "KSampler" || node.class_type === "KSamplerAdvanced",
  );
  if (sampler !== undefined) {
    const [, node] = sampler;
    // KSamplerAdvanced 用 noise_seed；两个键都试，只改存在的那个。
    setInput(node, "seed", params.seed);
    setInput(node, "noise_seed", params.seed);
    setInput(node, "steps", params.steps);
    setInput(node, "cfg", params.cfg);
    setInput(node, "sampler_name", params.sampler);
    setInput(node, "scheduler", params.scheduler);
    setTextOfLink(workflow, node.inputs.positive, params.prompt);
    setTextOfLink(workflow, node.inputs.negative, params.negativePrompt);
  }

  const latent = nodes.find(
    ([, node]) =>
      node.class_type.startsWith("Empty") &&
      "width" in node.inputs &&
      "height" in node.inputs,
  );
  if (latent !== undefined) {
    setInput(latent[1], "width", params.width);
    setInput(latent[1], "height", params.height);
    setInput(latent[1], "batch_size", 1);
  }

  const output =
    outputNodeId ??
    nodes.find(([, node]) => node.class_type === "SaveImage")?.[0] ??
    null;
  return { workflow, outputNodeId: output };
}

/** 沿 [节点 id, 输出序号] 找到文本编码节点并写入提示词。 */
function setTextOfLink(
  workflow: ComfyWorkflow,
  link: unknown,
  text: string,
): void {
  if (!Array.isArray(link) || link.length === 0) {
    return;
  }
  const target = workflow[String(link[0])];
  if (target === undefined) {
    return;
  }
  setInput(target, "text", text);
}

function setInput(node: ComfyNode, key: string, value: unknown): void {
  if (key in node.inputs) {
    node.inputs[key] = value;
  }
}

function cloneWorkflow(workflow: ComfyWorkflow): ComfyWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ComfyWorkflow;
}
