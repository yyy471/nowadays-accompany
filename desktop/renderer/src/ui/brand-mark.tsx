import light from '../assets/brand/fold-light.svg';
import dark from '../assets/brand/fold-dark.svg';
import { useUiAppearance } from './appearance';
import './brand-mark.css';

/** 折信品牌符号，仅跟随当前界面的外观预置。 */
export function BrandMark() {
  const { preset } = useUiAppearance();
  return <img className="ui-brand-mark" src={preset === 'nightwave' ? dark : light} alt="" aria-hidden="true" width={34} height={36} draggable={false} />;
}
