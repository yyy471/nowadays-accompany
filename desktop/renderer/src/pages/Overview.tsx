import type { SlotsResponse, StreamEvent } from '../types';
import { Button, Card } from '../ui';
import { QqConnections } from './QqConnections';

interface OverviewPageProps {
  slots?: SlotsResponse; slotsError?: string; events: StreamEvent[];
  onNavigate: (page: string) => void; refreshSlots: () => Promise<void>;
}
export function OverviewPage({ slots, slotsError, onNavigate, refreshSlots }: OverviewPageProps) {
  return <div className="page-stack">
    <QqConnections data={slots} error={slotsError} refresh={refreshSlots} onSettings={() => onNavigate('settings')}/>
    <Card title="账号准备" subtitle="连接后，为需要互动的群聊和私聊单独绑定角色，再选择账号模型。">
      <div className="connection-shortcuts">
        <Button icon="accounts" onClick={() => onNavigate('roles')}>资料与角色</Button>
        <Button icon="bolt" onClick={() => onNavigate('model-config')}>模型配置</Button>
        <Button icon="package" onClick={() => onNavigate('artifacts')}>资源库</Button>
      </div>
    </Card>
  </div>;
}
