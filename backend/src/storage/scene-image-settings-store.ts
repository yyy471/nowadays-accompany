import type Database from "better-sqlite3";
import type {
  SceneImageSettingsInput,
  SceneImageSettingsRecord,
} from "../domain/scene-image-settings.js";

interface SettingsRow {
  role_id: string;
  service_id: string;
  model_type: string;
  model_path: string;
  base_prompt: string;
  negative_prompt: string;
  outfit_prompts_json: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed: number | null;
  workflow_json: string | null;
  output_node_id: string | null;
  updated_at: string;
}

/** 每个角色只有一份生图配置，保存即整份覆盖（与语音配置一致）。 */
export class SceneImageSettingsStore {
  constructor(
    private readonly db: Database.Database,
    private readonly roleId: string,
  ) {}

  get(): SceneImageSettingsRecord | null {
    const row = this.db
      .prepare(
        `SELECT role_id, service_id, model_type, model_path, base_prompt,
                negative_prompt, outfit_prompts_json, width, height, steps, cfg,
                sampler, scheduler, seed, workflow_json, output_node_id, updated_at
           FROM role_scene_image_settings WHERE role_id = ?`,
      )
      .get(this.roleId) as SettingsRow | undefined;
    return row === undefined ? null : mapRow(row);
  }

  /** 删除服饰后清掉它的提示词，避免生图配置保留孤儿键。 */
  removeOutfitPrompt(outfitId: string, now: string): void {
    const current = this.get();
    if (current === null || !(outfitId in current.outfitPrompts)) {
      return;
    }
    const next = { ...current.outfitPrompts };
    delete next[outfitId];
    this.db
      .prepare(
        "UPDATE role_scene_image_settings SET outfit_prompts_json = ?, updated_at = ? WHERE role_id = ?",
      )
      .run(JSON.stringify(next), now, this.roleId);
  }

  save(input: SceneImageSettingsInput, now: string): SceneImageSettingsRecord {    this.db
      .prepare(
        `INSERT INTO role_scene_image_settings
           (role_id, service_id, model_type, model_path, base_prompt, negative_prompt,
            outfit_prompts_json, width, height, steps, cfg, sampler, scheduler,
            seed, workflow_json, output_node_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(role_id) DO UPDATE SET
           service_id = excluded.service_id,
           model_type = excluded.model_type,
           model_path = excluded.model_path,
           base_prompt = excluded.base_prompt,
           negative_prompt = excluded.negative_prompt,
           outfit_prompts_json = excluded.outfit_prompts_json,
           width = excluded.width,
           height = excluded.height,
           steps = excluded.steps,
           cfg = excluded.cfg,
           sampler = excluded.sampler,
           scheduler = excluded.scheduler,
           seed = excluded.seed,
           workflow_json = excluded.workflow_json,
           output_node_id = excluded.output_node_id,
           updated_at = excluded.updated_at`,
      )
      .run(
        this.roleId,
        input.serviceId,
        input.modelType,
        input.modelPath,
        input.basePrompt,
        input.negativePrompt,
        JSON.stringify(input.outfitPrompts),
        input.width,
        input.height,
        input.steps,
        input.cfg,
        input.sampler,
        input.scheduler,
        input.seed,
        input.workflow === null ? null : JSON.stringify(input.workflow),
        input.outputNodeId,
        now,
      );
    return this.get()!;
  }
}

function mapRow(row: SettingsRow): SceneImageSettingsRecord {
  return {
    roleId: row.role_id,
    serviceId: row.service_id,
    modelType: row.model_type as SceneImageSettingsRecord["modelType"],
    modelPath: row.model_path,
    basePrompt: row.base_prompt,
    negativePrompt: row.negative_prompt,
    outfitPrompts: JSON.parse(row.outfit_prompts_json) as Record<string, string>,
    width: row.width,
    height: row.height,
    steps: row.steps,
    cfg: row.cfg,
    sampler: row.sampler,
    scheduler: row.scheduler,
    seed: row.seed,
    workflow:
      row.workflow_json === null
        ? null
        : (JSON.parse(row.workflow_json) as Record<string, unknown>),
    outputNodeId: row.output_node_id,
    updatedAt: row.updated_at,
  };
}
