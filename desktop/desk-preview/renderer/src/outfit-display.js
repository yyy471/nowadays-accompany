export function createOutfitDisplay() {
  let generation = 0;
  let displayed = null;
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
