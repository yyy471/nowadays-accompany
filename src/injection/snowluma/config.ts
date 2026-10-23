import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { isLoopbackHost } from '../../core/net.js';

export { isLoopbackHost };

export interface SnowLumaEndpoint {
  host: string;
  port: number;
  hasToken: boolean;
  accessToken?: string;
  name?: string;
}

export interface SnowLumaRuntimeInfo {
  webuiHost: string;
  webuiPort: number;
  tlsEnabled: boolean;
  hookAutoLoad: boolean;
  autoLoadKnown: boolean;
}

export interface SnowLumaProfile {
  accountId: string;
  configPath: string;
  http: SnowLumaEndpoint;
  ws: SnowLumaEndpoint;
}

interface RawServer {
  name?: unknown;
  host?: unknown;
  port?: unknown;
  accessToken?: unknown;
}

const PROFILE_FILE = /^onebot_(\d+)\.json$/;
const DEFAULT_HOST = '127.0.0.1';

function readServers(networks: unknown, key: 'httpServers' | 'wsServers'): RawServer[] {
  if (!networks || typeof networks !== 'object') return [];
  const list = (networks as Record<string, unknown>)[key];
  return Array.isArray(list) ? (list as RawServer[]) : [];
}

function pickServer(servers: RawServer[], preferredPort: number, preferredName: string): SnowLumaEndpoint | null {
  if (servers.length === 0) return null;
  const chosen =
    servers.find((s) => Number(s.port) === preferredPort) ??
    servers.find((s) => s.name === preferredName) ??
    servers[0];
  if (!chosen) return null;
  const port = Number(chosen.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const host = typeof chosen.host === 'string' && chosen.host ? chosen.host : DEFAULT_HOST;
  return {
    host,
    port,
    hasToken: typeof chosen.accessToken === 'string' && chosen.accessToken.length > 0,
    ...(typeof chosen.accessToken === 'string' && chosen.accessToken
      ? { accessToken: chosen.accessToken }
      : {}),
    name: typeof chosen.name === 'string' ? chosen.name : undefined
  };
}

export async function readRuntimeInfo(runtimeDir: string): Promise<SnowLumaRuntimeInfo | null> {
  const file = path.join(runtimeDir, 'config', 'runtime.json');
  try {
    const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
      webuiPort?: unknown;
      webuiHost?: unknown;
      hookAutoLoad?: unknown;
      webuiTls?: { enabled?: unknown };
    };
    const port = Number(raw.webuiPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      webuiHost: typeof raw.webuiHost === 'string' && raw.webuiHost ? raw.webuiHost : DEFAULT_HOST,
      webuiPort: port,
      tlsEnabled: raw.webuiTls?.enabled === true,
      hookAutoLoad: raw.hookAutoLoad === true,
      autoLoadKnown: typeof raw.hookAutoLoad === 'boolean'
    };
  } catch {
    return null;
  }
}

export async function readRuntimeVersion(runtimeDir: string): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(runtimeDir, 'package.json'), 'utf8')) as { version?: unknown };
    return typeof raw.version === 'string' ? raw.version : undefined;
  } catch {
    return undefined;
  }
}

export async function listProfiles(runtimeDir: string): Promise<SnowLumaProfile[]> {
  const configDir = path.join(runtimeDir, 'config');
  let files: string[];
  try {
    files = await fs.readdir(configDir);
  } catch {
    return [];
  }
  const profiles: SnowLumaProfile[] = [];
  for (const file of files.sort()) {
    const match = PROFILE_FILE.exec(file);
    if (!match || match[1] === '0') continue;
    const configPath = path.join(configDir, file);
    try {
      const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as { networks?: unknown };
      const http = pickServer(readServers(raw.networks, 'httpServers'), 3000, 'http-default');
      const ws = pickServer(readServers(raw.networks, 'wsServers'), 3001, 'ws-default');
      if (!http || !ws) continue;
      profiles.push({ accountId: match[1] as string, configPath, http, ws });
    } catch {
      continue;
    }
  }
  return profiles;
}

export async function readProfileTokens(profile: SnowLumaProfile): Promise<{ httpToken: string; wsToken: string }> {
  // 必须使用 listProfiles/pickServer 实际选中的那个 server 的令牌，不能再按数组下标重新猜。
  const wsToken = profile.ws.accessToken ?? '';
  return {
    wsToken,
    httpToken: profile.http.accessToken || wsToken
  };
}

export function formatHostPort(host: string, port: number): string {
  return host.includes(':') ? `[${host}]:${port}` : `${host}:${port}`;
}

export async function probeTcp(
  host: string,
  port: number,
  timeoutMs = 800,
  signal?: AbortSignal
): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      resolve(ok);
    };
    const onAbort = (): void => finish(false);
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
