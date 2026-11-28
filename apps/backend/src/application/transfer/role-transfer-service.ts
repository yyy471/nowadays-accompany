import path from "node:path";
import type { BackendConfig } from "../../bootstrap/config.js";
import { AppError } from "../../domain/errors.js";
import type { AppStore } from "../../storage/core/app-store.js";
import type { FeedEventHub } from "../conversation/feed-events.js";
import type { RoleAccess } from "../role/role-access.js";
import type { RoleActivityService } from "../role/role-activity-service.js";
import { readRoleTransferPackageAsync, MAX_ROLE_TRANSFER_PACKAGE_BYTES,
  type ReadRoleTransferPackageOptions, type RoleTransferPackage } from "./role-transfer-package.js";
import { checkTransferRoleDirectory } from "./role-transfer-publication.js";
import {
  applyRoleTransferPackageWithStore,
  assertRoleTransferPackagePath,
  exportRoleTransferWithStore,
  preflightRoleTransferPackageWithStore,
  type TransferChoice,
} from "./role-transfer.js";

export interface RoleTransferHttpServiceDeps {
  config: BackendConfig;
  appStore: AppStore;
  roleAccess: RoleAccess;
  activity: RoleActivityService;
  feedEvents: FeedEventHub;
  /** 迁移包读取上限，默认 256 MiB；测试或受限部署可调小。 */
  maxPackageBytes?: number;
  /**
   * 测试注入的读包实现，用于断言预检／导入各自只读取一次。
   * 生产环境使用带安全与体积检查的异步读取。
   */
  readPackage?: (file: string, options?: ReadRoleTransferPackageOptions) => Promise<RoleTransferPackage>;
}

/** ROLE_TRANSFER_* 错误到 HTTP 语意的映射（英文 code + 中文说明）。 */
const TRANSFER_STATUS: Readonly<Record<string, number>> = {
  ROLE_TRANSFER_ROLE_MISSING: 404,
  ROLE_TRANSFER_PREFLIGHT_STALE: 409,
  ROLE_TRANSFER_CHOICE_REQUIRED: 409,
  ROLE_TRANSFER_PRESET_KEY_IN_USE: 409,
  ROLE_TRANSFER_ROLE_PENDING_DELETION: 409,
  ROLE_TRANSFER_ROLE_NOT_READY: 409,
  ROLE_TRANSFER_PACKAGE_TOO_LARGE: 413,
  ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID: 400,
};

const TRANSFER_MESSAGES: Readonly<Record<string, string>> = {
  ROLE_TRANSFER_ROLE_MISSING: "角色不存在或迁移目录缺失",
  ROLE_TRANSFER_PREFLIGHT_STALE: "预检结果已过期，请重新预检后再导入",
  ROLE_TRANSFER_CHOICE_REQUIRED: "时间线已分化，请先选择保留本机还是采用迁移包",
  ROLE_TRANSFER_PRESET_KEY_IN_USE: "目标安装已有相同预置身份的角色",
  ROLE_TRANSFER_ROLE_PENDING_DELETION: "角色正在删除，暂不能迁移",
  ROLE_TRANSFER_ROLE_NOT_READY: "角色尚未初始化完成，暂不能迁移",
  ROLE_TRANSFER_PACKAGE_INVALID: "迁移包内容不合法",
  ROLE_TRANSFER_PACKAGE_DIGEST_MISMATCH: "迁移包摘要校验失败",
  ROLE_TRANSFER_PACKAGE_TOO_LARGE: "迁移包体积超过上限（最大 256 MiB）",
  ROLE_TRANSFER_PACKAGE_EXTENSION_INVALID: "迁移包文件必须使用 .json 扩展名",
  ROLE_TRANSFER_PACKAGE_IN_MANAGED_DIRECTORY: "迁移包不能放在应用数据目录内",
  ROLE_TRANSFER_UNSAFE_PATH: "迁移包路径不安全或文件不存在",
  ROLE_TRANSFER_MAPPING_KEY_UNKNOWN: "目标映射包含迁移包中不存在的绑定",
};

/**
 * 把迁移核心抛出的字符串错误转换成结构化 AppError。
 *
 * 迁移核心保持与 CLI 一致的 `ROLE_TRANSFER_*` 错误码；HTTP 层据此决定
 * 404／409／400，避免把可恢复的业务判断暴露成 500。
 */
