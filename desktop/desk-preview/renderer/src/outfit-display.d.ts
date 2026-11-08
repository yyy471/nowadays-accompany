export interface DisplayedOutfit {
  url: string;
  name: string | null;
}

export interface OutfitDisplay {
  readonly current: DisplayedOutfit | null;
  load(
    url: string | null | undefined,
    name: string | null | undefined,
    decode: (url: string) => Promise<void>
  ): Promise<DisplayedOutfit | null>;
  fail(url?: string): DisplayedOutfit | null;
}

export function createOutfitDisplay(): OutfitDisplay;
