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

export function createOutfitDisplay(): OutfitDisplay {
  let generation = 0;
  let displayed: DisplayedOutfit | null = null;
  return {
    get current() {
      return displayed;
    },
    load(url, name, decode) {
      const request = ++generation;
      if (!url) {
        displayed = null;
        return Promise.resolve(null);
      }
      return Promise.resolve()
        .then(() => decode(url))
        .then(
          () => {
            if (request === generation) {
              displayed = { url, name: name || null };
            }
            return displayed;
          },
          () => displayed
        );
    },
    fail(url) {
      if (displayed !== null && (url === undefined || displayed.url === url)) {
        displayed = null;
      }
      return displayed;
    }
  };
}
