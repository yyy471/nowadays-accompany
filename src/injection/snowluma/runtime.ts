import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Logger } from '../../core/logger.js';
import { isLoopbackHost, readRuntimeInfo } from './config.js';
import type { SnowLumaManager, SnowLumaRuntimeStatus } from './manager.js';

const execFileAsync = promisify(execFile);

export type RuntimeStartupState = 'unconfigured' | 'starting' | 'managed' | 'external' | 'error';

export interface RuntimeStartupStatus {
  state: RuntimeStartupState;
  owner: 'managed' | 'external' | 'none';
  pid?: number;
  error?: string;
}

export interface SnowLumaRuntimeManager {
  settings(): { runtimeDir?: string; baseUrl?: string };
  status(): Promise<SnowLumaRuntimeStatus>;
  listProcesses(): Promise<unknown[]>;
}

export interface SnowLumaRuntimeControllerOptions {
  manager: SnowLumaRuntimeManager;
  logger: Logger;
  spawnImpl?: typeof spawn;
  nodeVersion?: (executable: string) => Promise<string>;
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  stopTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/**
 * Owns only a SnowLuma management process that nowadays launched itself.
 * It never starts QQ and never loads/injects a QQ process.
 */
export class SnowLumaRuntimeController {
  readonly #options: SnowLumaRuntimeControllerOptions;
  readonly #spawn: typeof spawn;
  #state: RuntimeStartupState = 'unconfigured';
  #error: string | undefined;
  #child: ChildProcess | undefined;
  #startPromise: Promise<void> | undefined;
  #startAbort: AbortController | undefined;

  constructor(options: SnowLumaRuntimeControllerOptions) {
    this.#options = options;
    this.#spawn = options.spawnImpl ?? spawn;
  }

