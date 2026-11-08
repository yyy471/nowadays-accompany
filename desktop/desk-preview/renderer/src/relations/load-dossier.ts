import { api } from '../api';
import { appearanceAssetUrl, type Outfit, type RoleDetail, type RoleStateResponse } from '../types';
import { diaryParagraphs, diaryTitle, formatExperienceDate, stateLines, stateSentence, type RelationDiary, type RelationEvent, type RelationPacket, type RelationSummary } from './dossier.js';

interface SearchItem { type: string; id: string; title: string; snippet: string }
interface EventDetail { title: string; summary: string; subjectiveExperience?: string; experienceDate: string; sources?: Array<{ evidenceId: string }> }
interface DiaryRecord { diaryId: string; experienceDate: string }
interface DiaryDetail { content: string; experienceDate: string }
interface SummaryDetail { topic?: string; summary: string; experienceDate: string }

async function search(roleId: string, type: 'event' | 'diary' | 'daily_summary', limit: number, signal: AbortSignal): Promise<SearchItem[]> {
  const result = await api<{ items: SearchItem[] }>(`/v1/roles/${encodeURIComponent(roleId)}/memory/search`, {
    method: 'POST',
    body: { types: [type], limit },
    signal
  });
  return result.items.filter(item => item.type === type);
}

export async function loadRelationPacket(roleId: string, signal: AbortSignal): Promise<RelationPacket> {
  const [role, stateResult, wardrobe] = await Promise.all([
    api<RoleDetail & { createdAt?: string }>(`/v1/roles/${encodeURIComponent(roleId)}`, { signal }),
    api<RoleStateResponse>(`/v1/roles/${encodeURIComponent(roleId)}/state`, { signal }),
    api<{ items: Outfit[] }>(`/v1/roles/${encodeURIComponent(roleId)}/appearance/outfits`, { signal })
  ]);
  const outfitId = typeof stateResult.state.outfitId === 'string' ? stateResult.state.outfitId : '';
  const home = wardrobe.items.find(item => item.outfitId === outfitId)?.home ?? null;
  let memoryError = '';
  let events: RelationEvent[] = [];
  let diaries: RelationDiary[] = [];
  let summaries: RelationSummary[] = [];
  try {
    const [eventHits, diaryHits, summaryHits, diaryList] = await Promise.all([
      search(roleId, 'event', 8, signal),
      search(roleId, 'diary', 8, signal),
      search(roleId, 'daily_summary', 6, signal),
      api<{ items: DiaryRecord[] }>(`/v1/roles/${encodeURIComponent(roleId)}/diaries`, { signal })
    ]);
    events = await Promise.all(eventHits.map(async hit => {
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
    const diaryIds = diaryList.items.slice(0, 8);
    const diaryOrder = new Map(diaryHits.map((hit, index) => [hit.id, index]));
    diaries = (await Promise.all(diaryIds.map(async record => {
      const detail = await api<DiaryDetail>(`/v1/roles/${encodeURIComponent(roleId)}/diaries/${encodeURIComponent(record.diaryId)}`, { signal });
      const date = formatExperienceDate(detail.experienceDate || record.experienceDate);
      return { id: record.diaryId, date, title: diaryTitle(detail.content, date), paragraphs: diaryParagraphs(detail.content) };
    }))).sort((left, right) => (diaryOrder.get(left.id) ?? 99) - (diaryOrder.get(right.id) ?? 99) || right.date.localeCompare(left.date));
    summaries = await Promise.all(summaryHits.map(async hit => {
      try {
        const detail = await api<SummaryDetail>(`/v1/roles/${encodeURIComponent(roleId)}/memory/summaries/${encodeURIComponent(hit.id)}`, { signal });
        return { id: hit.id, date: formatExperienceDate(detail.experienceDate), title: detail.topic || hit.title, summary: detail.summary || hit.snippet };
      } catch {
        return { id: hit.id, date: '', title: hit.title, summary: hit.snippet };
      }
    }));
  } catch (error) {
    if (signal.aborted) throw error;
    memoryError = error instanceof Error ? error.message : String(error);
  }
  return {
    roleId,
    displayName: role.displayName,
    definitionText: role.definition?.text ?? '',
    definitionRevision: role.definitionRevision,
    createdAt: role.createdAt ?? '',
    stateLines: stateLines(stateResult.state),
    sentence: stateSentence(stateResult.state),
    portraitUrl: home ? appearanceAssetUrl(roleId, home.assetId) : null,
    events,
    diaries,
    summaries,
    memoryError
  };
}
