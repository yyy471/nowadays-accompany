import { Icon } from '../ui';

export function AccountAvatar({
  dataUrl,
  label,
  className = 'account-avatar',
  iconSize = 23
}: {
  dataUrl?: string;
  label: string;
  className?: string;
  iconSize?: number;
}) {
  return (
    <span className={className} role="img" aria-label={dataUrl ? label : `${label}（默认头像）`}>
      {dataUrl
        ? <img src={dataUrl} alt="" />
        : <span className="avatar-fallback"><Icon name="user" size={iconSize} /></span>}
    </span>
  );
}
