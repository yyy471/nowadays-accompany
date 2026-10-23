import type { SlotsResponse } from '../types';
import { QqConnections } from './QqConnections';
export function SlotsPage({ data, error, refresh, onSettings }: {
  data?: SlotsResponse; error?: string; refresh: () => Promise<void>; onSettings?: () => void;
}) {
  return <QqConnections data={data} error={error} refresh={refresh} onSettings={onSettings}/>;
}
