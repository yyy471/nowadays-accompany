import type { AgentHost, AgentHostFactory } from '../host/contract.js';
import type { SnowLumaRuntimeControllerOptions } from '../injection/snowluma/runtime.js';
import type { BackendFactory } from '../injection/contract.js';
import type { ChannelFactory } from '../channels/contract.js';
import type { InstanceSpec, NormalizedInstanceSpec } from '../instances/spec.js';
import type { ProviderAdapter } from '../providers/contract.js';
import type { CredentialVault } from '../secrets/vault.js';
import type { MessageStore } from '../storage/contract.js';
import type { Limits } from './limits.js';
import type { Logger, LogLevel } from './logger.js';

export interface CoreApiOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  token?: string;
  maxBodyBytes?: number;
  /** 桌面端构建产物目录；设置后由控制面同源托管 UI，静态资源不需要 token。 */
  uiDir?: string;
}

export interface CoreOptions {
  dataRoot: string;
  instances: InstanceSpec[];
  backendFactory?: BackendFactory;
  channelFactory?: ChannelFactory;
  /** dataDir 已解析为账号目录（<base>/accounts/<qq>），返回的 store 只服务该账号。 */
  storeFactory?: (spec: NormalizedInstanceSpec, dataDir: string) => MessageStore;
  api?: CoreApiOptions;
  logger?: Logger;
  logLevel?: LogLevel;
  maxRecordsPerConversation?: number;
  segmentRecords?: number;
  limits?: Partial<Limits>;
  /** 旧入口：同一个宿主对象服务所有账号；新部署优先用 hostFactory。 */
  host?: AgentHost;
  /** 按账号创建宿主；不提供时，有插件的账号使用内置 worker 宿主。 */
  hostFactory?: AgentHostFactory;
  profiles?: {
    /** 公用制品根，默认 <dataRoot>/public。 */
    publicRoot?: string;
  };
  /** 把槽位规格持久化到 <dataRoot>/slots.json；桌面端开启，CLI 默认关闭。 */
  persistSlots?: boolean;
  /** 覆盖槽位规格文件路径。 */
  slotsFile?: string;
  /** SnowLuma 手动注入设置；默认 <dataRoot>/injection.json。 */
  injectionSettingsFile?: string;
  /** 桌面端默认只恢复展示，不自动注入/监听。 */
  manualStartOnly?: boolean;
  /** 测试注入用的管理请求实现。 */
  snowLumaFetchImpl?: typeof fetch;
  /** 测试注入用的 QQ 公开头像请求实现。 */
  avatarFetchImpl?: typeof fetch;
  /** Start only the management service; QQ injection/listening still requires a click. */
  autoStartSnowLuma?: boolean;
  snowLumaRuntimeOptions?: Partial<Omit<SnowLumaRuntimeControllerOptions, 'manager' | 'logger'>>;
  injectionPollIntervalMs?: number;
  /** backend=fake 时自动接 FakeChannel，便于桌面端演示与本地联调。 */
  autoFakeChannel?: boolean;
  lockDataRoot?: boolean;
  /** 系统保护的凭据库；不提供时拒绝保存 Key，不静默写明文。 */
  credentialVault?: CredentialVault;
  /** 额外或覆盖内置适配器；同一 id 后注册者优先。 */
  providerAdapters?: ProviderAdapter[];
  /** schemaVersion=2 的模型/策略配置；默认 <dataRoot>/config.v2.json。 */
  modelConfigFile?: string;
  agent?: {
    maxHistoryMessages?: number;
    maxHistoryChars?: number;
    maxObservedMedia?: number;
  };
  now?: () => number;
  recordId?: () => string;
}
