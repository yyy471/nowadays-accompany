import './voice-wave.css';

export function VoiceWave({ state }: { state: 'synthesizing' | 'playing' }) {
  return <span className="ui-voice-wave" data-state={state} aria-hidden="true">
    <span /><span /><span /><span />
  </span>;
}
