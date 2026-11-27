import type { Wake } from './data';

export function isFirstActivation(wake: Pick<Wake, 'wakeId'>) {
  return wake.wakeId.startsWith('first-activation:');
}

export function wakeText(wake: Pick<Wake, 'wakeId' | 'intent'>) {
  return isFirstActivation(wake) ? '从这时起开始记录活动。' : wake.intent;
}
