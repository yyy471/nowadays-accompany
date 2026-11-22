import { useEffect, useState } from 'react';
import { api } from '../../../api';
import { Button, announceLive } from '../../../ui';
import { T29, T31 } from '../config-texts';
import { Sheet } from '../sheet/Sheet';
import { useSheet } from '../sheet/sheet-context';
import { useWrite } from '../write-runner';

/**
 * 删除角色需先确定本机数据处置，写入完成并收回纸笺后才切换角色。
 */
export function RoleSheetHost({
  active,
  roleId,
  roleName,
  roleCount,
  needsPause,
  onDeleted,
}: {
  active: boolean;
  roleId: string;
  roleName: string;
  roleCount: number;
  needsPause: boolean;
  onDeleted: (roleId: string, keepHistory: boolean, filesRemoved: boolean) => Promise<void>;
}) {
  const { sheet, requestClose, closeNow, setBusy } = useSheet();
  const write = useWrite();
  const [choice, setChoice] = useState<'keep' | 'remove'>('keep');
  const [error, setError] = useState('');
  const open = active && sheet?.id === 'delete-role';
  useEffect(() => { if (open) { setChoice('keep'); setError(''); } }, [open]);

  const remove = async () => {
    if (!open || write.busy || roleCount < 2) return;
    setError('');
    setBusy(true);
    const keep = choice === 'keep';
    let deleted: { roleId: string; keepHistory: boolean; filesRemoved: boolean } | undefined;
    const result = await write.runWrite({
      roleIds: [roleId],
      verb: T31.delete,
      announceSuccess: false,
      commit: async () => {
        deleted = await api<{ roleId: string; keepHistory: boolean; filesRemoved: boolean }>(
          `/v1/roles/${encodeURIComponent(roleId)}?keepHistory=${keep ? '1' : '0'}`,
          { method: 'DELETE' },
        );
      },
    });
    setBusy(false);
    if (result.ok && deleted) {
      const response = deleted;
      write.forgetPaused(roleId);
      closeNow(() => {
        announceLive(`已删除角色「${roleName}」${response.keepHistory ? '，本机数据已保留。' : response.filesRemoved ? '，本机数据已删除。' : '，部分本机文件尚待清理。'}`);
        void onDeleted(response.roleId, response.keepHistory, response.filesRemoved);
      });
      return;
    }
    if (!result.ok) setError(result.failure.message);
  };

  if (!active) return null;
  return <Sheet idPrefix="delete-role" footer={open
    ? <div className="config-sheet-actions">
      {error && <p className="config-sheet-error" role="alert">{error}</p>}
      <span className="config-sheet-spacer" />
      <button type="button" data-sheet-focus disabled={write.busy} onClick={() => requestClose()}>{T31.cancel}</button>
      <Button
        variant="danger"
        disabled={write.busy || roleCount < 2}
        busy={write.busy}
        onClick={() => void remove()}
      >{write.busy ? write.phase === 'pause' && needsPause ? T29.pausing : T29.deleting : error ? T29.retry('删除') : needsPause ? T31.pauseAndDelete : T31.delete}</Button>
    </div>
    : null}>
    {open && <div className="config-sheet-groups">
      <div className="config-grp" data-sheet-group>
        <div className="config-grp-label"><b>删除</b></div>
        <div>
          <p className="config-sheet-ask">{T31.role.ask(roleName)}</p>
          <label className="config-radio"><input type="radio" name="role-delete" checked={choice === 'keep'} disabled={write.busy} onChange={() => setChoice('keep')} /> {T31.role.keep}</label>
          <label className="config-radio"><input type="radio" name="role-delete" checked={choice === 'remove'} disabled={write.busy} onChange={() => setChoice('remove')} /> {T31.role.remove}</label>
          {roleCount < 2 && <p className="config-inline-hint">至少保留一个角色。</p>}
        </div>
      </div>
    </div>}
  </Sheet>;
}
