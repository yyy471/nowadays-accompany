export function createTypingState(options: {
  update: (typing: boolean) => Promise<unknown>;
  clear: () => Promise<unknown>;
  delay?: number;
  setTimer?: typeof setTimeout;
  cancelTimer?: typeof clearTimeout;
}): { input(): void; stop(): void; close(): Promise<unknown> };
