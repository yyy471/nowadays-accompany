import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectionReadiness } from '../desktop/renderer/src/lib/connection-readiness.js';
import { cancelModeLabel, capabilityLabel, deploymentActionLabel, visionModeLabel } from '../desktop/renderer/src/lib/labels.js';
import type { SnowLumaRuntimeStatus } from '../desktop/renderer/src/types.js';

const READY: SnowLumaRuntimeStatus = {
  configured: true,
  supportedVersion: '1.14.22',
  compatible: true,
  running: true,
  authenticated: true,
  passwordConfigured: true,
  consentRequired: false,
  autoLoadEnabled: false,
  autoLoadKnown: true,
  owner: 'external'
};

async function sources(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sources(file));
    else if (/\.tsx?$/.test(entry.name)) files.push(file);
  }
  return files;
}

describe('connection readiness', () => {
  it('allows connecting only when every condition is known and satisfied', () => {
    expect(connectionReadiness(READY)).toEqual({ ready: true, blockers: [] });
  });

  it('explains every unmet condition instead of only disabling the button', () => {
    const readiness = connectionReadiness({
      ...READY,
      configured: false,
      running: false,
      compatible: false,
      version: '2.0.0',
      passwordConfigured: false,
      autoLoadKnown: false,
      autoLoadEnabled: true,
      consentRequired: true
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual([
      'not_configured',
      'not_running',
      'version_incompatible',
      'password_missing',
      'autoload_unknown',
      'consent_required'
    ]);
    expect(readiness.blockers.every((blocker) => blocker.title && blocker.detail)).toBe(true);
  });

  it('reports an enabled auto-load only when that state is known', () => {
    expect(connectionReadiness({ ...READY, autoLoadEnabled: true }).blockers.map((blocker) => blocker.code))
      .toEqual(['autoload_enabled']);
    expect(connectionReadiness({ ...READY, autoLoadKnown: false, autoLoadEnabled: true }).blockers.map((blocker) => blocker.code))
      .toEqual(['autoload_unknown']);
  });

  it('treats an unread status as a blocking condition rather than ready', () => {
    expect(connectionReadiness(undefined)).toMatchObject({
      ready: false,
      blockers: [{ code: 'status_unknown' }]
    });
  });
});

describe('shared frontend labels', () => {
  it('maps raw backend enums to the copy shown in pages', () => {
    expect(capabilityLabel('image.understand')).toBe('图片理解');
    expect(visionModeLabel('direct')).toBe('直接视觉');
    expect(cancelModeLabel('remote')).toBe('远端取消');
    expect(deploymentActionLabel('rollback')).toBe('回滚');
  });

  it('falls back to the raw value for unknown enums', () => {
    expect(deploymentActionLabel('future-action')).toBe('future-action');
  });
});

describe('frontend copy contract', () => {
  it('keeps removed developer-facing wording out of rendered pages', async () => {
    const root = path.join(process.cwd(), 'desktop', 'renderer', 'src');
    const files = await sources(root);
    const forbidden = [
      '模型服務',
      '去槽位页',
      '会话绑定数',
      'Skill 由账号插件提供',
      'profile.json',
      'last-known-good',
      '停止 / 释放',
      '刷新账号',
      '可连接的 QQ',
      'QQ 登录后会出现在这里'
    ];
    const violations: string[] = [];
    for (const file of files) {
      const relative = path.relative(root, file).replaceAll('\\', '/');
      const text = await fs.readFile(file, 'utf8');
      for (const phrase of forbidden) {
        if (text.includes(phrase)) violations.push(`${relative} contains "${phrase}"`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('names the extension page for every resource it manages', async () => {
    const root = path.join(process.cwd(), 'desktop', 'renderer', 'src');
    const app = await fs.readFile(path.join(root, 'App.tsx'), 'utf8');
    const navigation = await fs.readFile(path.join(root, 'lib', 'navigation.ts'), 'utf8');
    expect(app).toContain("import { PAGES } from './lib/navigation'");
    expect(navigation).toContain("title: '插件与Skill'");
    expect(navigation).toContain("label: '插件与Skill'");
    expect(app).not.toContain("view={page === 'roles' ? 'roles' : 'plugins'}");
    const policy = await fs.readFile(path.join(root, 'pages', 'Policy.tsx'), 'utf8');
    expect(policy).not.toContain('允许 AI 调用的工具');
    const accounts = await fs.readFile(path.join(root, 'pages', 'Accounts.tsx'), 'utf8');
    expect(accounts).not.toContain('账号插件资料');
  });
});
