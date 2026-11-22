import { createHash } from "node:crypto";

// 在传给 fetch 的协议正文上取证，仅返回哈希、日期和是否命中的布尔值。
// 不读取推理块、工具参数、工具结果正文、图片、URL 或请求头。
export function inspectRepairWire(body, protocol, fixture, currentInput, expectedToday) {
  const units = [];
  let system = "";
  const textOf = parts => {
    if (typeof parts === "string") return parts;
    return (parts ?? []).filter(p => !p.thought && (p.type === "text" || !p.type) && typeof p.text === "string").map(p => p.text).join("\n");
  };
  if (protocol === "openai-chat") {
    for (const m of body.messages ?? []) {
      if (m.role === "system" || m.role === "developer") { system += "\n" + textOf(m.content); continue; }
      if (m.role === "tool") { units.push({ tool: true }); continue; }
      if (m.role !== "user" && m.role !== "assistant") continue;
      const text = textOf(m.content);
      // DeepSeek 兼容历史：没有对应推理块的角色原话作为署名引文放在 native user 消息。
      const envelope = m.role === "user" && /^\[(角色先前的回复|用户先前的发言|本轮用户消息)\]\n/u.exec(text);
      let quote;
      if (envelope) {
        try { quote = JSON.parse(text.slice(envelope[0].length)); } catch { /* 普通文本保持原角色 */ }
      }
      const attributed = envelope && quote?.sender === (envelope[1] === "角色先前的回复" ? "assistant" : "user") && typeof quote.text === "string";
      units.push(attributed ? { role: quote.sender, nativeRole: m.role, envelope: envelope[1], text: quote.text } : { role: m.role, nativeRole: m.role, text });
      if (m.role === "assistant" && m.tool_calls?.length) units.push({ tool: true });
    }
  } else if (protocol === "google-gemini") {
    system = textOf(body.systemInstruction?.parts);
    for (const m of body.contents ?? []) {
      if (m.role !== "user" && m.role !== "model") continue;
      for (const p of m.parts ?? []) {
        if (p.functionCall || p.functionResponse) units.push({ tool: true });
        else if (!p.thought && typeof p.text === "string") units.push({ role: m.role === "model" ? "assistant" : "user", nativeRole: m.role, text: p.text });
      }
    }
  } else return undefined;
  const datePattern = /^\[消息发送日 (\d{4}-\d{2}-\d{2})(?:，本轮当地日期 \d{4}-\d{2}-\d{2})?\]\n/u;
  const sentDay = new Date(Date.parse(fixture.sentAt) + 8 * 3600000).toISOString().slice(0, 10);
  const original = role => {
    const text = fixture[role];
    const matches = units.filter(unit => unit.role === role && unit.text.replace(datePattern, "") === text);
    const dates = [...new Set(matches.flatMap(m => datePattern.exec(m.text)?.[1] ?? []))];
    return { sha256: createHash("sha256").update(text).digest("hex"), exactText: matches.length > 0, sentDates: dates, expectedSentDatePresent: dates.includes(sentDay),
      wireNativeRoles: [...new Set(matches.map(m => m.nativeRole))], attributedByEnvelope: matches.some(m => Boolean(m.envelope)), attributedRole: role };
  };
  const probeIndex = units.findLastIndex(m => m.role === "user" && m.text.replace(datePattern, "") === currentInput);
  const dates = [...new Set([...system.matchAll(/本轮当地日期 (\d{4}-\d{2}-\d{2})/gu)].map(m => m[1]))];
  return {
    probeQuestionPresent: probeIndex >= 0,
    isToolContinuation: probeIndex >= 0 && units.slice(probeIndex + 1).some(u => u.tool === true),
    expectedSentDate: sentDay, expectedToday, systemDates: dates, expectedTodayInSystem: dates.includes(expectedToday),
    memoryBriefHeadingPresent: system.includes("自动召回的相关长期记忆概况"),
    memoryNoMatchNotice: system.includes("本轮自动召回没有命中相关概况"),
    memoryFailureNotice: system.includes("自动召回本轮失败"),
    user: original("user"), assistant: original("assistant"),
  };
}
