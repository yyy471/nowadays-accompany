#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCore, type CoreOptions } from '../core/core.js';
import { createLogger } from '../core/logger.js';
import { SnowLumaBackend } from '../injection/snowluma/backend.js';
import type { InstanceSpec } from '../instances/spec.js';

interface ParsedArgs {
  command: string;
  flags: Record<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command = 'help', ...rest] = argv;
  const flags: Record<string, string> = {};
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token?.startsWith('--')) continue;
    const key = token.slice(2);
    const next = rest[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { command, flags };
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandProbe(flags: Record<string, string>): Promise<number> {
  const runtimeDir = flags['runtime-dir'];
  if (!runtimeDir) {
    process.stderr.write('probe requires --runtime-dir <snowluma dir>\n');
    return 2;
  }
  const logger = createLogger({ scope: 'probe', level: 'warn' });
  const backend = new SnowLumaBackend({
    runtimeDir: path.resolve(runtimeDir),
    ...(flags.account ? { accountId: flags.account } : {}),
    ...(flags.timeout ? { probeTimeoutMs: Number(flags.timeout) } : {}),
    logger
  });
  const report = await backend.probe();
  print(report);
  return 0;
}

async function commandStart(flags: Record<string, string>): Promise<number> {
  const configPath = flags.config;
  if (!configPath) {
    process.stderr.write('start requires --config <file>\n');
    return 2;
  }
  const absoluteConfig = path.resolve(configPath);
  const baseDir = path.dirname(absoluteConfig);
  const raw = JSON.parse(await fs.readFile(absoluteConfig, 'utf8')) as {
    dataRoot?: string;
    logLevel?: CoreOptions['logLevel'];
    api?: CoreOptions['api'];
    maxRecordsPerConversation?: number;
    segmentRecords?: number;
    limits?: CoreOptions['limits'];
    profiles?: CoreOptions['profiles'];
    lockDataRoot?: boolean;
    instances?: InstanceSpec[];
  };
  if (!raw.dataRoot) {
    process.stderr.write('config requires dataRoot\n');
    return 2;
  }
  const instances = (raw.instances ?? []).map((spec) => ({
    ...spec,
    ...(spec.runtimeDir ? { runtimeDir: path.resolve(baseDir, spec.runtimeDir) } : {}),
    ...(spec.dataDir ? { dataDir: path.resolve(baseDir, spec.dataDir) } : {})
  }));
  const core = await createCore({
    dataRoot: path.resolve(baseDir, raw.dataRoot),
    instances,
    ...(raw.logLevel ? { logLevel: raw.logLevel } : {}),
    ...(raw.maxRecordsPerConversation !== undefined
      ? { maxRecordsPerConversation: raw.maxRecordsPerConversation }
      : {}),
    ...(raw.segmentRecords !== undefined ? { segmentRecords: raw.segmentRecords } : {}),
    ...(raw.limits !== undefined ? { limits: raw.limits } : {}),
    ...(raw.profiles !== undefined ? { profiles: raw.profiles } : {}),
    ...(raw.lockDataRoot !== undefined ? { lockDataRoot: raw.lockDataRoot } : {}),
    api: { enabled: true, ...raw.api }
  });
  await core.start();
  print({ ok: true, ...core.status() });

  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  await core.stop();
  return 0;
}

const HELP = `nowadays — QQ injection orchestration core

usage:
  nowadays probe --runtime-dir <snowluma dir> [--account <uin>] [--timeout 800]
  nowadays start --config <config.json>

config.json:
  { dataRoot, logLevel?, maxRecordsPerConversation?, segmentRecords?,
    limits?: { maxInstances, maxIngressQueue, maxMessageBytes, sendRatePerSecond, ... },
    profiles?: { publicRoot? },
    api?: { port, token? },
    instances: [{ id, backend: "snowluma" | "fake", runtimeDir?, runtimeId?, accountId? }] }
`;

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'probe':
      return commandProbe(flags);
    case 'start':
      return commandStart(flags);
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
