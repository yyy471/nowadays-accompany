import * as React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Button, Disclosure, DropdownMenu, MotionPolicyProvider, UiThemeProvider, UiThemeScope, useMotionPolicy } from '../desktop/renderer/src/ui';
import { applyScopedMotionPolicy, createMotionScope, readCssTime, resolveMotionPolicy } from '../desktop/renderer/src/ui/motion';
import { createModalLayerManager } from '../desktop/renderer/src/ui/modal-layers';
import { PageDock } from '../desktop/renderer/src/components/shell/PageDock';
import { WorkbenchRoot } from '../desktop/renderer/src/workbench/Workbench';
import { HomePage } from '../desktop/renderer/src/pages/Home';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

function PolicyProbe() {
  return <span>{useMotionPolicy().reduced ? 'reduced' : 'full'}</span>;
}

describe('motion policy', () => {
  it('lets system follow the OS, reduced win and full override the OS', () => {
    expect(resolveMotionPolicy('system', true).reduced).toBe(true);
    expect(resolveMotionPolicy('system', false).reduced).toBe(false);
    expect(resolveMotionPolicy('reduced', false).reduced).toBe(true);
    expect(resolveMotionPolicy('full', true).reduced).toBe(false);
    expect(resolveMotionPolicy('full', true, true)).toMatchObject({ reduced: false, forcedColors: true });
  });

  it('reads CSS durations in both ms and compressed s units', () => {
    expect(readCssTime('160ms')).toBe(160);
    expect(readCssTime('.16s')).toBe(160);
    expect(readCssTime('0s')).toBe(0);
    expect(readCssTime('2.5s')).toBe(2500);
    expect(readCssTime('bogus', 42)).toBe(42);
    expect(readCssTime('', 24)).toBe(24);
  });

  it('treats a scoped reduced as a floor without letting local full unlock', () => {
    const full = resolveMotionPolicy('full', true);
    expect(applyScopedMotionPolicy(full, 'reduced').reduced).toBe(true);
    expect(applyScopedMotionPolicy(full, 'full').reduced).toBe(false);
    const explicitReduced = resolveMotionPolicy('reduced', false, true);
    expect(applyScopedMotionPolicy(explicitReduced, 'full')).toMatchObject({ reduced: true, forcedColors: true });
    const systemReduced = resolveMotionPolicy('system', true);
    expect(applyScopedMotionPolicy(systemReduced, 'full').reduced).toBe(true);
    const system = resolveMotionPolicy('system', false);
    expect(applyScopedMotionPolicy(system, 'full').reduced).toBe(false);
    expect(applyScopedMotionPolicy(system, undefined)).toBe(system);
  });

  it('lets nested theme scopes inherit the local motion without resetting it', () => {
    const html = renderToStaticMarkup(<UiThemeScope theme="xiacheng" motion="reduced">
      <UiThemeScope theme="xiacheng"><span /></UiThemeScope>
    </UiThemeScope>);
    expect(html.match(/data-motion="reduced"/g)).toHaveLength(2);
  });

  it('keeps an ancestor reduced floor when nested scopes or providers request full', () => {
    const html = renderToStaticMarkup(<UiThemeScope theme="xiacheng" motion="reduced">
      <UiThemeProvider motion="full">
        <UiThemeScope theme="xiacheng" motion="full"><span>explicit full</span></UiThemeScope>
        <UiThemeScope theme="xiacheng"><span>inherited through provider</span></UiThemeScope>
      </UiThemeProvider>
    </UiThemeScope>);
    expect(html.match(/data-motion="reduced"/g)).toHaveLength(3);
    expect(html).not.toContain('data-motion="full"');
  });

  it('reports the reduced effective policy through nested full requests', () => {
    const html = renderToStaticMarkup(<MotionPolicyProvider preference="full">
      <UiThemeScope theme="xiacheng" motion="reduced">
        <UiThemeProvider motion="full">
          <UiThemeScope theme="xiacheng" motion="full"><PolicyProbe /></UiThemeScope>
        </UiThemeProvider>
      </UiThemeScope>
    </MotionPolicyProvider>);
    expect(html).toContain('>reduced<');
  });

  it('still allows explicit full outside an ancestor reduced', () => {
    const html = renderToStaticMarkup(<MotionPolicyProvider preference="full">
      <UiThemeScope theme="xiacheng" motion="full"><PolicyProbe /></UiThemeScope>
    </MotionPolicyProvider>);
    expect(html).toContain('data-motion="full"');
    expect(html).toContain('>full<');
  });

  it('cancels the previous animation for the same element slot and clears on scope disposal', () => {
    const cancelled: string[] = [];
    let created = 0;
    const element = {
      animate: () => {
        const id = String(++created);
        return { cancel: () => cancelled.push(id), finished: new Promise(() => undefined) };
      }
    } as unknown as Element;
    const scope = createMotionScope();
    scope.run(element, [], { duration: 100, slot: 'dock' });
    scope.run(element, [], { duration: 100, slot: 'dock' });
    expect(created).toBe(2);
    expect(cancelled).toEqual(['1']);
    scope.cancelAll();
    expect(cancelled).toEqual(['1', '2']);
    expect(scope.size).toBe(0);
  });
});

