import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { Button, Field, Input, Select, Textarea, Switch, UiThemeScope } from '../desktop/renderer/src/ui';

vi.stubGlobal('React', React);
afterAll(() => vi.unstubAllGlobals());

describe('character theme accessibility contracts', () => {
  it.each(['input', 'select', 'textarea'])('associates Field hint, error and caller description with %s', kind => {
    const child = kind === 'select' ? <Select aria-describedby="external"><option>sample</option></Select>
      : kind === 'textarea' ? <Textarea aria-describedby="external" /> : <Input aria-describedby="external" />;
    const html = renderToStaticMarkup(<Field id="model-name" label="模型名称" hint="help" error="missing">{child}</Field>);
    expect(html).toContain('for="model-name"');
    expect(html).toContain('id="model-name"');
    expect(html).toContain('aria-describedby="external model-name-hint model-name-error"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="model-name-error"');
  });

  it('preserves legacy busy disabling, and keeps themed busy actions focusable but unavailable', () => {
    const old = renderToStaticMarkup(<Button busy>saving</Button>);
    const themed = renderToStaticMarkup(<UiThemeScope theme="xiacheng"><Button busy>saving</Button></UiThemeScope>);
    expect(old).toContain('disabled=""');
    expect(themed).not.toContain('disabled=""');
    expect(themed).toContain('aria-disabled="true"');
    expect(themed).toContain('aria-busy="true"');
    expect(themed).toContain('saving');
  });

  it('does not turn an ordinary field invalid or discard explicit accessibility metadata', () => {
    const html = renderToStaticMarkup(<Field id="name" label="name"><Input aria-describedby="outside" /></Field>);
    expect(html).not.toContain('aria-invalid');
    expect(html).toContain('aria-describedby="outside"');
    expect(html).not.toContain('-error');
  });

  it('uses a controlled switch with a stable name and distinct checked/busy state', () => {
    const html = renderToStaticMarkup(<Switch label="自动回复" checked busy onCheckedChange={() => {}} />);
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-label="自动回复"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
  });
});
