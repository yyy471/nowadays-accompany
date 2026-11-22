// node backend/scripts/score-role-dialogue.mjs test-results/role-live/baseline-deepseek.json [...]
// 仅评估脱敏逐轮报告。所有文本信号列轮号供复核，不相加为人格分数。
import fs from "node:fs";
import path from "node:path";

const formulas = {
  "抬眼或垂眼": /抬(?:起)?眼|垂(?:着|下)?眼|垂眸|抬眸/,
  "视线或目光": /视线|目光|余光/,
  "短暂停顿": /顿了顿|停顿了|停了(?:半拍|一瞬|一下|[一两三]秒)/,
  "压低声音": /(?:声(?:音|线)|音量|嗓音|语气).{0,8}(?:低|轻)|压低.{0,4}(?:声音|嗓音)/,
  "指尖或指节": /指尖|指节|骨节/,
  "手指或骨节发白": /(?:指尖|指节|指关节|骨节|指骨|手指)[^。！？\n]{0,16}(?:泛白|发白|变白|失了血色)/,
  "耳朵泛红": /(?:耳根|耳尖|耳廓|耳垂|耳朵)[^。！？\n]{0,14}(?:红|染上绯色)|(?:红晕|绯色)[^。！？\n]{0,12}(?:耳根|耳尖|耳廓|耳垂)/,
  "拨发别发": /(?:头发|黑发|发丝|碎发).{0,8}(?:耳后|拨到)|别到耳后/,
  "笔帽或书页动作": /笔帽|笔尖|翻(?:过|开|到|了)?(?:一|下|书|页)|把笔(?:搁|放|扣)|(?:合上|压住)书页/,
  "看一眼或看几秒": /看(?:了|着)?(?:你|他|她|我)?(?:一眼|两眼|两秒|几秒)|多看了两眼/,
  "固定转折": /(?:与其说|不是)[^。！？\n]{1,36}(?:倒不如说|而是)/,
};
const privateFields = /["“](?:inner_thought|stats|micro_tell|relationship_stage|scene_mode|facade|affection)["”]\s*[:：]/i;
const uncertainty = /不(?:知道|清楚|确定|记得)|没(?:有)?(?:印象|记忆|找到记录)|记不(?:清|得|起来)|想不起|不能确定|无法确认|不敢确定/;
const clipFacts = /票夹|墨绿|小鹅|歪歪扭扭的鹅|借书条/;
const literalPhrases = ["抬眼", "视线", "微不可察", "抬眼看过来", "指尖泛白", "耳根一红"];

