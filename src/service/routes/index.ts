import { accountRoutes } from './accounts.js';
import { artifactRoutes } from './artifacts.js';
import { connectionRoutes } from './connections.js';
import { conversationRoutes } from './conversations.js';
import { instanceRoutes } from './instances.js';
import { jobRoutes } from './jobs.js';
import { mediaRoutes } from './media.js';
import { memoryRoutes } from './memory.js';
import { modelRoutes } from './models.js';
import { systemRoutes } from './system.js';
import { worldbookRoutes } from './worldbooks.js';
import type { Route } from './types.js';

/** 领域路由按用途分组；每个请求只由第一个匹配的路由处理。 */
export function createRoutes(): Route[] {
  return [
    systemRoutes(),
    instanceRoutes(),
    conversationRoutes(),
    accountRoutes(),
    modelRoutes(),
    mediaRoutes(),
    jobRoutes(),
    artifactRoutes(),
    worldbookRoutes(),
    memoryRoutes(),
    connectionRoutes()
  ];
}
