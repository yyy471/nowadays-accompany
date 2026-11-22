export interface CancelableTask {
  taskId: string;
  status: string;
  goal: string;
  origin?: string;
  continuable?: boolean;
  waitReason?: string | null;
  updatedAt?: string;
}

export function pickCancelableTask(tasks: CancelableTask[] | undefined): CancelableTask | null;
export function taskCancelLabel(task: CancelableTask | null): string;
export function taskCancelTitle(task: CancelableTask | null): string;
export function taskCancelNotice(task: CancelableTask | null): string;
