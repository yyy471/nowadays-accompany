import type { ReactNode } from 'react';

export type IconName =
  | 'overview'
  | 'slots'
  | 'accounts'
  | 'artifacts'
  | 'messages'
  | 'activity'
  | 'settings'
  | 'play'
  | 'stop'
  | 'plus'
  | 'trash'
  | 'refresh'
  | 'send'
  | 'warning'
  | 'copy'
  | 'check'
  | 'close'
  | 'chevron'
  | 'more'
  | 'radio'
  | 'folder'
  | 'search'
  | 'clock'
  | 'shield'
  | 'bolt'
  | 'terminal'
  | 'user'
  | 'package'
  | 'speaker'
  | 'history'
  | 'image'
  | 'tune'
  | 'down'
  | 'person'
  | 'locate'
  | 'chev-left'
  | 'chev-right'
  | 'chev-up'
  | 'chev-down'
  | 'calendar'
  | 'reset'
  | 'upload'
  | 'sun'
  | 'moon';

const ICONS: Record<IconName, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="2" />
      <rect x="14" y="3" width="7" height="7" rx="2" />
      <rect x="3" y="14" width="7" height="7" rx="2" />
      <rect x="14" y="14" width="7" height="7" rx="2" />
    </>
  ),
  slots: (
    <>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 16 9 5 9-5" />
    </>
  ),
  accounts: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20c.5-3.5 2.7-5.4 5.5-5.4s5 1.9 5.5 5.4" />
      <path d="M16 5.5a3 3 0 0 1 0 5.8" />
      <path d="M17.5 14.8c1.8.5 2.9 2.2 3 5.2" />
    </>
  ),
  artifacts: (
    <>
      <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" />
      <path d="m3.8 7.6 8.2 4.3 8.2-4.3" />
      <path d="M12 12v9" />
    </>
  ),
  messages: (
    <>
      <path d="M20.5 11.6a8.4 8.4 0 0 1-8.5 8.4 9.4 9.4 0 0 1-4-.9L3.5 20l1-4.3a8.1 8.1 0 0 1-1-4A8.4 8.4 0 0 1 12 3.4a8.4 8.4 0 0 1 8.5 8.2Z" />
      <path d="M8.5 10.5h7M8.5 14h4.5" />
    </>
  ),
  activity: (
    <>
      <path d="M3 12h4l2.2-6 4.2 12 2.1-6H21" />
    </>
  ),
  settings: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h7M15 18h5" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="13" cy="18" r="2" />
    </>
  ),
  play: <path d="M8 5.5v13l10-6.5-10-6.5Z" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 13h9.4l.8-13" />
      <path d="M10 11v5M14 11v5" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 11a8 8 0 0 0-14.4-4.6L4 8" />
      <path d="M4 4v4h4" />
      <path d="M4 13a8 8 0 0 0 14.4 4.6L20 16" />
      <path d="M20 20v-4h-4" />
    </>
  ),
  send: <path d="m4 12 16-8-5.5 16-3-6.2L4 12Z" />,
  warning: (
    <>
      <path d="M12 4 2.8 20h18.4L12 4Z" />
      <path d="M12 9.5v5M12 17.6v.1" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </>
  ),
  check: <path d="m4.5 12.5 5 5 10-11" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  chevron: <path d="m8 10 4 4 4-4" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 6.5A2.5 2.5 0 0 1 6 4h3l2 2.5h7a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17V6.5Z" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5.5c0 4.4 2.8 7.7 7 9.5 4.2-1.8 7-5.1 7-9.5V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  bolt: <path d="M13.5 3 5 13.5h5L9.5 21 19 10h-5.5l0-7Z" />,
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <path d="m7 9 3 3-3 3M12.5 15H17" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20.5c.6-4.2 3.3-6.5 7-6.5s6.4 2.3 7 6.5" />
    </>
  ),
  package: (
    <>
      <path d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5v-7Z" />
      <path d="m4 8.5 8 4.5 8-4.5M12 13v7" />
    </>
  ),
  speaker: (
    <>
      <path d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path d="M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  history: (
    <>
      <path d="M4 9a8.5 8.5 0 1 1-.2 6M4 4v5h5M12 7v5l3 2" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <circle cx="8" cy="9" r="1.5" />
      <path d="m4 18 5-5 4 4 3-3 5 5" />
    </>
  ),
  tune: <path d="M4 7h16M4 12h16M4 17h16M8 5v4m8 1v4m-6 1v4" />,
  down: <path d="M12 4v16m-6-6 6 6 6-6" />,
  person: (
    <>
      <circle cx="12" cy="7.5" r="3.5" />
      <path d="M5 21v-3a7 7 0 0 1 14 0v3" />
    </>
  ),
  locate: (
    <>
      <path d="M4 6h16M4 18h16M12 3v18m-4-4 4 4 4-4" />
    </>
  ),
  'chev-left': <path d="m15 5-7 7 7 7" />,
  'chev-right': <path d="m9 5 7 7-7 7" />,
  'chev-up': <path d="m5 15 7-7 7 7" />,
  'chev-down': <path d="m5 9 7 7 7-7" />,
  calendar: (
    <>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M7 2v6m10-6v6M3 11h18M8 15h2m4 0h2m-8 3h2" />
    </>
  ),
  reset: (
    <>
      <path d="M4 9a8.5 8.5 0 1 1 .5 7M4 4v5h5" />
    </>
  ),
  upload: <path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
    </>
  ),
  moon: <path d="M20.5 14.4A8.7 8.7 0 0 1 9.6 3.5 8.8 8.8 0 1 0 20.5 14.4Z" />
};

export function Icon({
  name,
  size = 18,
  className
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICONS[name]}
    </svg>
  );
}
