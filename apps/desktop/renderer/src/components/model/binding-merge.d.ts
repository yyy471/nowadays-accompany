export interface BindingLike {
  capability: string;
  resourceId: string;
  modelName?: string | null;
  enabled?: boolean;
}

export function mergeBindingDrafts(input: {
  base: BindingLike[];
  draft: BindingLike[];
  latest: BindingLike[];
  scope: "models" | "ext";
}): { items: BindingLike[]; conflicts: string[] };
