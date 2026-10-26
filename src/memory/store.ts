import fs from 'node:fs/promises';
import path from 'node:path';
import { AccompanyError } from '../core/errors.js';
import { KeyedSerialExecutor } from '../platform/async/keyed-serial-executor.js';
import { serializeJson, writeFileAtomic } from '../storage/atomic-write.js';
import { defaultMemoryState, memoryNamespace, parseMemoryState } from './schema.js';
import { MEMORY_LIMITS, type MemoryScope, type MemoryState } from './types.js';

// One process-wide serial domain per state file; production also holds the data-root lock.
const writes = new KeyedSerialExecutor();

export interface MemoryStoreOptions {
  /** Read and write limits must stay identical. */
  maxStateFileBytes?: number;
}

export interface MemoryStoreRead {
  state: MemoryState;
  exists: boolean;
}

export interface MemoryStoreWrite<T> {
  state: MemoryState;
  result: T;
  /** Duplicate receipts can acknowledge without rewriting the file. */
  write?: boolean;
}

export interface MemoryStoreResult<T> {
  state: MemoryState;
  exists: boolean;
  result: T;
}

/** Per-scope memory state: bounded read, whole-file atomic compare-and-replace. */
export class MemoryStore {
  readonly #maxStateFileBytes: number;

  constructor(options: MemoryStoreOptions = {}) {
    this.#maxStateFileBytes = options.maxStateFileBytes ?? MEMORY_LIMITS.maxStateFileBytes;
  }

  get maxStateFileBytes(): number {
    return this.#maxStateFileBytes;
  }

  async read(accountDir: string, scope: MemoryScope): Promise<MemoryStoreRead> {
    const namespace = memoryNamespace(scope);
    const file = stateFile(accountDir, namespace);
    let text: string;
    try {
      text = await readBounded(file, this.#maxStateFileBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: defaultMemoryState(scope), exists: false };
      throw memoryIoError(error);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      throw memoryIoError(error);
    }
    let state: MemoryState;
    try {
      state = parseMemoryState(raw);
    } catch (error) {
      throw memoryIoError(error);
    }
    assertScope(scope, state);
    return { state, exists: true };
  }

  async transact<T>(
    accountDir: string,
    scope: MemoryScope,
    operation: (current: MemoryState, exists: boolean) => MemoryStoreWrite<T> | Promise<MemoryStoreWrite<T>>
  ): Promise<MemoryStoreResult<T>> {
    const namespace = memoryNamespace(scope);
    const file = stateFile(accountDir, namespace);
    return writes.run(file, async () => {
      const current = await this.read(accountDir, scope);
      const outcome = await operation(current.state, current.exists);
      if (memoryNamespace(outcome.state.scope) !== namespace) throw memoryIoError(new Error('memory scope changed during write'));
      let next: MemoryState;
      try {
        next = parseMemoryState(outcome.state);
      } catch (error) {
        throw memoryIoError(error);
      }
      if (outcome.write !== false) {
        const serialized = serializeJson(next);
        if (Buffer.byteLength(serialized, 'utf8') > this.#maxStateFileBytes) {
          throw new AccompanyError('memory_capacity', '这次修改会使记忆状态文件超过上限，请删除部分记忆或缩短内容后重试。');
        }
        try {
          await writeFileAtomic(file, serialized);
        } catch (error) {
          throw memoryIoError(error);
        }
      }
      return { state: next, exists: current.exists, result: outcome.result };
    });
  }
}

function stateFile(accountDir: string, namespace: string): string {
  return path.join(accountDir, 'memory', namespace, 'state.json');
}

function assertScope(expected: MemoryScope, state: MemoryState): void {
  if (state.scope.accountId !== expected.accountId || state.scope.kind !== expected.kind
    || state.scope.peerId !== expected.peerId || state.scope.contextEpoch !== expected.contextEpoch) {
    throw memoryIoError(new Error('memory state scope does not match its namespace'));
  }
}

async function readBounded(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (stat.size > maxBytes) throw new Error('memory state file exceeds the size limit');
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await handle.read(buffer, offset, stat.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function memoryIoError(error: unknown): AccompanyError {
  if (error instanceof AccompanyError && error.code === 'memory_io_error') return error;
  return new AccompanyError('memory_io_error', '长期记忆读取或写入失败，请检查文件权限，或从备份恢复后重试。', { cause: error });
}