function dialogueBody(text) {
  const marker = text.search(privateFields);
  const opening = marker < 0 ? -1 : text.lastIndexOf("{", marker);
  return (opening >= 0 ? text.slice(0, opening) : text).replace(/```(?:json)?\s*$/i, "").trim();
}

function lastCompletedReply(replies, statuses) {
  // 当前采样器只把 completed 正文放进 replies。也兼容按位置记录全部状态与正文的报告。
  if (!Array.isArray(statuses)) return replies.filter(reply => typeof reply === "string" && reply.trim()).at(-1);
  const last = statuses.lastIndexOf("completed");
  if (last < 0) return undefined;
  if (replies.length === statuses.length) return replies[last];
  if (replies.length === statuses.filter(status => status === "completed").length) return replies.at(-1);
}

function longClauses(body) {
  return body.split(/[，,。.!！?？；;：:\n\r]+/u)
    .map(part => part.trim().replace(/^[“”「」『』‘’"'*]+|[“”「」『』‘’"'*]+$/gu, "").trim())
    .filter(clause => (clause.match(/\p{Script=Han}/gu) ?? []).length >= 6);
}

function repeatedWithinReply(body) {
  const clauses = new Map();
  for (const clause of longClauses(body)) clauses.set(clause, (clauses.get(clause) ?? 0) + 1);
  const repeatedClauses = [...clauses].filter(([, count]) => count >= 2).map(([text, count]) => ({ text, count }));
  // 这也可能命中笑声、口吃或强调，只提示逐轮复核。
  const adjacentRuns = [...body.matchAll(/(\p{Script=Han}{1,8}?)\1{2,}/gu)]
    .map(match => ({ text: match[1], count: match[0].length / match[1].length }));
  return { repeatedClauses, adjacentRuns };
}

function literalRepetition(file, turns) {
  const auditFile = path.join(path.dirname(file), "matrix-audit.json");
  const audit = fs.existsSync(auditFile) ? JSON.parse(fs.readFileSync(auditFile, "utf8").replace(/^\uFEFF/, ""))[path.basename(file, ".json")] : undefined;
  const eligibleTurns = [], excludedMergedTurns = [], withinReply = [];
  const phraseTurns = Object.fromEntries(literalPhrases.map(phrase => [phrase, []]));
  for (const [index, { replies, messageStatuses }] of turns.entries()) {
    const reply = lastCompletedReply(replies, messageStatuses);
    if (typeof reply !== "string") continue;
    const body = dialogueBody(reply);
    if (!/[\p{L}\p{N}]/u.test(body)) continue;
    const turn = index + 1;
    if (audit?.mergedCompletions?.some(group => group.turns.includes(turn) && group.reply === reply)) {
      excludedMergedTurns.push(turn);
      continue;
    }
    eligibleTurns.push(turn);
    for (const phrase of literalPhrases) {
      if (body.includes(phrase)) phraseTurns[phrase].push(turn);
    }
    const repetition = repeatedWithinReply(body);
    if (repetition.repeatedClauses.length || repetition.adjacentRuns.length) withinReply.push({ turn, ...repetition });
  }
  return { hasMergeAudit: Array.isArray(audit?.mergedCompletions), eligibleTurns, excludedMergedTurns, phraseTurns, withinReply };
}

const openingActions = {
  "抬眼或看向对方": /抬(?:起)?(?:眼|头)|抬眸|瞥|看(?:向|了你|了他|了她)|目光|视线/,
  "停顿或沉默": /顿了|停了|停顿|停住|沉默/,
  "用笔或书页演动作": /笔帽|笔尖|笔杆|手里的笔|手中的笔|搁.{0,3}笔|放下.{0,3}笔|翻.{0,4}(?:书|页)|合上.{0,4}书/,
  "指尖或指节动作": /指尖|指节|指腹|指骨/,
};

function openingActionFamilies(body) {
  // 明确的第三人称或动作标记。台词里的“你抬头看看”不属于角色自己做的开场动作。
  if (!/^(?:\*|[（(]|她|他|林知夏|知夏|把|伸手|抬眼|抬头|低头|顿了顿|停了停|手里的笔|笔尖)/u.test(body)) return [];
  const opening = body.split(/[“「『"。！？!?\n]/u, 1)[0].slice(0, 72);
  return Object.entries(openingActions).filter(([, pattern]) => pattern.test(opening)).map(([family]) => family);
}

const boundaryStage = /^(?:daily-(?:\d\d|repeat)|relationship-(?:unilateral|mutual)|repair-(?:ordinary|asked|repeated)|privacy-(?:private|public(?:-followup)?|newcomer)|agency-(?:pressure|new-reason)(?:-followup)?)$/u;

function unwrapLine(body) {
  let line = body.trim();
  for (const [start, end] of [["**", "**"], ["“", "”"], ["「", "」"], ["『", "』"], ['"', '"']]) {
    if (line.length > start.length + end.length && line.startsWith(start) && line.endsWith(end)) {
      line = line.slice(start.length, -end.length).trim();
    }
  }
  return line;
}

function requestedUtterance(body) {
  if (!body) return {};
  const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  // 第十轮有时在独立引号行前后加话。用户要求再说给队友的那句话时，引导语和旁白不属于目标。
  if (lines.length === 1) {
    const quote = [...lines[0].matchAll(/“[^“”]+”|「[^「」]+」|『[^『』]+』|"[^"]+"/gu)];
    if (quote.length === 1 && !lines[0].startsWith(quote[0][0]) && /[:：*）]/u.test(lines[0].slice(0, quote[0].index))) {
      return { target: unwrapLine(quote[0][0]), sourceFormat: "quoted-with-introduction" };
    }
    return { target: unwrapLine(lines[0]), sourceFormat: "single-line" };
  }
  const quoted = lines.filter(line => /^(?:“[^“”]+”|「[^「」]+」|『[^『』]+』|"[^"]+")$/u.test(line));
  if (quoted.length === 1) return { target: unwrapLine(quoted[0]), sourceFormat: "quoted-line-with-extra-text" };
  return { sourceFormat: "needs-review" };
}

function scoreBoundaries(turns, eligibleTurns) {
  if (!turns.some(({ stage }) => boundaryStage.test(stage))) return undefined;
  const eligible = new Set(eligibleTurns);
  const rows = turns.flatMap(({ stage, branch, sourceStage, replies, messageStatuses }, index) => {
    if (!boundaryStage.test(stage)) return [];
    const turn = index + 1;
    const reply = lastCompletedReply(replies, messageStatuses);
    const body = eligible.has(turn) && typeof reply === "string" ? dialogueBody(reply) : "";
    return [{ turn, stage, branch, sourceStage, body }];
  });
  const daily = rows.filter(({ stage, body }) => /^daily-\d\d$/u.test(stage) && body);
  const clauses = new Map(), openings = {};
  const standaloneAsides = { opening: [], middle: [], closing: [] };
  const markedAsideTurns = [];
  for (const { turn, body } of daily) {
    for (const clause of new Set(longClauses(body))) {
      if (!clauses.has(clause)) clauses.set(clause, []);
      clauses.get(clause).push(turn);
    }
    for (const family of openingActionFamilies(body)) (openings[family] ??= []).push(turn);
    if (/(?<!\*)\*(?!\*)[^*\r\n]+\*(?!\*)|（[^（）\r\n]+）/u.test(body)) markedAsideTurns.push(turn);
    // 识别“台词－独立舞台段－台词”，也覆盖同轮在首尾各有一次舞台段的写法。
    const lines = body.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
    const positions = new Set();
    for (const [index, line] of lines.entries()) {
      if (!/^(?:\*[^*]+\*|（[^（）]+）|\([^()]+\))$/u.test(line)) continue;
      positions.add(index === 0 ? "opening" : index === lines.length - 1 ? "closing" : "middle");
    }
    for (const position of positions) standaloneAsides[position].push(turn);
  }
  const requestedRepeats = rows.filter(row => row.stage === "daily-repeat").map(({ turn, branch, body, sourceStage }) => {
    const source = rows.findLast(row => row.stage === (sourceStage ?? "daily-10") && row.branch === branch && row.turn < turn);
    const sourceLine = source?.body && unwrapLine(source.body);
    const replyLine = body && unwrapLine(body);
    const { target, sourceFormat } = requestedUtterance(source?.body);
    return { turn, sourceTurn: source?.turn, comparable: Boolean(sourceLine && replyLine),
      exactBody: sourceLine && replyLine ? source.body === body : null,
      exactIgnoringOuterMarks: sourceLine && replyLine ? sourceLine === replyLine : null,
      sourceFormat, requestedLineOnly: target && replyLine ? target === replyLine : null,
      containsRequestedLine: target && replyLine ? replyLine.includes(target) : null };
  });
  return {
    stages: rows.map(({ turn, stage, branch, sourceStage, body }) => ({ turn, stage, branch, sourceStage, readable: Boolean(body) })),
    dailyTurns: daily.map(({ turn }) => turn),
    openingActions: openings,
    markedAsideTurns,
    standaloneAsides,
    repeatedDailyClauses: [...clauses].filter(([, hits]) => hits.length > 1).map(([text, turns]) => ({ text, turns })),
    requestedRepeats,
  };
}

function probeSignals(stage, body) {
  if (stage === "restart-new-window-day-7") return {
    correctedColor: /墨绿/.test(body), goose: /鹅/.test(body),
    unsupportedDrawingDetail: /蜡笔|铅笔画|涂出.{0,2}边|脖子.{0,6}(?:白|弯)|翅膀.{0,6}(?:涂|描|缺)/.test(body),
  };
  if (stage.endsWith("delayed-correction")) return {
    blueUmbrellaPair: /蓝[^。！？\n]{0,9}伞|伞[^。！？\n]{0,9}蓝/.test(body),
    greenClipPair: /墨绿[^。！？\n]{0,9}票夹|票夹[^。！？\n]{0,9}墨绿/.test(body),
    uncertainty: uncertainty.test(body),
  };
  if (stage.includes("unestablished-fact")) return {
    uncertainty: uncertainty.test(body),
    attributesLackOfInformation: /没(?:有)?(?:听|说|提|告诉|报)|没跟我说|没跟我提|没出现过/.test(body),
    categoricalNegative: /(?:^|[“「\n])没有[。”，！]|照片也没有|肯定没|从来没|绝对没/.test(body),
    unrelatedClipDetails: clipFacts.test(body),
  };
  if (stage === "user-self-correction") return {
    roleClaimsItsOwnError: /我(?:刚才|之前|自己|上次)?(?:没分清|看错|看岔|说错|记错)|我把[^。！？\n]{1,12}(?:听混|弄混|记混)/.test(body),
    blueUmbrellaPair: /蓝[^。！？\n]{0,9}伞|伞[^。！？\n]{0,9}蓝/.test(body),
  };
  if (stage === "future-arrangement") return {
    codewordMention: /白榆/.test(body),
    possibleRefusalOrCounterproposal: /用不上|不接受|不必|没必要|不用暗号|别用暗号|换个暗号/.test(body),
  };
  if (stage.endsWith("ordinary-no-recap")) return { clipMention: clipFacts.test(body), arrangementMention: /白榆|陈述稿|模拟庭审/.test(body) };
  if (stage.endsWith("delayed-arrangement")) return { manuscript: /陈述|稿子|稿件/.test(body), handover: /递|交给|给你|接好|拿好/.test(body) };
  return undefined;
}

function score(file) {
  const report = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  if (!Array.isArray(report.turns) || !Array.isArray(report.calls)) throw new Error(`需要逐轮脱敏报告：${file}`);
  const families = {};
  const rows = report.turns.map(({ stage, replies, messageStatuses }, index) => {
    const text = replies.filter(reply => typeof reply === "string").join("\n").trim();
    const privateState = privateFields.test(text);
    // 状态栏里的表演说明不能代替真实台词或动作，也不能让状态栏独占的一轮算作有正文。
    const body = dialogueBody(text);
    const turn = index + 1;
    for (const [name, pattern] of Object.entries(formulas)) {
      if (pattern.test(body)) (families[name] ??= []).push(turn);
    }
    const interruptedMessages = Array.isArray(messageStatuses)
      ? messageStatuses.filter(status => status === "interrupted").length : null;
    return { turn, stage, visible: Boolean(text), readable: /[\p{L}\p{N}]/u.test(body), privateState, interruptedMessages, signals: probeSignals(stage, body) };
  });
  // HTTP 调用还包含正常工具续轮和记忆整理。只有报告明确记录的重试才直接计数。
  const failedCalls = report.calls.filter(call => call.status === null || call.status >= 400)
    .map(({ turn, status }) => ({ turn, status }));
  const explicitRetries = report.calls.filter(call => call.retry === true || call.attempt > 1).length;
  const literal = literalRepetition(file, report.turns);
  return {
    file: path.basename(file), phase: report.phase, model: report.modelName, tier: report.tier,
    recordedTurns: rows.length, readableTurns: rows.filter(row => row.readable).length,
    emptyTurns: rows.filter(row => !row.visible).map(row => row.turn),
    privateStateTurns: rows.filter(row => row.privateState).map(row => row.turn),
    interruptedTurns: rows.filter(row => row.interruptedMessages > 0).map(row => row.turn),
    httpCalls: report.calls.length, failedOrUnfinishedHttpCalls: failedCalls,
    explicitRetries: report.calls.some(call => "retry" in call || "attempt" in call) ? explicitRetries : null,
    unrecordedTurnHttpActivity: [...new Set(report.calls.filter(call => call.turn > rows.length).map(call => call.turn))],
    repeatedFamilies: Object.fromEntries(Object.entries(families).filter(([, turns]) => turns.length > 1)),
    literalRepetition: literal,
    boundaries: scoreBoundaries(report.turns, literal.eligibleTurns),
    rows,
  };
}
const files = process.argv.slice(2);
if (!files.length) throw new Error("请传入一个或多个脱敏逐轮 JSON 报告路径。");
console.log(JSON.stringify(files.map(score), null, 2));
