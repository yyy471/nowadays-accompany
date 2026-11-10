import { SceneImagePlanInvalidError } from "../domain/errors.js";
import type {
  SceneImageLayerMode,
  SceneImagePlanRecord,
  SceneImagePlannerInput,
  SceneImagePlannerPort,
} from "../domain/scene-image.js";

const EXCERPT_CHARS = 160;
const BACKGROUND_DESCRIPTION = "与对话氛围相符的环境背景，不出现人物。";

/**
 * 固定规划器：区间取目标回复的首段到末段，图层沿用请求或默认背景。
 * 没有可用对话模型时作为回退，保证手动任务仍能走通链路。
 * 纯背景只给中性环境提示，不把人物动作或服饰带进背景图。
 */
export class FixedSceneImagePlanner implements SceneImagePlannerPort {
  async plan(
    input: SceneImagePlannerInput,
  ): Promise<SceneImagePlanRecord> {
    const first = input.segments[0];
    const last = input.segments.at(-1);
    if (first === undefined || last === undefined) {
      throw new SceneImagePlanInvalidError("目标回复没有可用的句段");
    }
    const layerMode: SceneImageLayerMode = input.requestedLayerMode ?? "background";
    if (layerMode === "background") {
      return {
        description: BACKGROUND_DESCRIPTION,
        layerMode,
        startSegmentId: first.segmentId,
        endSegmentId: last.segmentId,
      };
    }
    const excerpt = input.content.replace(/\s+/g, " ").trim().slice(0, EXCERPT_CHARS);
    const subject =
      input.outfit.name === null ? "" : `（${input.outfit.name}）`;
    return {
      description: `${subject}${excerpt}`,
      layerMode,
      startSegmentId: first.segmentId,
      endSegmentId: last.segmentId,
    };
  }
}
