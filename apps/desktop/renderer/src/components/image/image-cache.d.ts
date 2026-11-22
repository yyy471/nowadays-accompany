export function imageServiceCacheKey(service: unknown): string;
export function readImageModelCache(key: string): string[] | null;
export function writeImageModelCache(key: string, models: readonly string[]): void;
export function subscribeImageModelCache(listener: () => void): () => void;
export function getImageModelCacheVersion(): number;
export function getImageModelCacheEpoch(key: string): number;
export function clearImageModelCache(key: string): void;
