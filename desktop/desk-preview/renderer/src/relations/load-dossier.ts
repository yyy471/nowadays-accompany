import { api } from '../api';
import { appearanceAssetUrl, type Outfit, type RoleDetail, type RoleStateResponse } from '../types';
import { diaryParagraphs, diaryTitle, formatExperienceDate, stateLines, stateSentence, type RelationDiary, type RelationEvent, type RelationPacket, type RelationSummary } from './dossier.js';

interface SearchItem { type: string; id: string; title: string; snippet: string }
interface EventDetail { title: string; summary: string; subjectiveExperience?: string; experienceDate: string; sources?: Array<{ evidenceId: string }> }
interface DiaryRecord { diaryId: string; experienceDate: string }
interface DiaryDetail { content: string; experienceDate: string }
interface SummaryDetail { topic?: string; summary: string; experienceDate: string }

const reasonText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);

async function search(roleId: string, type: 'event' | 'diary' | 'daily_summary', limit: number, signal: AbortSignal): Promise<SearchItem[]> {
  const result = await api<{ items: SearchItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/memory/search`, {
    method: 'POST',
    body: { types: [type], limit },
    signal
  });
  return result.items.filter(item => item.type === type);
}

/**
 * 读取一位角色的整份资料。
 * 角色本身一到就通过 onPartial 发布；经历、日常概况和日记各自返回就各自更新，
 * 一篇慢日记只延后它自己，不挡住首页近况、经历和已经读到的日记。
 */
export async function loadRelationPacket(
  roleId: string,
  signal: AbortSignal,
  onPartial?: (packet: RelationPacket) => void
): Promise<RelationPacket> {
  const [role, stateResult, wardrobe] = await Promise.all([
    api<RoleDetail & { createdAt?: string }>(`/v1/roles/${encodeURIComponent(roleId)}`, { signal }),
    api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`, { signal }),
    api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`, { signal })
  ]);
  const outfitId = typeof stateResult.state.outfitId === 'string' ? stateResult.state.outfitId : '';
  const home = wardrobe.items.find(item => item.outfitId === outfitId)?.home ?? null;
  const packet: RelationPacket = {
    roleId,
    displayName: role.displayName,
    definitionText: role.definition?.text ?? '',
    definitionRevision: role.definitionRevision,
    createdAt: role.createdAt ?? '',
    stateLines: stateLines(stateResult.state),
    sentence: stateSentence(stateResult.state),
    portraitUrl: home ? appearanceAssetUrl(roleId, home.assetId) : null,
    events: [],
    diaries: [],
    summaries: [],
    memoryError: '',
    diaryError: '',
    pending: { events: true, summaries: true, diaries: true }
  };
  const snapshot = (): RelationPacket => ({
    ...packet,
    events: [...packet.events],
    diaries: [...packet.diaries],
    summaries: [...packet.summaries],
    pending: { ...packet.pending }
  });
  const publish = () => {
    if (signal.aborted) return;
    onPartial?.(snapshot());
  };
  const noteMemoryError = (reason: unknown) => {
    if (signal.aborted) return;
    const message = reasonText(reason);
    packet.memoryError = packet.memoryError ? `${packet.memoryError}；${message}` : message;
  };
  publish();

  const tasks = [
    (async () => {
      try {
        const eventHits = await search(roleId, 'event', 8, signal);
        const events = await Promise.all(eventHits.map(async hit => {
          try {
            const detail = await api<EventDetail>(`/v1/roles/${encodeURIComponent(roleId)}/memory/events/${encodeURIComponent(hit.id)}`, { signal });
            return {
              id: hit.id,
              date: formatExperienceDate(detail.experienceDate),
              title: detail.title || hit.title,
              summary: detail.summary || hit.snippet,
              subjective: (detail.subjectiveExperience || '').trim(),
              evidenceIds: (detail.sources ?? []).map(source => source.evidenceId).filter(Boolean)
            };
          } catch {
            return { id: hit.id, date: '', title: hit.title, summary: hit.snippet, subjective: '', evidenceIds: [] };
          }
        }));
        if (signal.aborted) return;
        packet.events = events;
      } catch (reason) {
        noteMemoryError(reason);
      } finally {
        packet.pending.events = false;
        publish();
      }
    })(),
    (async () => {
      try {
        const summaryHits = await search(roleId, 'daily_summary', 6, signal);
        const summaries = await Promise.all(summaryHits.map(async hit => {
          try {
            const detail = await api<SummaryDetail>(`/v1/roles/${encodeURIComponent(roleId)}/memory/summaries/${encodeURIComponent(hit.id)}`, { signal });
            return { id: hit.id, date: formatExperienceDate(detail.experienceDate), title: detail.topic || hit.title, summary: detail.summary || hit.snippet };
          } catch {
            return { id: hit.id, date: '', title: hit.title, summary: hit.snippet };
          }
        }));
        if (signal.aborted) return;
        packet.summaries = summaries;
      } catch (reason) {
        noteMemoryError(reason);
      } finally {
        packet.pending.summaries = false;
        publish();
      }
    })(),
    (async () => {
      try {
        const diaryList = await api<{ items: DiaryRecord[] }>(`/v1/roles/${encodeURIComponent(roleId)}/diaries`, { signal });
        const records = diaryList.items;
        // 日记列表接口没有分页。详情用固定并发 8 的滑动窗口读取：
        // 一篇慢日记只占住自己那个位置，同批和后续日记照常返回、照常显示。
        const slots: Array<RelationDiary | null> = records.map(() => null);
        let next = 0;
        let failed = 0;
        const publishDiaries = () => {
          if (signal.aborted) return;
          packet.diaries = slots.filter((entry): entry is RelationDiary => entry !== null);
          packet.diaryError = failed ? `${failed} 篇日记读取失败。` : '';
          publish();
        };
        const worker = async () => {
          while (!signal.aborted) {
            const index = next++;
            if (index >= records.length) return;
            const record = records[index];
            try {
              const detail = await api<DiaryDetail>(`/v1/roles/${encodeURIComponent(roleId)}/diaries/${encodeURIComponent(record.diaryId)}`, { signal });
              if (signal.aborted) return;
              const date = formatExperienceDate(detail.experienceDate || record.experienceDate);
              slots[index] = { id: record.diaryId, date, title: diaryTitle(detail.content, date), paragraphs: diaryParagraphs(detail.content) };
            } catch {
              if (signal.aborted) return;
              failed += 1;
            }
            publishDiaries();
          }
        };
        await Promise.all(Array.from({ length: Math.min(8, records.length) }, worker));
        publishDiaries();
      } catch (reason) {
        if (!signal.aborted) packet.diaryError = reasonText(reason);
      } finally {
        packet.pending.diaries = false;
        publish();
      }
    })()
  ];
  await Promise.all(tasks);
  if (signal.aborted) throw new DOMException('请求已取消', 'AbortError');
  return snapshot();
}
