import fs from 'node:fs/promises';
import path from 'node:path';
import { InvalidSpecError } from '../core/errors.js';
import { writeJsonAtomic } from '../storage/atomic-write.js';

export interface AccountDisplayProfile {
  nickname: string;
  signature: string;
  avatarDataUrl?: string;
}

const MAX_AVATAR_BYTES = 512 * 1024;

export async function loadAccountDisplay(accountDir: string): Promise<AccountDisplayProfile> {
  const filename = path.join(accountDir, 'display.json');
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(filename, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { nickname: '', signature: '' };
    throw new InvalidSpecError(`account display profile is unreadable: ${filename}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidSpecError(`account display profile must be an object: ${filename}`);
  }
  const value = raw as Partial<AccountDisplayProfile>;
  if (typeof value.nickname !== 'string' || typeof value.signature !== 'string') {
    throw new InvalidSpecError(`account display profile fields are invalid: ${filename}`);
  }
  return {
    nickname: value.nickname,
    signature: value.signature,
    ...(value.avatarDataUrl ? { avatarDataUrl: parseAvatar(value.avatarDataUrl, filename) } : {})
  };
}

export async function saveAccountDisplay(
  accountDir: string,
  raw: unknown
): Promise<AccountDisplayProfile> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new InvalidSpecError('display profile must be an object');
  const input = raw as Record<string, unknown>;
  const current = await loadAccountDisplay(accountDir);
  const next: AccountDisplayProfile = { ...current };
  if ('nickname' in input) {
    if (typeof input.nickname !== 'string' || input.nickname.length > 64) throw new InvalidSpecError('nickname must be at most 64 characters');
    next.nickname = input.nickname.trim();
  }
  if ('signature' in input) {
    if (typeof input.signature !== 'string' || input.signature.length > 160) throw new InvalidSpecError('signature must be at most 160 characters');
    next.signature = input.signature.trim();
  }
  if ('avatarDataUrl' in input) {
    if (input.avatarDataUrl === null || input.avatarDataUrl === '') delete next.avatarDataUrl;
    else if (typeof input.avatarDataUrl === 'string') next.avatarDataUrl = parseAvatar(input.avatarDataUrl, 'avatarDataUrl');
    else throw new InvalidSpecError('avatarDataUrl must be an image data URL or null');
  }
  await writeJsonAtomic(path.join(accountDir, 'display.json'), next);
  return next;
}

function parseAvatar(value: string, source: string): string {
  const match = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new InvalidSpecError(`${source} must be a JPEG, PNG, or WebP data URL`);
  const bytes = Buffer.from(match[2]!, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES) {
    throw new InvalidSpecError(`${source} must be between 1 byte and ${MAX_AVATAR_BYTES} bytes`);
  }
  return value;
}
