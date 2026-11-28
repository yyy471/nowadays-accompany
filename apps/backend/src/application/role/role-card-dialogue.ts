type ScriptSection = "examples" | "opening";

function scriptSection(title: string): ScriptSection | undefined {
  const label = title.trim().replace(/^(?:\d+[.)、]\s*|第[一二三四五六七八九十\d]+[节章][：:、\s]*)/u, "");
  if (/^(?:(?:(?:不同|各)阶段的?|全周期|角色|示范)?(?:对话|说话)(?:示例|范例|样例)|示例对话|(?:example|sample) dialog(?:ue)?s?|dialog(?:ue)? examples?)(?:$|\s|[（(:：—-])/iu.test(label)) return "examples";
  if (/^(?:开场白|首条消息|first message|opening message)(?:$|\s|[（(:：—-])/iu.test(label)) return "opening";
  return undefined;
}

function requestedSections(userMessages: readonly string[]) {
  // 同批输入允许用户改主意，也可能否定一种材料、转而要求另一种。
  const clauses = userMessages.flatMap(message => message.split(/[，,。.!！?？;；\n]|但是|不过|而是|\b(?:but|instead)\b/iu));
  const negated = /(?:不要|不用|不想|不必|不需要|无需|不|别|没(?:要求|让)|不是(?:要|让)|\b(?:do not|don't|don’t|never)\b)(?:你|再|来|去|把|拿|直接|每次|一直|总是|刻意|刻意地|逐字|照着|按照|给我|帮我|\s)*$/iu;
  function requested(pattern: RegExp): boolean {
    let active = false;
    for (const clause of clauses) {
      const match = pattern.exec(clause);
      if (match) active = !negated.test(clause.slice(0, match.index));
    }
    return active;
  }
  const readCard = requested(/(?:查看|看看|读出|展示|列出|复述|给我看|告诉我|介绍|解释).{0,16}(?:角色卡|人物卡|角色设定|人物设定)|(?:角色卡|人物卡|角色设定|人物设定).{0,12}(?:全文|原文|写了什么|是什么|有哪些)|(?:show|read|quote|explain).{0,24}(?:character card|character definition)/iu);
  const readExamples = requested(/(?:看看|查看|只要|想看|读|展示|给|举|演|按|引用|复述|有哪些|什么).{0,14}(?:(?:对话|说话)(?:示例|范例|样例)|示例对话)|(?:(?:对话|说话)(?:示例|范例|样例)|示例对话).{0,8}(?:原文|有哪些|是什么)|(?:show|give|read|quote).{0,20}(?:example|sample) dialog/iu);
  const readOpening = requested(/(?:按|来|用|读|从|给|开始|展示|重演|说|写|想看).{0,12}开场|开场白.{0,8}(?:原文|是什么|开始)|(?:show|use|start|read).{0,20}(?:opening|first message)/iu);
  return { readCard, readExamples, readOpening };
}

/** 只识别角色卡顶层与 V2/V3 data 的明确字段，保留扩展对象的原意。 */
export function roleCardPayloadForDialogue(payload: Record<string, unknown>, userMessages: readonly string[], preserveExamples = false): Record<string, unknown> {
  const { readCard, readExamples, readOpening } = requestedSections(userMessages);
  const project = (fields: Record<string, unknown>) => {
    const selected = { ...fields };
    delete selected.character_book;
    if (!preserveExamples && !readCard && typeof selected.description === "string") {
      selected.description = roleCardForDialogue(selected.description, userMessages);
    }
    if (!preserveExamples && !readCard && !readOpening) delete selected.first_mes;
    if (!preserveExamples && !readCard && !readExamples) delete selected.mes_example;
    return selected;
  };
  const result = project(payload);
  if (payload.data !== null && typeof payload.data === "object" && !Array.isArray(payload.data)) {
    result.data = project(payload.data as Record<string, unknown>);
  }
  return result;
}

/** 运行时投影，存储与角色配置接口始终保留原卡。 */
export function roleCardForDialogue(card: string, userMessages: readonly string[]): string {
  const { readCard, readExamples, readOpening } = requestedSections(userMessages);
  if (readCard) return card;
  const lines = card.split(/\r?\n/u);
  const kept: string[] = [];
  const samples: string[] = [];
  const unattributed: string[] = [];
  let sampleProse = "";
  let skipped: { level: number; kind: ScriptSection } | undefined;
  let fence = "";
  let omitted = false;
  let hasDescription = false;
  for (let i = 0; i < lines.length; i++) {
    const row = lines[i]!;
    // 旧引擎要求在公开台词后附机器面板。仅略去明确给引擎/UI 的附加指令及紧跟的 JSON 模板。
    // 保留数值与性格说明、普通用户要求的 JSON、示例内的引文和明确读取的原卡。
    if (!fence && !skipped && /(?:每次|每轮|每条).{0,24}(?:回复|回答|发言).{0,28}(?:附带|附上|追加|附加)/u.test(row) &&
        !/不(?:要|须|需|用|应|得|能)|禁止|切勿/u.test(row) &&
        /JSON/iu.test(row) && /状态栏|状态面板|status bar/iu.test(row) &&
        /(?:用于|供|交给|由).{0,20}(?:引擎|UI|界面).{0,16}(?:解析|渲染|读取)/iu.test(row)) {
      let start = i + 1;
      while (start < lines.length && !lines[start]!.trim()) start++;
      const opening = /^ {0,3}(`{3,}|~{3,})\s*json\s*$/iu.exec(lines[start] ?? "");
      if (opening) {
        let end = start + 1;
        while (end < lines.length && !(lines[end]!.trim().startsWith(opening[1]!) &&
            [...lines[end]!.trim()].every(char => char === opening[1]![0]))) end++;
        if (end < lines.length) {
          i = end;
          omitted = true;
          continue;
        }
      }
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(row);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = "";
      if (!skipped) kept.push(row);
      continue;
    }
    const heading = fence ? null : /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(row);
    // 非 Markdown 标题只略去直接跟随的显式说话人行，后续自由段落的边界无法可靠推断。
    if (!fence && !skipped && !readExamples && /^\s*(?:对话示例|示例对话|Example Dialogues)\s*[:：]\s*$/iu.test(row)) {
      let end = i + 1;
      while (end < lines.length && /^\s*(?:\{\{(?:user|char)\}\}|用户|角色|user|assistant|character)\s*[:：]/iu.test(lines[end]!)) end++;
      if (end > i + 1) {
        omitted = true;
        for (const line of lines.slice(i + 1, end)) {
          const speech = /^\s*(?:\{\{char\}\}|角色|assistant|character)\s*[:：]\s*(.+)$/iu.exec(line);
          if (speech && samples.length < 2) samples.push(Array.from(speech[1]!).slice(0, 100).join(""));
        }
        i = end - 1;
        continue;
      }
    }
    const underline = !heading && !fence && /^ {0,3}[^\s]/u.test(row)
      ? /^ {0,3}(=+|-+)[ \t]*$/u.exec(lines[i + 1] ?? "") : null;
    const level = heading?.[1]?.length ?? (underline ? (underline[1]!.startsWith("=") ? 1 : 2) : 0);
    if (level) {
      if (skipped && level <= skipped.level) skipped = undefined;
      const section = scriptSection(heading?.[2] ?? row);
      if (!skipped && section && !(section === "examples" ? readExamples : readOpening)) {
        skipped = { level, kind: section };
        omitted = true;
      }
    }
    if (!skipped) {
      kept.push(row);
      if (!level && !fence && /[\p{L}\p{N}]/u.test(row)) hasDescription = true;
    } else if (!fence && !level && skipped.kind === "examples" && samples.length < 2) {
      const speech = /^(?:\{\{char\}\}|角色|assistant|character)[：:]\s*(.+)$/iu.exec(row.trim());
      if (speech) samples.push(Array.from(speech[1]!).slice(0, 100).join(""));
      else if (unattributed.length < 2 && /^[“「『"]/u.test(row.trim())) {
        unattributed.push(Array.from(row.trim()).slice(0, 100).join(""));
      } else if (!sampleProse && /[\p{L}]/u.test(row) &&
          !/^(?:\{\{user\}\}|用户|对方|玩家|user)\s*[:：]/iu.test(row.trim())) {
        sampleProse = Array.from(row.trim()).slice(0, 100).join("");
      }
    }
    if (underline) {
      i++;
      if (!skipped) kept.push(lines[i]!);
    }
  }
  if (!omitted) return card;
  // 仅有示例的角色卡也保留少量角色口吻，避免把整段用户与角色的往来带入当前窗口。
  const voice = samples.length ? samples : unattributed.length ? unattributed : sampleProse ? [sampleProse] : [];
  if (!hasDescription && voice.length) kept.push("口吻片段（只示范表达，非当前经历）：", ...voice);
  return kept.join("\n").trim();
}

export interface SplitRoleCardResult {
  /** 长期稳定核心设定正文（不含按需展开的开场白/示例对话，不做 2000 字符截断）。 */
  coreText: string;
  /** 去重且键序确定的核心结构化载荷 JSON（为空时为 null）。 */
  corePayloadJson: string | null;
  /** 仅在用户当轮显式要求查看原卡/开场白/示例对话时返回的临时参考（放入本轮可变材料，不污染稳定前缀）。 */
  onDemandReference: string | null;
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`).join(",")}}`;
}

function deduplicatePayloadFields(
  fields: Record<string, unknown>,
  seenTexts: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key === "description" && typeof value === "string") {
      const normalized = value.trim();
      if (normalized.length === 0 || seenTexts.has(normalized)) {
        continue;
      }
      seenTexts.add(normalized);
    }
    if (key === "data" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      const nested = deduplicatePayloadFields(value as Record<string, unknown>, seenTexts);
      if (Object.keys(nested).length > 0) {
        out.data = nested;
      }
      continue;
    }
    out[key] = value;
  }
  return out;
}

function extractOmittedScriptSections(
  card: string,
  wanted: { readExamples: boolean; readOpening: boolean },
): string {
  const lines = card.split(/\r?\n/u);
  const collected: string[] = [];
  let active: { level: number; kind: ScriptSection } | undefined;
  let fence = "";
  for (let i = 0; i < lines.length; i += 1) {
    const row = lines[i]!;
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(row);
    if (marker) {
      if (!fence) fence = marker[1]!;
      else if (marker[1]!.startsWith(fence) && !marker[2]!.trim()) fence = "";
      if (active) collected.push(row);
      continue;
    }
    const heading = fence ? null : /^ {0,3}(#{1,6})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/u.exec(row);
    if (!fence && !active && wanted.readExamples && /^\s*(?:对话示例|示例对话|Example Dialogues)\s*[:：]\s*$/iu.test(row)) {
      let end = i + 1;
      while (end < lines.length && /^\s*(?:\{\{(?:user|char)\}\}|用户|角色|user|assistant|character)\s*[:：]/iu.test(lines[end]!)) end += 1;
      if (end > i + 1) {
        collected.push(...lines.slice(i, end));
        i = end - 1;
        continue;
      }
    }
    const underline = !heading && !fence && /^ {0,3}[^\s]/u.test(row)
      ? /^ {0,3}(=+|-+)[ \t]*$/u.exec(lines[i + 1] ?? "")
      : null;
    const level = heading?.[1]?.length ?? (underline ? (underline[1]!.startsWith("=") ? 1 : 2) : 0);
    if (level) {
      if (active && level <= active.level) active = undefined;
      const section = scriptSection(heading?.[2] ?? row);
      if (!active && section && (section === "examples" ? wanted.readExamples : wanted.readOpening)) {
        active = { level, kind: section };
      }
    }
    if (active) {
      collected.push(row);
      if (underline) {
        i += 1;
        collected.push(lines[i]!);
      }
    } else if (underline) {
      i += 1;
    }
  }
  return collected.join("\n").trim();
}

/**
 * DL-202 角色卡拆分：
 * - 长期稳定前缀固定承载完整核心设定与去重后的结构化核心字段，绝不随当轮问话变化；
 * - 当轮用户显式索要查看开场白、示例对话或完整原卡时，按需提取为临时参考放入本轮可变材料。
 */
export function splitRoleCardForDialogue(
  definitionText: string,
  definitionPayload: Record<string, unknown>,
  userMessages: readonly string[],
  adminSeat: boolean,
): SplitRoleCardResult {
  const coreText = adminSeat
    ? definitionText
    : roleCardForDialogue(definitionText, []);
  const rawCorePayload = roleCardPayloadForDialogue(
    definitionPayload,
    [],
    adminSeat,
  );
  const seenTexts = new Set<string>();
  const trimmedCore = coreText.trim();
  const trimmedRaw = definitionText.trim();
  if (trimmedCore.length > 0) seenTexts.add(trimmedCore);
  if (trimmedRaw.length > 0) seenTexts.add(trimmedRaw);
  const dedupedPayload = deduplicatePayloadFields(rawCorePayload, seenTexts);
  const corePayloadJson =
    Object.keys(dedupedPayload).length > 0
      ? stableJsonStringify(dedupedPayload)
      : null;

  if (adminSeat || userMessages.length === 0) {
    return { coreText, corePayloadJson, onDemandReference: null };
  }

  const { readCard, readExamples, readOpening } = requestedSections(userMessages);
  if (!readCard && !readExamples && !readOpening) {
    return { coreText, corePayloadJson, onDemandReference: null };
  }

  const extras: string[] = [];
  if (readCard) {
    if (definitionText !== coreText) {
      extras.push(`角色卡完整原文（按本轮用户要求临时提供）：\n${definitionText}`);
    }
    const fullPayload = roleCardPayloadForDialogue(definitionPayload, userMessages, false);
    const fullPayloadJson =
      Object.keys(fullPayload).length > 0 ? stableJsonStringify(fullPayload) : null;
    if (fullPayloadJson !== null && fullPayloadJson !== corePayloadJson) {
      extras.push(`角色卡完整结构化字段（按本轮用户要求临时提供）：${fullPayloadJson}`);
    }
  } else {
    const omittedText = extractOmittedScriptSections(definitionText, {
      readExamples,
      readOpening,
    });
    if (omittedText.length > 0) {
      extras.push(`角色卡按需片段（仅本轮参考，非已发生经历）：\n${omittedText}`);
    }
    const onDemandPayload: Record<string, unknown> = {};
    const collectField = (source: Record<string, unknown>, key: "first_mes" | "mes_example") => {
      if (typeof source[key] === "string" && source[key]!.trim().length > 0) {
        onDemandPayload[key] = source[key];
      }
    };
    const dataField =
      definitionPayload.data !== null &&
      typeof definitionPayload.data === "object" &&
      !Array.isArray(definitionPayload.data)
        ? (definitionPayload.data as Record<string, unknown>)
        : null;
    if (readOpening) {
      collectField(definitionPayload, "first_mes");
      if (dataField && onDemandPayload.first_mes === undefined) collectField(dataField, "first_mes");
    }
    if (readExamples) {
      collectField(definitionPayload, "mes_example");
      if (dataField && onDemandPayload.mes_example === undefined) collectField(dataField, "mes_example");
    }
    if (Object.keys(onDemandPayload).length > 0) {
      extras.push(`角色卡按需结构化字段（仅本轮参考）：${stableJsonStringify(onDemandPayload)}`);
    }
  }

  return {
    coreText,
    corePayloadJson,
    onDemandReference: extras.length > 0 ? extras.join("\n") : null,
  };
}
