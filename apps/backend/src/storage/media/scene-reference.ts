import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AppError } from "../../domain/errors.js";
import type { InspectedImage, UploadedImage } from "../../domain/appearance.js";
import type { RoleStorage } from "../core/role-storage.js";
import { AppearanceStore } from "./appearance-store.js";
import { detectImageFormat } from "../../application/media/image-inspect.js";

export const MAX_SCENE_REFERENCE_BYTES = 8 * 1024 * 1024;
export interface SceneReference {
  outfitId: string;
  assetId: string;
  relativePath: string;
  mediaType: string;
}
const columns = "outfit_id AS outfitId, asset_id AS assetId, relative_path AS relativePath, media_type AS mediaType";

export function sceneReference(storage: RoleStorage, roleId: string, outfitId: string): SceneReference | null {
  return storage.business.db.prepare(`SELECT ${columns} FROM role_scene_references WHERE role_id=? AND outfit_id=?`)
    .get(roleId, outfitId) as SceneReference | undefined ?? null;
}
export function listSceneReferences(storage: RoleStorage, roleId: string): SceneReference[] {
  return storage.business.db.prepare(`SELECT ${columns} FROM role_scene_references WHERE role_id=? ORDER BY outfit_id`)
    .all(roleId) as SceneReference[];
}
/** 角色是否仍有未结束的过场图任务；替换参考图时据此决定是否延迟清理旧文件。 */
export function hasUnfinishedSceneImageTasks(storage: RoleStorage, roleId: string): boolean {
  return storage.business.db.prepare(
    "SELECT 1 FROM scene_image_tasks WHERE role_id = ? AND status IN ('queued', 'planning', 'generating') LIMIT 1",
  ).get(roleId) !== undefined;
}
function location(storage: RoleStorage, reference: SceneReference): string {
  const file = path.posix.basename(reference.relativePath);
  if (reference.relativePath !== "appearance/" + file || !/^[\da-f-]{36}\.(png|jpg|webp)$/.test(file) || !file.startsWith(reference.assetId + ".")) {
    throw new AppError(500, "SCENE_REFERENCE_INVALID", "服饰参考图路径无效");
  }
  return path.join(storage.paths.appearanceDir, file);
}
/** 按已固定的引用记录读取并校验参考图；任务快照据此避开已被热替换的当前记录。 */
export function readSceneReferenceByRecord(storage: RoleStorage, row: SceneReference) {
  const file = location(storage, row);
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.nlink !== 1 || stat.size > MAX_SCENE_REFERENCE_BYTES) {
    throw new AppError(404, "SCENE_REFERENCE_UNAVAILABLE", "保存的服饰参考图不可读，请重新上传");
  }
  const data = fs.readFileSync(file);
  if (detectImageFormat(data)?.mediaType !== row.mediaType) throw new AppError(422, "SCENE_REFERENCE_INVALID", "保存的参考图格式无效");
  return { role: "character" as const, assetId: row.assetId, mediaType: row.mediaType, data };
}
export function readSceneReference(storage: RoleStorage, roleId: string, outfitId: string) {
  const row = sceneReference(storage, roleId, outfitId);
  if (!row) throw new AppError(404, "SCENE_REFERENCE_MISSING", "该套服饰尚未上传图生图参考图");
  return readSceneReferenceByRecord(storage, row);
}
export function requireReferenceOutfit(storage: RoleStorage, roleId: string, outfitId: string) {
  if (!new AppearanceStore(storage.business.db, roleId).getOutfit(outfitId)) throw new AppError(404, "OUTFIT_NOT_FOUND", "服饰不存在");
}
export function discardReferenceFile(storage: RoleStorage, row: SceneReference | null) {
  if (!row) return;
  try { fs.unlinkSync(location(storage, row)); } catch { /* 已提交的更换或删除不受旧文件清理失败影响。 */ }
}
export function removeSceneReference(storage: RoleStorage, roleId: string, outfitId: string) {
  const old = sceneReference(storage, roleId, outfitId);
  storage.business.db.prepare("DELETE FROM role_scene_references WHERE role_id=? AND outfit_id=?").run(roleId, outfitId);
  return old;
}
export function saveSceneReference(
  storage: RoleStorage,
  roleId: string,
  outfitId: string,
  image: UploadedImage,
  info: InspectedImage,
  options?: { deferDiscard?: boolean },
) {
  requireReferenceOutfit(storage, roleId, outfitId);
  const assetId = randomUUID();
  const row = { outfitId, assetId, relativePath: "appearance/" + assetId + info.extension, mediaType: info.mediaType };
  const out = location(storage, row);
  fs.mkdirSync(storage.paths.appearanceDir, { recursive: true });
  const fd = fs.openSync(out, "wx");
  let deferredDiscard: SceneReference | null = null;
  try {
    try { fs.writeFileSync(fd, image.data); } finally { fs.closeSync(fd); }
    const previous = storage.business.db.transaction(() => {
      requireReferenceOutfit(storage, roleId, outfitId);
      const old = sceneReference(storage, roleId, outfitId);
      storage.business.db.prepare(`INSERT INTO role_scene_references (role_id,outfit_id,asset_id,relative_path,media_type,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(outfit_id) DO UPDATE SET asset_id=excluded.asset_id,relative_path=excluded.relative_path,
        media_type=excluded.media_type,updated_at=excluded.updated_at`).run(roleId, outfitId, assetId, row.relativePath, info.mediaType, new Date().toISOString());
      return old;
    }).immediate();
    // 仍有在途任务时保留旧文件，等任务按固定引用结算后再清理，避免读到一半被删。
    if (options?.deferDiscard === true) deferredDiscard = previous;
    else discardReferenceFile(storage, previous);
  } catch (error) { discardReferenceFile(storage, row); throw error; }
  return { outfitId, assetId, mediaType: info.mediaType, deferredDiscard };
}