  status(): RuntimeStartupStatus {
    return {
      state: this.#state,
      owner: this.#state === 'managed' || this.#state === 'starting'
        ? 'managed'
        : this.#state === 'external'
          ? 'external'
          : 'none',
      ...(this.#child?.pid ? { pid: this.#child.pid } : {}),
      ...(this.#error ? { error: this.#error } : {})
    };
  }

  ensureStarted(): Promise<void> {
    if (this.#startPromise) return this.#startPromise;
    const wrapped = this.#ensureStarted().finally(() => {
      if (this.#startPromise === wrapped) this.#startPromise = undefined;
    });
    this.#startPromise = wrapped;
    return wrapped;
  }

  async stop(): Promise<void> {
    this.#startAbort?.abort();
    const child = this.#child;
    if (child) await this.#terminateOwned(child);
    await this.#startPromise?.catch(() => {});
    this.#state = 'unconfigured';
    this.#error = undefined;
  }

  async #ensureStarted(): Promise<void> {
    this.#error = undefined;
    this.#startAbort = new AbortController();
    const signal = this.#startAbort.signal;
    try {
      const current = await this.#options.manager.status();
      if (!current.configured) {
        this.#state = 'unconfigured';
        this.#error = current.error;
        return;
      }
      const activeChild = this.#child;
      if (activeChild && activeChild.exitCode === null) {
        if (current.running) {
          await this.#verifyReady(current);
          this.#state = 'managed';
          return;
        }
        this.#state = 'starting';
        await this.#waitUntilReady(signal);
        return;
      }
      if (current.running) {
        this.#state = 'external';
        await this.#verifyReady(current);
        return;
      }

      const runtimeDir = this.#options.manager.settings().runtimeDir;
      if (!runtimeDir) {
        this.#state = 'error';
        this.#error = '已配置管理地址，但未设置 SnowLuma runtime 目录，无法安全启动受管服务。';
        return;
      }
      const validated = await validateRuntime(
        runtimeDir,
        this.#options.platform ?? process.platform,
        this.#options.nodeVersion ?? probeNodeVersion
      );
      const configuredUrl = this.#options.manager.settings().baseUrl;
      if (configuredUrl && configuredUrl !== validated.managementUrl) {
        throw new Error(`管理地址 ${configuredUrl} 与 runtime.json 中的 WebUI 地址 ${validated.managementUrl} 不一致；已停止自动启动。`);
      }
      if (signal.aborted) return;

      this.#state = 'starting';
      const env = { ...(this.#options.env ?? process.env), SNOWLUMA_HOOK_AUTOLOAD_ALL: '0' };
      const spawnedChild = this.#spawn(validated.nodeExecutable, ['index.mjs'], {
        cwd: validated.runtimeDir,
        env,
        stdio: 'ignore',
        windowsHide: true,
        shell: false,
        detached: false
      });
      this.#child = spawnedChild;
      spawnedChild.once('error', (error) => {
        if (this.#child !== spawnedChild) return;
        this.#state = 'error';
        this.#error = `SnowLuma 启动失败：${error.message}`;
        this.#child = undefined;
        this.#options.logger.error('managed SnowLuma spawn failed', { message: error.message });
      });
      spawnedChild.once('exit', (code, terminationSignal) => {
        if (this.#child !== spawnedChild) return;
        this.#child = undefined;
        this.#state = 'error';
        this.#error = `受管 SnowLuma 已退出（${code === null ? `signal ${terminationSignal ?? 'unknown'}` : `code ${code}`}）。`;
        this.#options.logger.warn('managed SnowLuma exited', { pid: spawnedChild.pid, code, signal: terminationSignal });
      });
      spawnedChild.unref();
      this.#options.logger.info('starting managed SnowLuma runtime', {
        runtimeDir: validated.runtimeDir,
        pid: spawnedChild.pid
      });

      await this.#waitUntilReady(signal);
    } catch (error) {
      if (signal.aborted) return;
      const child = this.#child;
      if (child) await this.#terminateOwned(child);
      this.#state = 'error';
      this.#error = error instanceof Error ? error.message : String(error);
      this.#options.logger.warn('SnowLuma runtime startup not ready', { message: this.#error });
    } finally {
      if (this.#startAbort?.signal === signal) this.#startAbort = undefined;
    }
  }

  async #waitUntilReady(signal: AbortSignal): Promise<void> {
    const timeout = this.#options.startupTimeoutMs ?? 25_000;
    const deadline = Date.now() + timeout;
    while (!signal.aborted && Date.now() < deadline) {
      if (!this.#child) throw new Error(this.#error ?? 'SnowLuma 进程在管理端口就绪前退出。');
      const status = await this.#options.manager.status().catch(() => undefined);
      if (status?.running) {
        await this.#verifyReady(status);
        if (!this.#child) throw new Error(this.#error ?? 'SnowLuma 管理服务启动后立即退出。');
        this.#state = 'managed';
        return;
      }
      await (this.#options.delay ?? abortableDelay)(this.#options.pollIntervalMs ?? 250, signal);
    }
    if (!signal.aborted) throw new Error(`SnowLuma WebUI 管理端口未在 ${Math.ceil(timeout / 1_000)} 秒内就绪；请检查 runtime 目录、Node 版本和端口占用。`);
  }

  async #terminateOwned(child: ChildProcess): Promise<void> {
    if (this.#child === child) this.#child = undefined;
    if (child.exitCode !== null && child.exitCode !== undefined) return;
    try {
      child.kill('SIGTERM');
    } catch (error) {
      this.#options.logger.warn('failed to stop managed SnowLuma process', {
        pid: child.pid,
        message: error instanceof Error ? error.message : String(error)
      });
      return;
    }
    await Promise.race([
      waitForExit(child),
      new Promise<void>((resolve) => setTimeout(resolve, this.#options.stopTimeoutMs ?? 2_000))
    ]);
    if (child.exitCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may exit between the timeout and this signal.
      }
      await Promise.race([waitForExit(child), new Promise<void>((resolve) => setTimeout(resolve, 500))]);
    }
  }

  async #verifyReady(status: SnowLumaRuntimeStatus): Promise<void> {
    if (!status.compatible) throw new Error(status.error ?? `SnowLuma 版本不兼容；需要 ${status.supportedVersion}。`);
    if (!status.autoLoadKnown) throw new Error('runtime.json 未提供 hookAutoLoad 状态，无法确认受管模式不会自动注入。');
    if (status.autoLoadEnabled) throw new Error('SnowLuma hookAutoLoad 已开启；为避免自动注入，nowadays 不会继续操作。');
    if (!status.running) return;
    try {
      await this.#options.manager.listProcesses();
    } catch (error) {
      // A service may be alive while login credentials or explicit consent are still missing.
      this.#error = error instanceof Error ? error.message : String(error);
      this.#options.logger.info('SnowLuma is listening but process discovery is not ready', { message: this.#error });
    }
  }
}

interface ValidatedRuntime {
  runtimeDir: string;
  nodeExecutable: string;
  managementUrl: string;
}

async function validateRuntime(
  runtimeDir: string,
  platform: NodeJS.Platform,
  nodeVersion: (executable: string) => Promise<string>
): Promise<ValidatedRuntime> {
  const resolvedDir = path.resolve(runtimeDir);
  const packagePath = path.join(resolvedDir, 'package.json');
  const entryPath = path.join(resolvedDir, 'index.mjs');
  const nodeExecutable = path.join(resolvedDir, platform === 'win32' ? 'node.exe' : 'node');
  const nodeStats = await fs.stat(nodeExecutable).catch(() => undefined);
  if (!nodeStats?.isFile()) throw new Error(`runtime 目录缺少内置 Node：${nodeExecutable}`);
  const entryStats = await fs.stat(entryPath).catch(() => undefined);
  if (!entryStats?.isFile()) throw new Error(`runtime 目录缺少 SnowLuma 入口：${entryPath}`);

  const manifest = JSON.parse(await fs.readFile(packagePath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string' || !/^1\.14\.\d+(?:[-+].*)?$/.test(manifest.version)) {
    throw new Error(`SnowLuma ${String(manifest.version ?? '版本未知')} 不受支持；当前只支持 1.14.x。`);
  }
  const runtimeInfo = await readRuntimeInfo(resolvedDir);
  if (!runtimeInfo) throw new Error('runtime/config/runtime.json 缺失或管理端口无效；请先在 SnowLuma WebUI 完成初始化。');
  if (!runtimeInfo.autoLoadKnown) throw new Error('runtime.json 的 hookAutoLoad 状态未知，请先明确设置为 false。');
  if (!isLoopbackHost(runtimeInfo.webuiHost)) throw new Error(`SnowLuma WebUI 监听地址 ${runtimeInfo.webuiHost} 不是回环地址，已阻止自动启动。`);
  if (runtimeInfo.hookAutoLoad) throw new Error('SnowLuma hookAutoLoad 已开启，必须先在 SnowLuma 中关闭自动注入。');

  let version: string;
  try {
    version = await nodeVersion(nodeExecutable);
  } catch (error) {
    throw new Error(`无法读取 SnowLuma Node 版本：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isSupportedNodeVersion(version)) throw new Error(`SnowLuma 要求 Node.js ^22.13.0 或 >=23.4.0；runtime 内 Node 为 ${version}。`);

  const protocol = runtimeInfo.tlsEnabled ? 'https' : 'http';
  const host = runtimeInfo.webuiHost.includes(':') ? `[${runtimeInfo.webuiHost}]` : runtimeInfo.webuiHost;
  return { runtimeDir: resolvedDir, nodeExecutable, managementUrl: `${protocol}://${host}:${runtimeInfo.webuiPort}` };
}

async function probeNodeVersion(executable: string): Promise<string> {
  const result = await execFileAsync(executable, ['--version'], { timeout: 5_000, windowsHide: true });
  return result.stdout.trim();
}

function isSupportedNodeVersion(raw: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(raw.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once('exit', () => resolve()));
}