function mapTransferError(error: unknown): never {
  if (error instanceof AppError) throw error;
  const message = error instanceof Error ? error.message : "";
  const transferCode = /^ROLE_TRANSFER_[A-Z_]+/.exec(message)?.[0];
  if (transferCode !== undefined) {
    throw new AppError(
      TRANSFER_STATUS[transferCode] ?? 400,
      transferCode,
      TRANSFER_MESSAGES[transferCode] ?? "迁移操作失败，请检查迁移包与角色状态",
    );
  }
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT" || code === "EACCES" || code === "EISDIR" || error instanceof SyntaxError) {
    throw new AppError(400, "ROLE_TRANSFER_PACKAGE_UNREADABLE", "迁移包不存在或无法读取");
  }
  throw error;
}

/**
 * 运行态单角色迁移服务（409 UX-05）。
 *
 * 后端进程启动后长期持有安装锁和 `AppStore`，因此不能复用离线 CLI 的
 * `withInstallation`。这里改用接受已打开 `AppStore` 的核心函数，并通过
 * 实例级串行队列避免并发导出／导入互相踩踏。
 */
export class RoleTransferHttpService {
  /** 串行尾结点：导出与导入依次执行，一次失败不会卡住后续请求。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: RoleTransferHttpServiceDeps) {}

  private get maxBytes(): number {
    return this.deps.maxPackageBytes ?? MAX_ROLE_TRANSFER_PACKAGE_BYTES;
  }

  /** 每次预检或导入只读取并校验一份包快照。 */
  private readPackage(file: string): Promise<RoleTransferPackage> {
    return (this.deps.readPackage ?? readRoleTransferPackageAsync)(file, { maxBytes: this.maxBytes });
  }

  private enqueue<T>(action: () => Promise<T> | T): Promise<T> {
    const run = this.queue.then(() => action());
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  exportRole(roleId: string, file: string) {
    return this.enqueue(async () => {
      try {
        this.deps.roleAccess.requireReady(roleId);
        const result = await this.deps.activity.guardRole(roleId, async () => {
          await this.deps.roleAccess.blockAndEvict(roleId);
          try {
            return exportRoleTransferWithStore(
              this.deps.config, this.deps.appStore, roleId, file, { maxBytes: this.maxBytes },
            );
          } finally {
            this.deps.roleAccess.unblock(roleId);
          }
        });
        return { ...result, file: path.resolve(file) };
      } catch (error) {
        return mapTransferError(error);
      }
    });
  }

  preflightImport(file: string, mapping: Record<string, string> = {}) {
    return this.enqueue(async () => {
      try {
        // 先保持与同步 CLI 相同的目录与扩展名检查，再做唯一一次异步读取。
        assertRoleTransferPackagePath(this.deps.config, file);
        const incoming = await this.readPackage(file);
        const roleId = incoming.roleId;
        const rawDisplayName = incoming.tables.roles[0]?.display_name;
        const displayName = typeof rawDisplayName === "string" ? rawDisplayName : null;
        let localActivityState: string | null = null;
        if (this.deps.appStore.getRoleIndex(roleId) !== null) {
          localActivityState = this.deps.activity.view(roleId).state;
          // 已停止角色先关闭本机连接，确保 WAL 落盘后预检读到完整时间线。
          if (localActivityState === "stopped") await this.deps.roleAccess.evict(roleId);
        }
        const preview = preflightRoleTransferPackageWithStore(
          this.deps.config, this.deps.appStore, incoming, mapping,
        );
        return { ...preview, displayName, localActivityState };
      } catch (error) {
        return mapTransferError(error);
      }
    });
  }

  applyImport(input: {
    file: string;
    token: string;
    mapping?: Record<string, string>;
    choice?: TransferChoice;
  }) {
    return this.enqueue(async () => {
      try {
        assertRoleTransferPackagePath(this.deps.config, input.file);
        // 应用阶段重新读取并校验一次包，与预检之间不共享文件结果。
        const incoming = await this.readPackage(input.file);
        const roleId = incoming.roleId;
        const exists =
          Boolean(this.deps.appStore.getRoleIndex(roleId)) ||
          checkTransferRoleDirectory(this.deps.config, roleId);
        const mapping = input.mapping ?? {};
        const apply = () => applyRoleTransferPackageWithStore(
          this.deps.config, this.deps.appStore, incoming, input.token, mapping, input.choice,
        );
        const result = exists
          ? await this.deps.activity.guardRole(roleId, async () => {
              await this.deps.roleAccess.blockAndEvict(roleId);
              try {
                return apply();
              } finally {
                this.deps.roleAccess.unblock(roleId);
              }
            })
          : apply();
        if (result.outcome === "published") {
          this.deps.feedEvents.emit("role_activity", result.roleId);
        }
        return result;
      } catch (error) {
        return mapTransferError(error);
      }
    });
  }
}
