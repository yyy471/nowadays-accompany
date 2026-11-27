import { useState } from 'react';

import type { RoleFaceImage } from './role-face-image';
export type { RoleFaceImage } from './role-face-image';
import '../styles/role-face.css';

/** 只消费宿主已读取的素材。裁切依据图片本身的预设标志。 */
export function RoleFace({ name, image }: { name: string; image?: RoleFaceImage }) {
  const [broken, setBroken] = useState('');
  return <span className="role-face" aria-hidden="true">
    {image && image.url !== broken ? <img src={image.url} alt="" data-preset={image.preset || undefined}
      onError={() => setBroken(image.url)}/> : Array.from(name.trim())[0] || '角'}
  </span>;
}
