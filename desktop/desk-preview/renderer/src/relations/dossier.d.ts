export interface RoleTicket { token: number; roleId: string }
export interface RoleRequestGate {
  begin(nextRoleId: string): RoleTicket;
  accept(ticket: RoleTicket): boolean;
  currentRoleId(): string;
}
export interface StateLine { key: string; label: string; value: string }
export interface RelationPacket {
  roleId: string;
  displayName: string;
  definitionText: string;
  definitionRevision: number;
  createdAt: string;
  stateLines: StateLine[];
  sentence: string;
  portraitUrl: string | null;
  events: RelationEvent[];
  diaries: RelationDiary[];
  summaries: RelationSummary[];
  memoryError: string;
}
export interface RelationEvent {
  id: string;
  date: string;
  title: string;
  summary: string;
  subjective: string;
  evidenceIds: string[];
}
export interface RelationDiary {
  id: string;
  date: string;
  title: string;
  paragraphs: string[];
}
export interface RelationSummary {
  id: string;
  date: string;
  title: string;
  summary: string;
}
export interface RelationUi {
  roleId: string;
  view: "home" | "experiences" | "diary" | "profile";
  packet: RelationPacket | null;
  openEventId: string | null;
  evidenceId: string | null;
  diaryIndex: number;
  error: string;
}
export type RelationAction =
  | { type: "switch"; roleId: string }
  | { type: "loaded"; roleId: string; packet: RelationPacket }
  | { type: "failed"; roleId: string; error: string }
  | { type: "view"; view: RelationUi["view"] }
  | { type: "diary"; index: number }
  | { type: "event"; eventId: string }
  | { type: "evidence"; evidenceId: string };

export function createRoleRequestGate(): RoleRequestGate;
export function initialRelationUi(roleId?: string): RelationUi;
export function reduceRelation(state: RelationUi, action: RelationAction): RelationUi;
export function visiblePacket(state: RelationUi): RelationPacket | null;
export function profileModel(state: RelationUi, listName?: string): { name: string; definition: string; lines: StateLine[]; loading: boolean; missing: boolean };
export function stateLines(state: Record<string, unknown> | null | undefined): StateLine[];
export function stateSentence(state: Record<string, unknown> | null | undefined): string;
export function splitDefinition(text: string): { quote: string; body: string };
export function diaryTitle(content: string, date: string): string;
export function diaryParagraphs(content: string): string[];
export function formatExperienceDate(value: string): string;
export function projectSearchItem(item: { id: string; type: string; title?: string; snippet?: string }): { id: string; type: string; title: string; snippet: string; date: string };
