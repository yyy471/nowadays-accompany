import { ModelCredentialUnavailableError } from "../domain/errors.js";
import { resolveCredential } from "../model/credentials.js";
import type { SecretStore } from "../storage/secret-store.js";

/** 读接口使用的凭据摘要，永不包含明文。 */
export interface CredentialSummary {
  status: "stored" | "reference" | "missing" | "unavailable";
  reference: string | null;
  resolvable: boolean;
}

export type CredentialState =
  | { kind: "stored"; value: string; updatedAt: string; fingerprint: string }
  | {
      kind: "reference";
      reference: string;
      value: string | undefined;
      resolvable: boolean;
    }
  | { kind: "missing" }
  | { kind: "unavailable"; updatedAt: string; fingerprint: string };

/**
 * 统一凭据解析：对话、记忆整理、过场图规划和连接测试都从这里取值。
 * 已保存的密钥优先于 env:/file: 引用；两者同时存在由资源服务在写入前拒绝。
 */
export class CredentialResolver {
  constructor(
    private readonly appRoot: string,
    private readonly secrets: SecretStore,
  ) {}

  inspect(resourceId: string, reference?: string): CredentialState {
    const stored = this.secrets.get(resourceId);
    if (stored.status === "unavailable") {
      return {
        kind: "unavailable",
        updatedAt: stored.updatedAt,
        fingerprint: stored.fingerprint,
      };
    }
    if (stored.status === "stored") {
      return {
        kind: "stored",
        value: stored.value,
        updatedAt: stored.updatedAt,
        fingerprint: stored.fingerprint,
      };
    }
    if (reference !== undefined) {
      try {
        const value = resolveCredential(this.appRoot, reference);
        return {
          kind: "reference",
          reference,
          value,
          resolvable: value !== undefined,
        };
      } catch {
        return {
          kind: "reference",
          reference,
          value: undefined,
          resolvable: false,
        };
      }
    }
    return { kind: "missing" };
  }

  /** 解析失败时抛 MODEL_CREDENTIAL_UNAVAILABLE，与既有引用语义一致。 */
  resolve(resourceId: string, reference?: string): string | undefined {
    const stored = this.secrets.get(resourceId);
    if (stored.status === "unavailable") {
      throw new ModelCredentialUnavailableError(`stored:${resourceId}`);
    }
    if (stored.status === "stored") {
      return stored.value;
    }
    return resolveCredential(this.appRoot, reference);
  }

  /** 只按外部引用解析凭据（不读 SecretStore），供草稿探测验证未保存引用。 */
  resolveReference(reference?: string): string | undefined {
    return resolveCredential(this.appRoot, reference);
  }

  summary(resourceId: string, reference?: string): CredentialSummary {
    const state = this.inspect(resourceId, reference);
    if (state.kind === "stored") {
      return { status: "stored", reference: null, resolvable: true };
    }
    if (state.kind === "reference") {
      return {
        status: "reference",
        reference: state.reference,
        resolvable: state.resolvable,
      };
    }
    if (state.kind === "unavailable") {
      return { status: "unavailable", reference: null, resolvable: false };
    }
    return { status: "missing", reference: null, resolvable: false };
  }

  /** 是否已有一条直填密钥记录（包括当前不可解密的情况）。 */
  hasStoredSecret(resourceId: string): boolean {
    return this.secrets.get(resourceId).status !== "missing";
  }

  /** 写入或替换直填密钥；调用方负责与资源配置同一事务。 */
  setSecret(resourceId: string, value: string, now: string): void {
    this.secrets.set(resourceId, value, now);
  }

  clearSecret(resourceId: string): void {
    this.secrets.clear(resourceId);
  }

  /**
   * 参与连接测试指纹的凭据版本：密钥替换或清除后，旧测试结果应标为过期。
   */
  fingerprintSalt(resourceId: string, reference?: string): string {
    const state = this.inspect(resourceId, reference);
    if (state.kind === "stored") {
      return `stored:${state.fingerprint}`;
    }
    if (state.kind === "unavailable") {
      return `unavailable:${state.fingerprint}`;
    }
    if (state.kind === "reference") {
      return `reference:${state.reference}`;
    }
    return "none";
  }
}