describe('modal layer stack', () => {
  class FakeElement {
    inert = false;
    tagName = 'DIV';
    style = { overflow: '', zIndex: '' };
    attributes = new Map<string, string>();
    constructor(public children: FakeElement[] = []) {}
    getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
    setAttribute(name: string, value: string): void { this.attributes.set(name, String(value)); }
    removeAttribute(name: string): void { this.attributes.delete(name); }
  }

  it('keeps only the top layer active and restores isolation after nested removal', () => {
    const body = new FakeElement();
    const background = new FakeElement();
    const firstBackdrop = new FakeElement();
    const secondBackdrop = new FakeElement();
    body.children.push(background, firstBackdrop, secondBackdrop);
    body.style.overflow = 'auto';
    const globals = globalThis as unknown as { document?: unknown; HTMLElement?: unknown };
    const previousDocument = globals.document;
    const previousElement = globals.HTMLElement;
    globals.document = { body };
    globals.HTMLElement = FakeElement;
    try {
      const manager = createModalLayerManager();
      const other = createModalLayerManager();
      const first = { backdrop: firstBackdrop as unknown as HTMLElement, panel: new FakeElement() as unknown as HTMLElement };
      const second = { backdrop: secondBackdrop as unknown as HTMLElement, panel: new FakeElement() as unknown as HTMLElement };
      manager.push(first);
      expect(manager.isTop(first)).toBe(true);
      expect(body.style.overflow).toBe('hidden');
      expect(background.inert).toBe(true);
      expect(firstBackdrop.style.zIndex).toBe('1000');
      manager.push(second);
      expect(manager.isTop(second)).toBe(true);
      expect(manager.isTop(first)).toBe(false);
      expect(firstBackdrop.inert).toBe(true);
      expect(firstBackdrop.getAttribute('aria-hidden')).toBe('true');
      expect(secondBackdrop.style.zIndex).toBe('1010');
      manager.remove(second);
      expect(manager.isTop(first)).toBe(true);
      expect(background.inert).toBe(true);
      expect(background.getAttribute('aria-hidden')).toBe('true');
      expect(firstBackdrop.inert).toBe(false);
      expect(firstBackdrop.getAttribute('aria-hidden')).toBe(null);
      expect(body.style.overflow).toBe('hidden');
      manager.remove(first);
      expect(manager.size).toBe(0);
      expect(background.inert).toBe(false);
      expect(background.getAttribute('aria-hidden')).toBe(null);
      expect(body.style.overflow).toBe('auto');
      expect(other.size).toBe(0);
    } finally {
      if (previousDocument === undefined) delete globals.document; else globals.document = previousDocument;
      if (previousElement === undefined) delete globals.HTMLElement; else globals.HTMLElement = previousElement;
    }
  });
});

