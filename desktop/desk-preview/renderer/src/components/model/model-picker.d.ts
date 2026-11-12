export function filterModelNames(
  models: readonly string[] | undefined,
  query: string,
): string[];
export function modelTestNote(
  result:
    | { ok?: boolean; elapsedMs?: number; error?: { message?: string } }
    | null
    | undefined,
): string;
