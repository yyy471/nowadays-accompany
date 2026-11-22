const wordSegmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
// 口语问句里的时间、指代与寒暄独立命中时，通常不能定位到某件经历。
const queryFillers = new Set(
  "今天 明天 昨天 那天 当时 最近 后来 之前 以前 上次 这次 时候 我们 你们 他们 那个 这个 那些 这些 一下 一起 已经 是不是 有没有 还有 没有 怎么 怎样 什么 哪里 为什么 知道 记得 记不记得 我想 你有 你好 您好 哈喽 早安 晚安 谢谢 哈哈 你好呀 提过 说过".split(" "),
);

export function memoryQueryTokens(query: string, mode: "auto" | "agent" | "manual"): string[] {
  const tokens = new Set<string>();
  for (const clause of query.toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []) {
    if (mode === "auto" && queryFillers.has(clause)) continue;
    if (!/\p{Script=Han}/u.test(clause) || clause.length <= 3) {
      tokens.add(clause);
      continue;
    }
    const words = Array.from(wordSegmenter.segment(clause))
      .filter((word) => word.isWordLike && word.segment.length >= 2 && !queryFillers.has(word.segment))
      .map((word) => word.segment);
    // 保留整段作精确匹配；长问句还可用其中的专名和事物找到不同措辞的原文。
    tokens.add(clause);
    for (const word of words) tokens.add(word);
  }
  return [...tokens];
}
