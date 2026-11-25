import {
  summarizeProbe,
  type VoiceEngineStatus,
  type VoiceProbeResult,
} from '../../voice-config';
import { Field, Input, Select } from '../../ui';
import { ProbeFeedback } from '../config/ProbeFeedback';
import type { VoiceProbeNotice } from './use-voice-probe';

export function VoiceProbeFeedback({ busy, notice }: { busy: boolean; notice: VoiceProbeNotice | null }) {
  return <ProbeFeedback busy={busy} notice={notice && { ...notice, role: notice.kind }} testAnnouncedExternally/>;
}

export function formatVoiceEngineLabel(
  id: string,
  status: VoiceEngineStatus,
  defaultEngine: string | null,
): string {
  const name =
    id === 'cosyvoice'
      ? 'CosyVoice3'
      : id === 'indextts'
        ? 'IndexTTS-2.5'
        : id;
  const tag = id === defaultEngine ? ' · 默认' : '';
  const state = status.active
    ? '运行中'
    : status.ready
      ? '已就绪'
      : status.onDemand
        ? '按需切换'
        : '未就绪';
  return `${name}${tag}（${state}）`;
}

export function VoiceProbeSummaryBox({
  probe,
}: {
  probe: VoiceProbeResult | null;
}) {
  const summary = summarizeProbe(probe);
  if (summary === null) return null;
  return (
    <div className="nd-voice-probe">
      <small>
        {summary.service || '未知服务'} · {summary.model || '未知模型'} · {summary.ready ? '已就绪' : '未就绪'}
      </small>
      <small>
        参考模式 {summary.referenceModes.length} 种 · 预置音色{' '}
        {summary.supportsPreset ? `${summary.presetVoiceCount} 个` : '不支持'} · 语言{' '}
        {summary.languages.length > 0 ? summary.languages.join('、') : '未声明'}
        {summary.speed === null ? '' : ` · 语速 ${summary.speed.min}～${summary.speed.max}`}
      </small>
      {summary.engines ? (
        <small>
          引擎：
          {Object.entries(summary.engines)
            .map(([id, status]) => formatVoiceEngineLabel(id, status, summary.defaultEngine))
            .join(' · ')}
        </small>
      ) : null}
    </div>
  );
}

export function VoiceDefaultEngineField({
  value,
  onChange,
  engines,
  probeDefaultEngine,
  disabled = false,
}: {
  value: string;
  onChange: (next: string) => void;
  engines: Record<string, VoiceEngineStatus> | null;
  probeDefaultEngine: string | null;
  disabled?: boolean;
}) {
  const engineEntries = engines ? Object.entries(engines) : [];
  if (engineEntries.length > 0) {
    return (
      <Field
        label="默认引擎（可选）"
        hint="角色设为「跟随服务默认」时使用这里选择的引擎；留空则由桥接服务自行决定。"
      >
        <Select
          aria-label="默认语音引擎"
          disabled={disabled}
          value={value}
          onChange={event => onChange(event.target.value)}
        >
          <option value="">
            {probeDefaultEngine ? `由服务端决定（当前默认 ${probeDefaultEngine}）` : '由服务端决定'}
          </option>
          {engineEntries.map(([id, status]) => (
            <option key={id} value={id}>
              {formatVoiceEngineLabel(id, status, probeDefaultEngine)}
            </option>
          ))}
          {value.trim().length > 0 && !engineEntries.some(([id]) => id === value.trim()) ? (
            <option value={value.trim()}>{value.trim()}</option>
          ) : null}
        </Select>
      </Field>
    );
  }
  return (
    <Field
      label="默认引擎（可选）"
      hint="点击「测试连接」可从检测到的引擎列表选择（如 cosyvoice / indextts），也可手填或留空。"
    >
      <Input
        aria-label="默认语音引擎"
        disabled={disabled}
        maxLength={64}
        placeholder="例如 cosyvoice 或 indextts（留空由服务端决定）"
        value={value}
        onChange={event => onChange(event.target.value)}
      />
    </Field>
  );
}
