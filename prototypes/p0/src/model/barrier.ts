export class Barrier {
  private readonly waiters = new Map<string, Array<() => void>>();

  wait(key: string): Promise<void> {
    return new Promise((resolve) => {
      const list = this.waiters.get(key) ?? [];
      list.push(resolve);
      this.waiters.set(key, list);
    });
  }

  release(key: string): void {
    const list = this.waiters.get(key);
    if (!list) {
      return;
    }
    this.waiters.delete(key);
    for (const resolve of list) {
      resolve();
    }
  }

  get waitingKeys(): string[] {
    return [...this.waiters.keys()];
  }
}