describe('shared component motion contracts', () => {
  it('keeps disclosure visibility in the theme-independent base layer', () => {
    const base = readFileSync(new URL('../desktop/renderer/src/ui/theme.css', import.meta.url), 'utf8');
    const themed = readFileSync(new URL('../desktop/renderer/src/ui/character-theme.css', import.meta.url), 'utf8');
    expect(base).toMatch(/\.ui-disclosure-body\s*\{[^}]*grid-template-rows:\s*0fr/);
    expect(base).toMatch(/\.ui-disclosure\[data-open="true"\]\s+\.ui-disclosure-body\s*\{[^}]*grid-template-rows:\s*1fr/);
    expect(base).toMatch(/\.ui-disclosure-inner\s*\{[^}]*min-height:\s*0[^}]*overflow:\s*hidden/);
    expect(themed).not.toMatch(/\[data-ui-theme="xiacheng"\]\s+\.ui-disclosure-body/);
  });

  it('leaves the settings dialog entrance to the shared modal', () => {
    const css = readFileSync(new URL('../desktop/renderer/src/styles.css', import.meta.url), 'utf8');
    expect(css).not.toMatch(/\.settings-dialog\s*\{[^}]*animation:/);
    expect(css).not.toContain('@keyframes settings-appear');
  });

  it('does not let a local full scope bypass system reduced in the shared styles', () => {
    const css = ['theme.css', 'character-theme.css', 'dock-notebook.css']
      .map((name) => readFileSync(new URL(`../desktop/renderer/src/ui/${name}`, import.meta.url), 'utf8'))
      .join('\n');
    expect(css).not.toMatch(/\[data-ui-theme="xiacheng"\]:not\(\[data-motion="full"\]\)/);
    expect(css).toContain('html:not([data-motion="full"]) [data-ui-theme="xiacheng"] *');
  });

  it('renders the drawn success check and decorative stamp only for success', () => {
    const success = renderToStaticMarkup(<UiThemeScope theme="xiacheng"><Button feedback="success" feedbackKey="save-1">已保存</Button></UiThemeScope>);
    expect(success).toContain('ui-button-check');
    expect(success).toContain('ui-button-stamp');
    expect(success).toContain('已收好');
    expect(success).toContain('aria-hidden="true"');
    expect(success).toContain('已保存');
    const plain = renderToStaticMarkup(<UiThemeScope theme="xiacheng"><Button feedback="success" resultLabel={false}>已保存</Button></UiThemeScope>);
    expect(plain).toContain('ui-button-check');
    expect(plain).not.toContain('ui-button-stamp');
    const error = renderToStaticMarkup(<UiThemeScope theme="xiacheng"><Button feedback="error">重试</Button></UiThemeScope>);
    expect(error).not.toContain('ui-button-check');
    expect(error).not.toContain('ui-button-stamp');
  });

  it('keeps the entry endcap in the public button markup', () => {
    const html = renderToStaticMarkup(<UiThemeScope theme="xiacheng"><Button variant="entry">进入工作台</Button></UiThemeScope>);
    expect(html).toContain('ui-button-end');
    expect(html).toContain('ui-button-label');
  });

  it('keeps disclosure content mounted while excluding the collapsed body from focus', () => {
    const closed = renderToStaticMarkup(<Disclosure title="样例"><input defaultValue="draft" /></Disclosure>);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain('inert');
    expect(closed).toContain('ui-disclosure-inner');
    expect(closed).toContain('value="draft"');
    const open = renderToStaticMarkup(<Disclosure title="样例" defaultOpen><input defaultValue="draft" /></Disclosure>);
    expect(open).toContain('aria-expanded="true"');
    expect(open).not.toContain('inert');
    expect(open).toContain('value="draft"');
  });

  it('keeps the menu trigger semantic while adding dock content slots', () => {
    const html = renderToStaticMarkup(<DropdownMenu label="更多" triggerIcon="more" triggerLayout="stacked" triggerClassName="ui-dock-more"
      triggerDecoration={<span className="ui-dock-surface" />} items={[{ id: 'a', label: '总览', onSelect() {} }]} />);
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('ui-menu-trigger-icon');
    expect(html).toContain('ui-menu-trigger-label');
    expect(html).toContain('ui-dock-more');
    expect(html).toContain('ui-dock-surface');
    expect(html).not.toContain('role="menu"');
  });

  it('keeps dock material recipes on component tokens', () => {
    const css = readFileSync(new URL('../desktop/renderer/src/ui/dock-notebook.css', import.meta.url), 'utf8');
    const variables = ['day-surface-mix', 'day-seam-mix', 'item-surface-mix', 'item-selection-mix', 'item-border-mix',
      'marker-surface-mix', 'marker-border-mix', 'marker-hairline-mix', 'marker-inset-mix', 'day-dock-hairline-mix',
      'day-shadow-mix', 'marker-shadow-mix', 'night-surface-mix', 'night-seam-mix', 'night-spine-mix',
      'night-marker-glow-mix', 'night-marker-inset-mix', 'night-surface-border-mix', 'night-surface-inset-mix',
      'night-surface-press-mix', 'night-dock-hairline-mix', 'night-dock-shadow-color', 'night-marker-shadow-color'];
    for (const variable of variables) expect(css).toContain(`var(--nd-component-dock-notebook-${variable})`);
    expect(css).not.toMatch(/rgba\(3, 7, 14/);
  });
});

describe('global dock and home reading structure', () => {
  it('keeps one shared marker and marks only the committed route', () => {
    const home = renderToStaticMarkup(<PageDock page="home" onNavigate={() => {}} />);
    expect(home).toContain('aria-label="主导航"');
    expect(home).toContain('ui-dock-marker');
    expect(home.match(/ui-dock-item/g)?.length).toBe(4);
    expect(home.match(/aria-current="page"/g)?.length).toBe(1);
    expect(home).not.toContain('data-current="true"');
    const diagnostics = renderToStaticMarkup(<PageDock page="diagnostics" onNavigate={() => {}} />);
    expect(diagnostics).not.toContain('aria-current="page"');
    expect(diagnostics).toContain('data-current="true"');
    expect(diagnostics).toContain('更多，当前页面：事件诊断');
  });

  it('renders the real dock instead of a second navigation sample', () => {
    const html = renderToStaticMarkup(<WorkbenchRoot />);
    expect(html.match(/ui-page-dock/g)?.length).toBe(1);
    expect(html).toContain('aria-label="主导航"');
    expect(html).toContain('ui-dock-marker');
    expect(html).toContain('ui-dock-more');
    expect(html.match(/ui-dock-item/g)?.length).toBe(4);
    expect(html).not.toContain('页面导航样例');
  });

  it('renders three reading groups around the account state and primary entry', () => {
    const html = renderToStaticMarkup(<HomePage selectedAccountId="" loading accounts={undefined} onRetry={async () => {}} onGoWorkbench={() => {}} />);
    expect(html.match(/data-home-reading="[012]"/g)).toEqual(['data-home-reading="0"', 'data-home-reading="1"', 'data-home-reading="2"']);
    expect(html).toContain('进入工作台');
    expect(html).toContain('home-primary-actions');
  });
});
