import { z } from "zod";
import type { ResourceService } from "../application/resources/resource-service.js";
import type { RoleAccess } from "../application/role/role-access.js";
import { XIA_CHENG_BUILTIN_KEY } from "../domain/admin-seat.js";
import { AppError } from "../domain/errors.js";
import { isManagedPiResource, managedPiCommand, modelConfigSchema } from "../domain/resource.js";
import type { ModelServiceConfig } from "../domain/model.js";
import { normalizeGeminiModelId } from "../model/google-gemini.js";
import { EngineeringJobs } from "../storage/conversation/engineering-jobs.js";
import type { AppStore, ResourceRecord } from "../storage/core/app-store.js";
import { runWithDecisionCommit } from "../storage/core/transaction-group.js";

const modelNameSchema = z.string().trim().min(1).max(200);
const memberSchema = z.object({
  resourceId: z.string().min(1), modelName: modelNameSchema, enabled: z.boolean(),
}).strict();
const modeSchema = z.enum(["priority", "round_robin"]);
export const engineeringSettingsUpdate = z.object({
  enabled: z.boolean().optional(), mode: modeSchema.optional(), allowShell: z.boolean().optional(), members: z.array(memberSchema).optional(),
}).strict();
type Member = z.infer<typeof memberSchema>;
type Mode = z.infer<typeof modeSchema>;
type Source = Pick<Member, "resourceId" | "modelName">;
type State = "ready" | "invalid" | "disabled" | "maintenance" | "cooldown";
type Candidate = Member & {
  key: string; config: ModelServiceConfig | null; resourceName: string | null; state: State; retryAfterSeconds: number | null;
};
function keyOf({ resourceId, modelName }: Source, models: Map<string, ResourceRecord>) {
  const google = models.get(resourceId)?.config.protocol === "google-gemini";
  return JSON.stringify([resourceId, google ? normalizeGeminiModelId(modelName) : modelName]);
}
const eligible = ({ state }: Candidate) => state === "ready" || state === "maintenance" || state === "cooldown";

function validModelName(name: string, config: ModelServiceConfig) {
  if (!modelNameSchema.safeParse(name).success) return false;
  if (config.protocol !== "google-gemini") return true;
  // SDK 路由固定只接受最后一段型号。兼容 Nowadays 目录已有的两个模型名前缀。
  const id = normalizeGeminiModelId(name);
  return /^[\w.@~-]+$/.test(id) && !id.includes("..") && id !== ".";
}

/** 持久化配置由宿主共享；调度游标和源故障冷却只属于本次运行。 */
export class EngineeringPool {
  private lastAssigned: string | null = null;
  private cooldowns = new Map<string, number>();

  constructor(private app: AppStore, private resources: ResourceService, private access: RoleAccess,
    private now: () => number = Date.now) {}

  private read() {
    const row = this.app.db.prepare("SELECT mode, members_json, allow_shell FROM engineering_settings WHERE id=1")
      .get() as { mode: Mode; members_json: string; allow_shell: number };
    return { mode: row.mode, members: JSON.parse(row.members_json) as Member[], allowShell: row.allow_shell === 1 };
  }

  private piResource() { return this.app.listResources("mcp").find(isManagedPiResource); }

  private seatBinding(roleId: string, piId: string) {
    return this.access.withStore(roleId, ({ business }) => business.listRoleBindings(roleId)
      .some(binding => binding.capability === "mcp" && binding.resourceId === piId && binding.enabled));
  }

  private candidate(member: Member, models: Map<string, ResourceRecord>, continued = false): Candidate {
    const service = models.get(member.resourceId);
    const parsed = modelConfigSchema.safeParse(service?.config);
    const config = parsed.success ? parsed.data : null;
    const key = keyOf(member, models);
    const until = this.cooldowns.get(key);
    const remaining = until === undefined ? 0 : Math.ceil((until - this.now()) / 1000);
    if (until !== undefined && remaining <= 0) this.cooldowns.delete(key);
    let state: State;
    if (!config || !service || !validModelName(member.modelName, config)) state = "invalid";
    else if (!continued && (!member.enabled || !service.enabled)) state = "disabled";
    else if (this.resources.isUnderMaintenance(member.resourceId)) state = "maintenance";
    else if (remaining > 0) state = "cooldown";
    else state = "ready";
    return { ...member, key, config, resourceName: service?.name ?? null, state, retryAfterSeconds: state === "cooldown" ? remaining : null };
  }

  private models() {
    return new Map(this.app.listResources("model").map(resource => [resource.resourceId, resource]));
  }

  settings() {
    const { mode, members, allowShell } = this.read();
    const models = this.models();
    const view = members.map(member => {
      const { config, key, ...summary } = this.candidate(member, models);
      return summary;
    });
    const pi = this.piResource(), seat = this.app.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    const enabled = Boolean(pi?.enabled);
    let readiness: "disabled" | "unbound" | "empty" | "ready" | "exhausted";
    if (!pi?.enabled) readiness = "disabled";
    else if (seat?.initStatus !== "ready" || !this.seatBinding(seat.roleId, pi.resourceId)) readiness = "unbound";
    else if (view.some(row => row.state === "ready")) readiness = "ready";
    else if (view.some(row => row.state === "maintenance" || row.state === "cooldown")) readiness = "exhausted";
    else readiness = "empty";
    return { enabled, mode, allowShell, members: view, readiness };
  }

