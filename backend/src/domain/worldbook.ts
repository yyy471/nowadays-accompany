import { z } from "zod";
import { createHash } from "node:crypto";

const text = (limit: number) => z.string().trim().min(1).max(limit);
const entrySchema = z.object({
  id: text(96),
  title: text(80),
  keywords: z.array(text(64)).min(1).max(16),
  content: text(1800),
  enabled: z.boolean(),
  visibility: z.enum(["known", "author_only"]),
}).strict();
const bookSchema = z.object({
  id: text(96),
  name: text(80),
  enabled: z.boolean(),
  entries: z.array(entrySchema).max(64),
}).strict().refine(book => new Set(book.entries.map(entry => entry.id)).size === book.entries.length,
  { message: "同一本世界书内的条目 ID 须唯一" });

export const worldbooksSchema = z.array(bookSchema).max(16).refine(
  books => new Set(books.map(book => book.id)).size === books.length,
  { message: "世界书 ID 须唯一" },
);
export const putWorldbooksSchema = z.object({
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  books: worldbooksSchema,
}).strict();
export type Worldbook = z.infer<typeof bookSchema>;
export interface WorldbookSnapshot { revision: number; books: Worldbook[] }
export interface WorldbookMatch {
  revision: number;
  bookId: string;
  entryId: string;
  title: string;
  content: string;
  messageIds: string[];
}
export type WorldbookSelection = Omit<WorldbookMatch, "content" | "title"> & {
  status: "included" | "budget_omitted";
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** 兼容卡片内嵌的字符书。缺少角色知情标记的材料先保存在作者区，原卡完整保留。 */
export function embeddedWorldbook(value: unknown): Worldbook | undefined {
  const source = asRecord(value);
  if (!source || !Array.isArray(source.entries)) return undefined;
  const entries: Worldbook["entries"] = [];
  const seen = new Set<string>();
  for (const item of source.entries) {
    if (entries.length >= 64) break;
    const entry = asRecord(item);
    if (!entry || !Array.isArray(entry.keys)) continue;
    const identity = typeof entry.id === "string" || Number.isSafeInteger(entry.id)
      ? JSON.stringify(["id", entry.id]) : JSON.stringify(["keys", entry.name, entry.keys]);
    const id = "card-entry-" + createHash("sha256").update(identity).digest("hex").slice(0, 24);
    const candidate = entrySchema.safeParse({
      id,
      title: entry.name || entry.keys[0],
      content: entry.content, keywords: entry.keys,
      enabled: entry.enabled !== false && entry.selective !== true && entry.use_regex !== true && entry.constant !== true,
      visibility: entry.visibility === "known" ? "known" : "author_only",
    });
    if (candidate.success) {
      let uniqueId = id;
      for (let suffix = 2; seen.has(uniqueId); suffix++) uniqueId = `${id}-${suffix}`;
      seen.add(uniqueId);
      entries.push({ ...candidate.data, id: uniqueId });
    }
  }
  if (!entries.length) return undefined;
  const name = text(80).safeParse(source.name);
  return { id: "card-worldbook", name: name.success ? name.data : "角色卡世界书", enabled: true, entries };
}

const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
const asciiWord = (value: string | undefined) => value !== undefined && /^[a-z0-9_]$/.test(value);

function containsKeyword(value: string, keyword: string): boolean {
  let offset = value.indexOf(keyword);
  while (offset >= 0) {
    const end = offset + keyword.length;
    if (!(asciiWord(keyword[0]) && asciiWord(value[offset - 1])) &&
        !(asciiWord(keyword.at(-1)) && asciiWord(value[end]))) return true;
    offset = value.indexOf(keyword, offset + 1);
  }
  return false;
}

/** 仅本次真实输入或正在执行的目标能触发设定。过去的回复和条目正文均不参与递归匹配。 */
export function matchWorldbooks(snapshot: WorldbookSnapshot, sources: { id?: string; text: string }[]): WorldbookMatch[] {
  const inputs = sources.filter(source => source.text).map(source => ({ ...source, text: normalize(source.text) }));
  const matches: { match: WorldbookMatch; specificity: number }[] = [];
  for (const book of snapshot.books) {
    if (!book.enabled) continue;
    for (const entry of book.entries) {
      if (!entry.enabled || entry.visibility !== "known") continue;
      let specificity = 0;
      const messageIds = new Set<string>();
      for (const keyword of new Set(entry.keywords.map(normalize))) {
        for (const source of inputs) {
          if (!containsKeyword(source.text, keyword)) continue;
          specificity = Math.max(specificity, keyword.length);
          if (source.id !== undefined) messageIds.add(source.id);
        }
      }
      if (specificity > 0) matches.push({ specificity, match: {
        revision: snapshot.revision, bookId: book.id, entryId: entry.id, title: entry.title,
        content: entry.content, messageIds: [...messageIds],
      } });
    }
  }
  return matches.sort((a, b) => b.specificity - a.specificity).map(item => item.match);
}
