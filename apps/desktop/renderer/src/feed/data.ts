import { api } from '../api';
import type { Outfit, RoleListItem, RoleStateResponse } from '../types';
import { appearanceAssetUrl } from '../types';

export interface Wake {
  wakeId: string;
  roleId: string;
  kind: 'scheduled' | 'budget_resume';
  scheduledAt: string;
  intent: string;
  status: 'pending' | 'claimed' | 'completed' | 'cancelled';
  taskId: string | null;
  lastErrorCode: string | null;
  createdAt: string;
}
export interface Activity {
  activityId: string;
  roleId: string;
  wakeId: string;
  taskId: string;
  windowId: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  summary: string | null;
  sharedMessageId: string | null;
  startedAt: string;
  finishedAt: string | null;
  sharedMessage: SharedMessage | null;
}
export interface SharedMessage { messageId: string; windowId: string; content: string; createdAt: string }
export interface Task {
  taskId: string;
  roleId: string;
  goal: string;
  waitReason: string | null;
  endReason: string | null;
}
export interface MemoryBatch {
  batchId: string;
  roleId: string;
  status: 'running' | 'completed' | 'failed' | 'partial';
  inputFromSequence: number;
  inputToSequence: number;
  attemptCount: number;
  lastErrorCode: string | null;
  startedAt: string;
  finishedAt: string | null;
}
export interface RoleActivity {
  roleId: string;
  state: 'active' | 'stopping' | 'stopped';
  requestedAt: string | null;
  confirmedAt: string | null;
}
export interface FeedData {
  wakes: Wake[];
  activities: Activity[];
  tasks: Task[];
  batches: MemoryBatch[];
  roleActivities: RoleActivity[];
  messages: Record<string, SharedMessage>;
  portraits: Record<string, string>;
}
export interface UpcomingData { wakes: Wake[]; roleActivities: RoleActivity[] }

async function allPages<T>(path: string, limit: number, signal: AbortSignal, idOf: (item: T) => string): Promise<T[]> {
  const items: T[] = [];
  for (;;) {
    const page = await api<{ items: T[] }>(`${path}${path.includes('?') ? '&' : '?'}limit=${limit}&offset=${items.length}`, { signal });
    items.push(...page.items);
    if (page.items.length < limit) return [...new Map(items.map(item => [idOf(item), item])).values()];
  }
}

const rolePath = (id: string) => `/v1/roles/${encodeURIComponent(id)}`;
const readyRoles = (roles: RoleListItem[]) => roles.filter(role => role.status === 'ready');
export const messageKey = (roleId: string, messageId: string) => JSON.stringify([roleId, messageId]);


async function portrait(role: RoleListItem, signal: AbortSignal): Promise<string> {
  const path = rolePath(role.roleId);
  const [wardrobe, state] = await Promise.all([
    api<{ items: Outfit[] }>(`${path}/appearance/outfits`, { signal }),
    api<RoleStateResponse>(`${path}/state`, { signal }),
  ]);
  const available = wardrobe.items.filter(item => item.home);
  const chosen = available.find(item => item.outfitId === state.state.outfitId) ?? available[0];
  return chosen?.home ? appearanceAssetUrl(role.roleId, chosen.home.assetId) : '';
}

export async function loadUpcoming(roles: RoleListItem[], signal: AbortSignal): Promise<UpcomingData> {
  const [roleActivities, wakes] = await Promise.all([
    api<{ items: RoleActivity[] }>('/v1/activities', { signal }),
    Promise.all(readyRoles(roles).map(role => allPages<Wake>(`${rolePath(role.roleId)}/autonomy/wakes`, 500, signal, item => item.wakeId))),
  ]);
  return { roleActivities: roleActivities.items, wakes: wakes.flat() };
}

export async function loadFeed(roles: RoleListItem[], signal: AbortSignal): Promise<FeedData> {
  const [roleActivities, snapshots] = await Promise.all([
    api<{ items: RoleActivity[] }>('/v1/activities', { signal }),
    Promise.all(readyRoles(roles).map(async role => {
      const path = rolePath(role.roleId);
      const [wakes, activities, tasks, batches, image] = await Promise.all([
        allPages<Wake>(`${path}/autonomy/wakes`, 500, signal, item => item.wakeId),
        allPages<Activity>(`${path}/autonomy/activities?includeSharedMessage=1`, 500, signal, item => item.activityId),
        api<{ items: Task[] }>(`${path}/tasks`, { signal }),
        allPages<MemoryBatch>(`${path}/memory/batches`, 200, signal, item => item.batchId),
        portrait(role, signal).catch(error => {
          if (signal.aborted) throw error;
          return '';
        }),
      ]);
      const messages = activities.flatMap(activity => activity.sharedMessage ? [activity.sharedMessage] : []);
      return { role, wakes, activities, tasks: tasks.items, batches, image, messages };
    })),
  ]);
  return {
    wakes: snapshots.flatMap(item => item.wakes),
    activities: snapshots.flatMap(item => item.activities),
    tasks: snapshots.flatMap(item => item.tasks),
    batches: snapshots.flatMap(item => item.batches),
    roleActivities: roleActivities.items,
    messages: Object.fromEntries(snapshots.flatMap(item => item.messages.map(message => [messageKey(item.role.roleId, message.messageId), message]))),
    portraits: Object.fromEntries(snapshots.map(item => [item.role.roleId, item.image])),
  };
}