  update(input: z.infer<typeof engineeringSettingsUpdate>) {
    const save = () => {
      const prior = this.read();
      const members = input.members ?? prior.members;
      if (input.members) {
        const models = this.models();
        const previous = new Set(prior.members.map(member => keyOf(member, models)));
        const seen = new Set<string>();
        for (const member of members) {
          const key = keyOf(member, models);
          if (seen.has(key)) throw new AppError(400, "ENGINEERING_MEMBER_DUPLICATE", "消耗池中的模型重复");
          seen.add(key);
          if (!previous.has(key) && this.candidate(member, models).state === "invalid")
            throw new AppError(400, "ENGINEERING_MEMBER_INVALID", "请选择有效的模型服务和型号");
        }
      }
      this.app.db.prepare("UPDATE engineering_settings SET mode=?, members_json=?, allow_shell=? WHERE id=1")
        .run(input.mode ?? prior.mode, JSON.stringify(members), Number(input.allowShell ?? prior.allowShell));
      if (input.enabled === undefined) return;
      const pi = this.piResource();
      if (pi) return this.app.updateResource({ resourceId: pi.resourceId, enabled: input.enabled });
      if (input.enabled) return this.resources.create({ kind: "mcp", name: "内置 Pi 工程助手", enabled: true,
        config: { command: managedPiCommand, args: [], env: {} } });
    };
    if (input.enabled === true) {
      const seat = this.app.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
      if (seat?.initStatus !== "ready") throw new AppError(409, "PI_ADMIN_SEAT_UNAVAILABLE", "主角色席位尚未就绪");
      this.access.withStore(seat.roleId, ({ business }) => {
        // 全局变更先提交；席位提交失败时明确返回可重试，当前未绑定状态对读取方可见。
        const result = runWithDecisionCommit(this.app.db, [business.db], () => {
          const pi = save()!;
          business.ensureMcpBinding(seat.roleId, pi.resourceId, true);
        });
        if (!result.followersCommitted) throw new AppError(503, "PI_BINDING_SAVE_FAILED", "请重试开启工程助手以保存主角色绑定");
      });
    } else {
      this.app.db.transaction(save).immediate();
    }
    return this.settings();
  }

  private candidates(roleId: string, taskId?: string | null) {
    const { mode, members, allowShell } = this.read();
    const seat = this.app.getRoleIndexByBuiltinKey(XIA_CHENG_BUILTIN_KEY);
    const rows = new Map<string, Candidate>();
    if (seat?.roleId !== roleId || seat.initStatus !== "ready") return { mode, allowShell, rows: [] };
    const pi = this.piResource();
    const models = this.models();
    if (pi?.enabled && this.seatBinding(roleId, pi.resourceId)) {
      for (const member of members) {
        const row = this.candidate(member, models);
        rows.set(row.key, row);
      }
    }
    if (taskId) {
      const history = this.access.withStore(roleId, ({ business }) => new EngineeringJobs(business.db).chainModels(taskId));
      for (const source of history) {
        const row = this.candidate({ ...source, enabled: true }, models, true);
        rows.set(row.key, row);
      }
    }
    return { mode, allowShell, rows: [...rows.values()] };
  }

  discover(roleId: string, taskId?: string | null) {
    return this.candidates(roleId, taskId).rows.some(eligible);
  }

  allocate(roleId: string, taskId: string) {
    const { mode, allowShell, rows } = this.candidates(roleId, taskId);
    const start = mode === "round_robin" ? rows.findIndex(row => row.key === this.lastAssigned) + 1 : 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[(start + i) % rows.length]!;
      if (row.state !== "ready" || !row.config) continue;
      this.lastAssigned = row.key;
      return { resourceId: row.resourceId, modelName: row.modelName, config: row.config, allowShell };
    }
    const available = rows.filter(eligible);
    const waits = available.flatMap(row => row.retryAfterSeconds === null ? [] : [row.retryAfterSeconds]);
    const retryAfterSeconds = waits.length ? Math.min(...waits) : null;
    const reasons = [...new Set(available.map(row => row.state))];
    const reason = reasons.length ? reasons.join(", ") : "empty";
    throw new AppError(409, "PI_ENGINEERING_POOL_EXHAUSTED", "工程模型池暂无可用成员（" + reason + "）" +
      (retryAfterSeconds === null ? "" : "，可在 " + retryAfterSeconds + " 秒后重试"), { reasons, retryAfterSeconds });
  }

  reportFailure(resourceId: string, modelName: string, retryAfter?: string | null) {
    const now = this.now();
    const header = retryAfter?.trim() ?? "";
    let until = now + 180_000;
    // HTTP Retry-After 支持非负整数秒或 HTTP 日期；非法值使用默认冷却。
    const requested = /^\d+$/.test(header) ? now + Number(header) * 1000 :
      /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*[, ]/i.test(header) ? Date.parse(header) : NaN;
    if (Number.isSafeInteger(requested)) until = Math.max(until, requested);
    const key = keyOf({ resourceId, modelName }, this.models());
    this.cooldowns.set(key, Math.max(this.cooldowns.get(key) ?? 0, until));
  }
}
