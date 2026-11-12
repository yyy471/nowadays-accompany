export function providerCacheKey(resource: unknown): string;
export function readModelCache(key: string): string[] | null;
export function writeModelCache(key: string, models: readonly string[]): void;
export function subscribeModelCache(listener: () => void): () => void;
export function getModelCacheVersion(): number;
export function getModelCacheEpoch(key: string): number;
export function clearModelCache(key: string): void;
