import type { InstanceStatus } from '../../instances/spec.js';

export interface AccountInstanceSnapshot {
  instanceId: string;
  /** 当前已验证/绑定的账号。 */
  accountId?: string;
  /** 槽位规格中声明的账号。 */
  specAccountId?: string;
  dataDir?: string;
  state: InstanceStatus['state'];
}

/** 账号用例所需的窄运行端口；避免应用服务持有整个 Core。 */
export interface AccountRuntimePort {
  snapshots(): AccountInstanceSnapshot[];
  reload(instanceId: string): Promise<void>;
}
