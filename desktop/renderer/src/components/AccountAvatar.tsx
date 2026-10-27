import { Icon } from '../ui';
import { useState } from 'react';

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
  const [failed,setFailed] = useState<string>();
  const available=Boolean(dataUrl && failed!==dataUrl);
  return (
    <span className={className} role="img" aria-label={available ? label : `${label}（默认头像）`}>
      {available
        ? <img src={dataUrl} alt="" onError={()=>setFailed(dataUrl)} />
        : <span className="avatar-fallback"><Icon name="user" size={iconSize} /></span>}
    </span>
  );
}
