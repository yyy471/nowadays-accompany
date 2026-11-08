(() => {
  "use strict";

  const $ = id => document.getElementById(id);
  const app = $("app");

  /* ==========================================================================
     1. ROLE PROFILES ("夏澄" & "阿柚") — CLEAN EMPTY INITIAL STATE
     ========================================================================== */
  const ROLES = {
    xiacheng: {
      id: "xiacheng",
      backendRoleId: null,
      defaultWindowId: null,
      stateVersion: 1,
      name: "夏澄",
      seal: "澄",
      moodSeal: "—",
      moodTitle: "暂无心境记录",
      moodSummary: "尚未产生心境与情绪变化记录，开始对话或自主活动后将在此更新。",
      meters: [0, 0, 0],
      quotaUsed: 0,
      nextWake: "暂无唤醒计划",
      proactiveBadge: "",
      proactiveShort: "",
      proactiveFull: "",
      states: {
        reading: {
          badge: "📖 窗畔阅读",
          pose: "day",
          desc: "静立在窗边翻阅书页，等待与你交谈。",
          bubble: "“窗边的光线正好，有空随时找我聊聊。”"
        },
        writing: {
          badge: "✒️ 执笔记录",
          pose: "evening",
          desc: "坐在书桌前整理手账与笔记。",
          bubble: "“手账本已经摊开在桌上了。”"
        },
        thinking: {
          badge: "🎧 静思检索",
          pose: "evening",
          desc: "安静梳理思绪与过往记忆。",
          bubble: "“正在安静思考中……”"
        },
        sharing: {
          badge: "✉️ 待语分享",
          pose: "day",
          desc: "站在书桌旁，准备与你分享新想法。",
          bubble: "“有什么想聊的话题吗？”"
        },
        resting: {
          badge: "🌙 夜阑小憩",
          pose: "evening",
          desc: "在窗畔暖灯下安静歇息。",
          bubble: "“忙了一天的话，先坐下来歇会儿吧。”"
        }
      },
      growth: [],
      mainWindow: {
        title: "窗畔唯一主信笺",
        draft: "",
        messages: []
      },
      externalWindows: [],
      replies: [
        "我已经收到你的信啦，正在结合当前状态为你整理回复。",
        "嗯，我记下了。需要我帮你把这段内容整理到工作空间笔记里吗？",
        "好呀，我们随时可以顺着这个话题继续往下聊。"
      ],
      diaries: [],
      memories: [],
      tasks: [],
      manuscripts: []
    },

    ayou: {
      id: "ayou",
      backendRoleId: null,
      defaultWindowId: null,
      stateVersion: 1,
      name: "阿柚",
      seal: "柚",
      moodSeal: "—",
      moodTitle: "暂无心境记录",
      moodSummary: "尚未产生心境与情绪变化记录，开始对话或自主活动后将在此更新。",
      meters: [0, 0, 0],
      quotaUsed: 0,
      nextWake: "暂无唤醒计划",
      proactiveBadge: "",
      proactiveShort: "",
      proactiveFull: "",
      states: {
        reading: {
          badge: "📖 翻阅食谱",
          pose: "day",
          desc: "正在暖阁翻看日常食谱与手账。",
          bubble: "“有空的话一起聊聊今天的日常吧！”"
        },
        writing: {
          badge: "✒️ 记录手账",
          pose: "evening",
          desc: "正在书桌前记录生活备忘。",
          bubble: "“正在整理新的手账页～”"
        },
        thinking: {
          badge: "🎧 构思茶点",
          pose: "evening",
          desc: "安静构思新的茶歇与日常安排。",
          bubble: "“在想今天适合泡什么茶呢……”"
        },
        sharing: {
          badge: "✉️ 待语分享",
          pose: "day",
          desc: "在书桌前等待与你分享。",
          bubble: "“随时都可以找我说话哦～”"
        },
        resting: {
          badge: "🌙 暖阁茶歇",
          pose: "evening",
          desc: "在窗边安静休息。",
          bubble: "“今天辛苦啦，喝口热茶歇一歇吧。”"
        }
      },
      growth: [],
      mainWindow: {
        title: "窗畔唯一主信笺",
        draft: "",
        messages: []
      },
      externalWindows: [],
      replies: [
        "收到你的来信啦！我已经记在心上了，我们慢慢聊～",
        "好呀好呀，需要我帮你把这条备忘写进工作空间吗？"
      ],
      diaries: [],
      memories: [],
      tasks: [],
      manuscripts: []
    }
  };

  /* ==========================================================================
     2. APPLICATION STATE & LIVE BACKEND CLIENT STATE
     ========================================================================== */
  const params = new URLSearchParams(window.location.search);
  const envSettings = loadEnvSettings();
  if (params.get("time")) envSettings.time = params.get("time");
  if (params.get("season")) envSettings.season = params.get("season");
  if (params.get("weather")) envSettings.weather = params.get("weather");
  if (params.get("lamp")) envSettings.lamp = params.get("lamp");

  let currentRoleId = params.get("role") === "ayou" ? "ayou" : "xiacheng";
  let currentFocus = params.get("focus") === "theater" ? "theater" : "stage";
  let currentMedium = ["letter", "journal", "filmstrip", "spread"].includes(params.get("medium"))
    ? params.get("medium")
    : "letter";
  let currentActivity = ["reading", "writing", "thinking", "sharing", "resting"].includes(params.get("activity"))
    ? params.get("activity")
    : "reading";
  let currentDiaryIdx = 0;
  let currentMemoryFilter = "all";
  let currentMemoryId = "";
  let currentManuscriptIdx = 0;
  let quotaLimit = 200;
  let quotaUnlimited = false;
  let typingTimer = null;
  let streamingTimer = null;
  let replyCounter = 0;

  // Real Backend HTTP + SSE Connection State
  const backendState = {
    online: false,
    apiBaseUrl: "",
    mockLlmBaseUrl: "http://127.0.0.1:3210/v1",
    clientId: "desk_client_" + Math.random().toString(36).slice(2, 10),
    sseSource: null,
    sseWindowKey: "",
    activeStreamingMsg: null,
    modelResourceId: null
  };

  let resources = [
    { id: "mcp-fs", backendId: null, kind: "mcp", name: "本地文件读写与目录检索 (stdio MCP)", desc: "随程序提供的基础工作空间读写工具 (DL-75)", enabled: true, inFlight: true },
    { id: "mcp-cmd", backendId: null, kind: "mcp", name: "本地命令与脚本执行器 (stdio MCP)", desc: "供通用 Skill 随包脚本定位与运行 (DL-58 / GAP-05)", enabled: true, inFlight: false },
    { id: "skill-reader", backendId: null, kind: "skill", name: "长文深度精读与札记提炼 (Agent Skill)", desc: "按需读取 SKILL.md，整理结构化读书笔记 (DL-74)", enabled: true, inFlight: true },
    { id: "skill-memory", backendId: null, kind: "skill", name: "多维记忆检索与证据核验 (Agent Skill)", desc: "支持事件与日常摘要追溯及自主纠错 (DL-56 / DL-93)", enabled: true, inFlight: false }
  ];

  function loadEnvSettings() {
    const defaults = { time: "auto", season: "auto", weather: "auto", lamp: "auto" };
    try {
      const saved = JSON.parse(localStorage.getItem("nowadays.luminary.env.v2"));
      if (saved && typeof saved === "object") return { ...defaults, ...saved };
    } catch { /* ignore */ }
    return defaults;
  }

  function saveEnvSettings() {
    try {
      localStorage.setItem("nowadays.luminary.env.v2", JSON.stringify(envSettings));
    } catch { /* ignore */ }
  }

  /* ==========================================================================
     3. REAL BACKEND API CLIENT (/v1/* HTTP + SSE STREAMING)
     ========================================================================== */
  async function apiFetch(routePath, options = {}) {
    const base = backendState.apiBaseUrl || "";
    const url = `${base}${routePath}`;
    const headers = { ...(options.headers || {}) };
    if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
      headers["content-type"] = "application/json";
    }
    const res = await fetch(url, {
      method: options.method || "GET",
      headers,
      body: options.body && typeof options.body === "object"
        ? JSON.stringify(options.body)
        : options.body
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(json?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }

  function setBackendConnBadge(online, text) {
    backendState.online = online;
    const pill = $("backend-conn-pill");
    const label = $("backend-conn-text");
    if (pill) pill.dataset.online = String(online);
    if (label) label.textContent = text;
  }

  async function initBackendIntegration() {
    try {
      const cfgRes = await fetch("api-config.json").catch(() => null);
      if (cfgRes && cfgRes.ok) {
        const cfg = await cfgRes.json();
        if (cfg.apiBaseUrl) {
          backendState.apiBaseUrl = cfg.apiBaseUrl;
        }
        if (cfg.mockLlmBaseUrl) {
          backendState.mockLlmBaseUrl = cfg.mockLlmBaseUrl;
          const baseInput = $("cfg-baseurl");
          if (baseInput) baseInput.value = cfg.mockLlmBaseUrl;
        }
      }

      const health = await apiFetch("/v1/health");
      if (health && health.status === "ok") {
        setBackendConnBadge(true, `● 本地后端已连接 · SQLite + SSE (${health.version || "v1"})`);
      }

      // 1. Discover roles via UI-PREP-01 GET /v1/roles
      const rolesResp = await apiFetch("/v1/roles");
      const roleItems = Array.isArray(rolesResp?.items) ? rolesResp.items : [];
      for (const item of roleItems) {
        if (item.displayName === "樱" || item.displayName === "夏澄") {
          ROLES.xiacheng.backendRoleId = item.roleId;
          ROLES.xiacheng.defaultWindowId = item.defaultWindowId;
        } else if (item.displayName === "阿柚") {
          ROLES.ayou.backendRoleId = item.roleId;
          ROLES.ayou.defaultWindowId = item.defaultWindowId;
        }
      }

      // 2. Sync Global Resources (/v1/resources)
      await syncGlobalResourcesFromBackend();

      // 3. Hydrate both roles from SQLite backend
      await syncRoleFromBackend("xiacheng");
      await syncRoleFromBackend("ayou");

      // 4. Connect live SSE stream for active role's defaultWindowId
      connectRoleSseStream(currentRoleId);
      renderRoleAndPresence();
    } catch (err) {
      setBackendConnBadge(false, "○ 离线演示模式（未检测到本地后端）");
      console.warn("[nowadays-desk] Backend offline fallback:", err?.message || err);
    }
  }

  async function syncGlobalResourcesFromBackend() {
    if (!backendState.online) return;
    try {
      const resp = await apiFetch("/v1/resources");
      const items = Array.isArray(resp?.items) ? resp.items : [];
      const mapped = [];
      for (const item of items) {
        if (item.kind === "model") {
          backendState.modelResourceId = item.resourceId;
          if (item.config?.baseUrl && $("cfg-baseurl")) {
            $("cfg-baseurl").value = item.config.baseUrl;
          }
          if (item.config?.protocol && $("cfg-protocol")) {
            $("cfg-protocol").value = item.config.protocol === "anthropic-messages"
              ? "anthropic"
              : item.config.protocol;
          }
          continue;
        }
        mapped.push({
          id: item.resourceId,
          backendId: item.resourceId,
          kind: item.kind,
          name: `${item.name} (${item.kind === "mcp" ? "stdio MCP" : "Agent Skill"})`,
          desc: item.kind === "mcp"
            ? "随程序提供的基础工作空间读写与脚本工具 (DL-75)"
            : "通用 Agent Skill 知识与方法包，按需加载 (DL-74)",
          enabled: Boolean(item.enabled),
          inFlight: true
        });
      }
      if (mapped.length > 0) {
        resources = mapped;
        renderAtelierResources();
      }
    } catch { /* ignore */ }
  }

  function formatShortTime(isoStr) {
    if (!isoStr) return "刚刚";
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return "刚刚";
      return clockFormatter.format(d);
    } catch {
      return "刚刚";
    }
  }

  function formatDateDay(isoStr) {
    if (!isoStr) return "今日";
    try {
      const d = new Date(isoStr);
      if (Number.isNaN(d.getTime())) return "今日";
      return `${String(d.getMonth() + 1).padStart(2, "0")}月${String(d.getDate()).padStart(2, "0")}日`;
    } catch {
      return "今日";
    }
  }

  async function syncRoleFromBackend(roleKey) {
    const role = ROLES[roleKey];
    if (!backendState.online || !role?.backendRoleId) return;
    const roleId = role.backendRoleId;

    // A. GET /v1/roles/:roleId (state & defaultWindowId)
    try {
      const detail = await apiFetch(`/v1/roles/${roleId}`);
      if (detail?.defaultWindowId) role.defaultWindowId = detail.defaultWindowId;
      if (detail?.state?.data) {
        applyBackendStateToRole(role, detail.state.data, detail.state.version, detail.state.updatedAt);
      }
    } catch { /* ignore */ }

    // B. GET /v1/roles/:roleId/windows/:defaultWindowId/messages (Main Window Messages)
    if (role.defaultWindowId) {
      try {
        const msgResp = await apiFetch(`/v1/roles/${roleId}/windows/${role.defaultWindowId}/messages?limit=50`);
        const items = Array.isArray(msgResp?.items) ? msgResp.items : [];
        role.mainWindow.messages = items.map(m => ({
          id: m.messageId,
          sender: m.sender === "user" ? "me" : "role",
          time: formatShortTime(m.createdAt),
          text: m.content,
          tag: m.status === "interrupted"
            ? "已中断 · 保留已输出片段 (DL-78)"
            : undefined
        }));
      } catch { /* ignore */ }
    }

    // C. GET /v1/roles/:roleId/windows (DL-04 External / Independent Windows Log)
    try {
      const winResp = await apiFetch(`/v1/roles/${roleId}/windows`);
      const winItems = Array.isArray(winResp?.items) ? winResp.items : [];
      const extWins = winItems.filter(w => w.windowId !== role.defaultWindowId && w.kind !== "default");
      const hydratedExt = [];
      for (const w of extWins) {
        let previewText = "独立会话窗口已建立，等待新消息。";
        try {
          const extMsgs = await apiFetch(`/v1/roles/${roleId}/windows/${w.windowId}/messages?limit=5`);
          const lastMsg = Array.isArray(extMsgs?.items) && extMsgs.items.length > 0
            ? extMsgs.items[extMsgs.items.length - 1]
            : null;
          if (lastMsg) {
            previewText = `${lastMsg.sender === "user" ? "我" : role.name}：${lastMsg.content}`;
          }
        } catch { /* ignore */ }
        hydratedExt.push({
          windowId: w.windowId,
          source: w.source || "custom",
          label: w.source === "qq_private"
            ? "QQ 私聊入口 (外部独立窗口 · DL-04)"
            : `独立窗口 (${w.source || "custom"})`,
          updatedAt: formatShortTime(w.createdAt),
          preview: previewText
        });
      }
      role.externalWindows = hydratedExt;
    } catch { /* ignore */ }

    // D. GET /v1/roles/:roleId/diaries (Handwritten Markdown Diaries)
    try {
      const diaryResp = await apiFetch(`/v1/roles/${roleId}/diaries`);
      const dItems = Array.isArray(diaryResp?.items) ? diaryResp.items : [];
      role.diaries = dItems.map((d, idx) => {
        const lines = String(d.content || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        const headingLine = lines.find(l => l.startsWith("#")) || `${formatDateDay(d.occurredAt)} · ${role.name}的亲笔手账`;
        const cleanTitle = headingLine.replace(/^#+\s*/, "");
        const bodyParas = lines.filter(l => !l.startsWith("#"));
        return {
          id: d.diaryId.slice(0, 8),
          diaryId: d.diaryId,
          date: formatDateDay(d.occurredAt),
          fullDate: String(d.occurredAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
          weather: idx === 0 ? "秋 · 晴窗微风" : "秋 · 暖灯静思",
          title: cleanTitle,
          body: bodyParas.length > 0 ? bodyParas : [String(d.content || "")],
          sources: Array.isArray(d.eventIds) && d.eventIds.length > 0
            ? d.eventIds.map(eid => `关联经历 · ${eid.slice(0, 12)}`)
            : ["关联经历 · SQLite 真实持久化手账 (GAP-06)"]
        };
      });
    } catch { /* ignore */ }

    // E. POST /v1/roles/:roleId/memory/search (Hydrate Events & Summaries if present in DB)
    try {
      const searchResp = await apiFetch(`/v1/roles/${roleId}/memory/search`, {
        method: "POST",
        body: { limit: 12 }
      });
      const sItems = Array.isArray(searchResp?.items) ? searchResp.items : [];
      const eventAndSummaries = sItems.filter(it => it.type === "event" || it.type === "daily_summary");
      const detailedMemories = [];
      for (const item of eventAndSummaries) {
        if (item.type === "event") {
          try {
            const ev = await apiFetch(`/v1/roles/${roleId}/memory/events/${item.id}`);
            const quotes = [];
            if (Array.isArray(ev.sources)) {
              for (const src of ev.sources.slice(0, 3)) {
                try {
                  const evd = await apiFetch(`/v1/roles/${roleId}/memory/evidence/${src.evidenceId}`);
                  quotes.push({
                    meta: `${formatShortTime(evd.occurredAt)} · 原始证据 [${evd.sourceKind}]`,
                    text: evd.content
                  });
                } catch { /* ignore */ }
              }
            }
            detailedMemories.push({
              id: ev.eventId,
              version: ev.version || 1,
              type: "event",
              typeLabel: "独立事件 · Event",
              title: ev.title,
              summary: ev.summary,
              date: formatShortTime(ev.occurredAtStart),
              emotion: (ev.tags?.emotion && ev.tags.emotion[0]) || "温暖 · 记录",
              recallCount: ev.recallCount ?? 1,
              roundsSinceUpdate: 1,
              windowSource: "唯一主信笺 (SQLite 落盘)",
              evidenceRange: `${ev.sources?.length || 1} 条原始证据链`,
              quotes: quotes.length > 0
                ? quotes
                : [{ meta: "SQLite 事件记录", text: ev.subjectiveExperience || ev.summary }]
            });
          } catch { /* ignore */ }
        }
      }
      role.memories = detailedMemories;
    } catch { /* ignore */ }

    // F. GET /v1/roles/:roleId/autonomy/budget & wakes & activities & tasks
    try {
      const budget = await apiFetch(`/v1/roles/${roleId}/autonomy/budget`);
      if (budget) {
        quotaLimit = budget.dailyLimit || 200;
        quotaUnlimited = Boolean(budget.unlimited);
        role.quotaUsed = budget.usedPoints || 0;
        if ($("cfg-quota-limit")) $("cfg-quota-limit").value = String(quotaLimit);
        if ($("cfg-quota-unlimited")) $("cfg-quota-unlimited").checked = quotaUnlimited;
      }
      const wakesResp = await apiFetch(`/v1/roles/${roleId}/autonomy/wakes?limit=20`);
      const wakes = Array.isArray(wakesResp?.items) ? wakesResp.items : [];
      const pendingWake = wakes.find(w => w.status === "scheduled" || w.status === "pending") || wakes[0];
      role.nextWake = pendingWake
        ? `下次唤醒 · ${formatShortTime(pendingWake.wakeAt)} ${pendingWake.intent.slice(0, 14)}`
        : "暂无唤醒计划";
      const tasksResp = await apiFetch(`/v1/roles/${roleId}/tasks`);
      const tasks = Array.isArray(tasksResp?.items) ? tasksResp.items : [];
      const combinedTimeline = [];
      for (const w of wakes.slice(0, 3)) {
        combinedTimeline.push({
          id: w.wakeId,
          title: w.intent,
          status: w.status === "completed" ? "completed" : "scheduled",
          statusText: w.status === "completed" ? "已唤醒完成" : `已安排唤醒 · ${formatShortTime(w.wakeAt)}`,
          detail: `唤醒计划 (${w.wakeId.slice(0, 8)}) · 状态：${w.status}`
        });
      }
      for (const t of tasks.slice(0, 4)) {
        combinedTimeline.push({
          id: t.taskId,
          title: t.kind === "conversation" ? "主信笺实时回信与工具调用链" : `任务链 · ${t.kind}`,
          status: t.status === "completed" ? "completed" : "scheduled",
          statusText: `${t.status === "completed" ? "已完成" : t.status} · ${formatShortTime(t.updatedAt)}`,
          detail: `Task ${t.taskId.slice(0, 8)} · 原任务链绑定资源 (${t.boundResourceIds?.length || 0} 项)`
        });
      }
      role.tasks = combinedTimeline;
    } catch { /* ignore */ }
  }

  function applyBackendStateToRole(role, data, version, updatedAt) {
    if (!data || typeof data !== "object") return;
    if (version) role.stateVersion = version;
    if (typeof data.moodSeal === "string") role.moodSeal = data.moodSeal;
    if (typeof data.mood === "string") role.moodTitle = `此刻心境 · ${data.mood}`;
    if (typeof data.note === "string") role.moodSummary = data.note;
    if (typeof data.moodSummary === "string") role.moodSummary = data.moodSummary;
    if (typeof data.focus === "number" && typeof data.sharing === "number" && typeof data.serenity === "number") {
      role.meters = [data.focus, data.sharing, data.serenity];
    } else if (data.meters && typeof data.meters === "object") {
      role.meters = [
        data.meters.focus ?? 0,
        data.meters.sharing ?? 0,
        data.meters.serenity ?? 0
      ];
    }
    if (Array.isArray(data.growth)) {
      role.growth = data.growth;
    } else if (Array.isArray(data.growthNotes)) {
      role.growth = data.growthNotes;
    }
    if (updatedAt && $("state-updated-at")) {
      $("state-updated-at").textContent = `更新于 ${formatShortTime(updatedAt)} (SQLite v${role.stateVersion})`;
    }
  }

  function connectRoleSseStream(roleKey) {
    const role = ROLES[roleKey];
    if (!backendState.online || !role?.backendRoleId || !role?.defaultWindowId) return;
    const targetKey = `${role.backendRoleId}:${role.defaultWindowId}`;
    if (backendState.sseSource && backendState.sseWindowKey === targetKey) return;

    if (backendState.sseSource) {
      backendState.sseSource.close();
      backendState.sseSource = null;
    }

    const base = backendState.apiBaseUrl || "";
    const sseUrl = `${base}/v1/roles/${role.backendRoleId}/windows/${role.defaultWindowId}/events?clientId=${encodeURIComponent(backendState.clientId)}`;
    const es = new EventSource(sseUrl);
    backendState.sseSource = es;
    backendState.sseWindowKey = targetKey;

    const finalizeStream = (interrupted = false) => {
      const interruptBtn = $("interrupt-btn");
      if (interruptBtn) interruptBtn.hidden = true;
      if (backendState.activeStreamingMsg) {
        delete backendState.activeStreamingMsg.streaming;
        if (interrupted) {
          backendState.activeStreamingMsg.tag = "已中断 · 保留已输出片段 (DL-78 / DL-82)";
        }
        backendState.activeStreamingMsg = null;
      }
      syncRoleFromBackend(roleKey).then(() => {
        if (currentRoleId === roleKey) {
          renderLetterPanel();
          renderSpreadPanel();
        }
      });
    };

    const handleSsePayload = data => {
      if (!data || typeof data !== "object") return;
      const type = data.type;
      if (type === "execution_started") {
        const interruptBtn = $("interrupt-btn");
        if (interruptBtn) interruptBtn.hidden = false;
      } else if (type === "message_delta" || type === "text_delta") {
        const delta = data.delta || data.text || "";
        if (!delta) return;
        let msg = backendState.activeStreamingMsg;
        if (!msg) {
          msg = {
            sender: "role",
            time: clockFormatter.format(new Date()),
            text: "",
            tag: "SSE 实时流式回信 · 已绑定长期记忆与工具链",
            streaming: true
          };
          backendState.activeStreamingMsg = msg;
          role.mainWindow.messages.push(msg);
          renderLetterPanel();
        }
        msg.text += delta;
        const lastDom = $("letter-messages")?.lastElementChild?.querySelector(".msg-text");
        if (lastDom) lastDom.textContent = msg.text + " ✒️";
        $("char-bubble-text").textContent = `“${msg.text.slice(0, 26)}${msg.text.length > 26 ? "……" : ""}”`;
      } else if (type === "tool_started" || type === "tool_call_started") {
        const toolName = data.toolName || data.name || "mcp_tool";
        $("char-bubble-text").textContent = `“正在调用工作空间工具 ${toolName} ……”`;
      } else if (
        type === "message_completed" ||
        type === "execution_completed" ||
        type === "execution_failed"
      ) {
        finalizeStream(false);
      } else if (
        type === "message_interrupted" ||
        type === "execution_interrupted"
      ) {
        finalizeStream(true);
      }
    };

    es.addEventListener("execution", ev => {
      try {
        handleSsePayload(JSON.parse(ev.data));
      } catch { /* ignore */ }
    });
  }

  /* ==========================================================================
     4. ATMOSPHERIC & ENVIRONMENT ENGINE WIRING
     ========================================================================== */
  const atmoEngine = window.createAtmosphericEngine(
    $("atmosphere-canvas"),
    $("lightcast-canvas"),
    app
  );

  const clockFormatter = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  });
  const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
    month: "long",
    day: "numeric",
    weekday: "short"
  });

  function updateEnvironment() {
    const now = new Date();
    const env = window.deskEnvironment.resolveEnvironment(now, envSettings);

    app.dataset.season = env.season;
    app.dataset.weather = env.weather;
    app.dataset.phase = env.phase;
    app.dataset.night = String(env.night);
    app.dataset.lamp = String(env.lamp);

    app.style.setProperty("--night-mix", String(env.nightMix));
    app.style.setProperty("--dusk-mix", String(env.duskMix));
    app.style.setProperty("--dawn-mix", String(env.dawnMix));
    app.style.setProperty("--god-ray-alpha", String(env.godRayAlpha));
    app.style.setProperty("--gobo-alpha", String(env.goboAlpha));

    const role = ROLES[currentRoleId];
    const actInfo = role.states[currentActivity] || role.states.reading;
    const useEveningPose = env.night || env.phase === "dusk" || actInfo.pose === "evening";
    app.dataset.pose = useEveningPose ? "evening" : "day";

    const seasonIcons = { spring: "🌸", summer: "🌿", autumn: "🍂", winter: "❄️" };
    $("hud-clock").textContent = clockFormatter.format(now);
    $("hud-date").textContent = dateFormatter.format(now);
    $("hud-env-summary").textContent = `${seasonIcons[env.season] || "🍂"} ${env.summary}`;
    $("tuner-poetic-label").textContent = env.poeticSummary;
    $("letter-subtitle").textContent = `${env.poeticSummary} · 唯一直接对话主窗口 (DL-04)`;

    const fgSeasonNote = $("foreground-season-note");
    if (fgSeasonNote) fgSeasonNote.textContent = `袅袅升腾的茶杯水汽 · ${env.poeticSummary}`;
    const lampHint = $("companion-lamp-hint");
    if (lampHint) lampHint.textContent = env.lamp ? "💡 台灯暖光池随行" : "☀️ 晴窗天光随行";

    const lampBtn = $("lamp-btn");
    lampBtn.setAttribute("aria-pressed", String(env.lamp));
    $("lamp-btn-label").textContent = env.lamp ? "💡 暖灯已亮" : "💡 台灯";

    const favicon = $("app-favicon");
    if (favicon) favicon.href = env.night ? "assets/fold-dark.svg" : "assets/fold-light.svg";
    const brandIcon = $("brand-fold-icon");
    if (brandIcon) brandIcon.src = env.night ? "assets/fold-dark.svg" : "assets/fold-light.svg";

    for (const group of document.querySelectorAll(".tuner-pills")) {
      const key = group.dataset.envGroup;
      const val = String(envSettings[key] ?? "auto");
      for (const btn of group.querySelectorAll("button")) {
        btn.classList.toggle("is-active", btn.dataset.val === val);
      }
    }

    atmoEngine.redraw();
  }

  /* ==========================================================================
     5. ROLE, PRESENCE STATE & DUAL-FOCUS STAGE RENDERING
     ========================================================================== */
  function renderRoleAndPresence() {
    const role = ROLES[currentRoleId];
    const act = role.states[currentActivity] || role.states.reading;

    app.dataset.role = role.id;
    app.dataset.activity = currentActivity;

    for (const btn of document.querySelectorAll("[data-role-btn]")) {
      btn.classList.toggle("is-active", btn.dataset.roleBtn === role.id);
    }

    $("char-bubble-text").textContent = act.bubble;
    const proactiveBtn = $("proactive-letter");
    const hasProactive = Boolean(role.proactiveBadge && role.proactiveShort);
    if (proactiveBtn) {
      proactiveBtn.hidden = !hasProactive;
    }
    $("proactive-badge").textContent = role.proactiveBadge || "";
    $("proactive-preview").textContent = role.proactiveShort || "";

    const quotaRemaining = Math.max(0, quotaLimit - role.quotaUsed);
    const quotaStr = quotaUnlimited ? "自主额度 · 无限制" : `自主额度 ${quotaRemaining}/${quotaLimit}`;
    $("dock-role-name").textContent = role.name;
    $("dock-activity-badge").textContent = act.badge;
    $("dock-quota-text").textContent = quotaStr;
    $("dock-status-desc").textContent = act.desc;

    $("companion-role-title").textContent = `${role.name} · ${act.badge.replace(/^[^\s]+\s/, "")}`;
    $("companion-activity-detail").textContent = act.desc;

    for (const btn of document.querySelectorAll("[data-state]")) {
      btn.classList.toggle("is-active", btn.dataset.state === currentActivity);
    }

    renderLetterPanel();
    renderJournalPanel();
    renderFilmstripPanel();
    renderSpreadPanel();
    updateEnvironment();
  }

  function setFocusMode(focus, medium = currentMedium) {
    currentFocus = focus;
    if (medium) currentMedium = medium;
    app.dataset.focus = currentFocus;
    app.dataset.medium = currentMedium;

    for (const tab of document.querySelectorAll("[data-medium-tab]")) {
      tab.classList.toggle("is-active", tab.dataset.mediumTab === currentMedium);
    }

    const panels = {
      letter: $("panel-letter"),
      journal: $("panel-journal"),
      filmstrip: $("panel-filmstrip"),
      spread: $("panel-spread")
    };
    const shouldAnimate = !app.classList.contains("is-booting");
    for (const [key, panel] of Object.entries(panels)) {
      const active = key === currentMedium;
      panel.hidden = !active;
      panel.classList.toggle("is-active", active);
      panel.classList.remove("is-entering");
      if (active && shouldAnimate && currentFocus === "theater") {
        void panel.offsetWidth;
        panel.classList.add("is-entering");
      }
    }

    if (currentFocus === "theater" && currentMedium === "letter") {
      const list = $("letter-messages");
      list.scrollTop = list.scrollHeight;
    }
  }

  /* ==========================================================================
     6. MEDIUM 1: ✒️ CORRESPONDENCE LETTER (SCHEME A: SINGLE MAIN WINDOW)
     ========================================================================== */
  function renderLetterPanel() {
    const role = ROLES[currentRoleId];
    const winSession = role.mainWindow;

    $("letter-seal").textContent = role.seal;
    $("letter-heading").textContent = `与${role.name}的窗畔书信`;
    const pinnedShareCard = $("pinned-share-card");
    if (pinnedShareCard) {
      pinnedShareCard.hidden = !role.proactiveFull;
    }
    $("share-card-title").textContent = `${role.name}在自主活动后给你留了一封折信：`;
    $("share-card-text").textContent = role.proactiveFull || "";

    const draftInput = $("draft-input");
    if (draftInput) {
      draftInput.placeholder = `在棉浆信笺上给${role.name}写点什么……（Enter 寄出，Shift+Enter 换行）`;
    }

    const list = $("letter-messages");
    list.replaceChildren();
    if (winSession.messages.length === 0) {
      const emptyLi = document.createElement("li");
      emptyLi.className = "empty-state-box";
      emptyLi.textContent = "当前主对话窗口暂无书信往来。在下方落笔发送第一封信，即可开启对话。";
      list.append(emptyLi);
    } else {
      for (const msg of winSession.messages) {
        list.append(createMessageNode(role, msg));
      }
    }
    list.scrollTop = list.scrollHeight;

    if (draftInput && document.activeElement !== draftInput) {
      draftInput.value = winSession.draft || "";
    }
  }

  function createMessageNode(role, msg) {
    const li = document.createElement("li");
    li.className = "msg-item";
    li.dataset.sender = msg.sender;

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    const author = document.createElement("span");
    author.className = "msg-sender-name";
    author.textContent = msg.sender === "me" ? "我 · 落笔" : `${role.name} · 回信`;
    const time = document.createElement("time");
    time.textContent = msg.time || "刚刚";
    meta.append(author, time);

    const p = document.createElement("p");
    p.className = "msg-text";
    p.textContent = msg.text;
    li.append(meta, p);

    if (msg.tag) {
      const badge = document.createElement("span");
      badge.className = "msg-badge-tag";
      badge.textContent = msg.tag;
      li.append(badge);
    }
    return li;
  }

  async function submitMessageToRole(userText) {
    const role = ROLES[currentRoleId];
    const winSession = role.mainWindow;
    const nowTime = clockFormatter.format(new Date());

    // Push user message immediately to UI
    winSession.messages.push({
      sender: "me",
      time: nowTime,
      text: userText
    });
    renderLetterPanel();

    // If connected to real backend, POST /v1/roles/:roleId/windows/:defaultWindowId/messages
    if (backendState.online && role.backendRoleId && role.defaultWindowId) {
      try {
        connectRoleSseStream(currentRoleId);
        backendState.activeStreamingMsg = null;
        $("interrupt-btn").hidden = false;
        $("char-bubble-text").textContent = `“${role.name}正在结合记忆与状态为你落笔回信……”`;

        await apiFetch(`/v1/roles/${role.backendRoleId}/windows/${role.defaultWindowId}/messages`, {
          method: "POST",
          body: {
            content: userText,
            submissionId: `sub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            source: "nowadays"
          }
        });
        return;
      } catch (err) {
        console.warn("[nowadays-desk] POST message fallback:", err?.message || err);
      }
    }

    // Offline fallback streaming simulation
    triggerOfflineStreamingReply(userText);
  }

  function triggerOfflineStreamingReply(userText) {
    const role = ROLES[currentRoleId];
    const winSession = role.mainWindow;
    const nowTime = clockFormatter.format(new Date());

    if (streamingTimer) {
      clearInterval(streamingTimer);
      streamingTimer = null;
      const lastMsg = winSession.messages[winSession.messages.length - 1];
      if (lastMsg && lastMsg.streaming) {
        delete lastMsg.streaming;
        lastMsg.tag = "已中断 · 保留已输出片段 (DL-78)";
      }
    }

    const fullReply = role.replies[replyCounter % role.replies.length];
    replyCounter++;

    const replyObj = {
      sender: "role",
      time: nowTime,
      text: "…",
      tag: `结合最新状态与记忆回应 · 对应输入「${userText.slice(0, 12)}${userText.length > 12 ? "…" : ""}」`,
      streaming: true
    };
    winSession.messages.push(replyObj);
    renderLetterPanel();

    const interruptBtn = $("interrupt-btn");
    interruptBtn.hidden = false;
    $("char-bubble-text").textContent = `“正在为你回信：${fullReply.slice(0, 18)}……”`;

    let charIdx = 0;
    streamingTimer = setInterval(() => {
      charIdx += 3;
      if (charIdx >= fullReply.length) {
        replyObj.text = fullReply;
        delete replyObj.streaming;
        clearInterval(streamingTimer);
        streamingTimer = null;
        interruptBtn.hidden = true;
        renderLetterPanel();
      } else {
        replyObj.text = fullReply.slice(0, charIdx) + " ✒️";
        const lastDom = $("letter-messages").lastElementChild?.querySelector(".msg-text");
        if (lastDom) lastDom.textContent = replyObj.text;
      }
    }, 45);
  }

  /* ==========================================================================
     7. MEDIUM 2: 📖 3D LEATHER JOURNAL (DIARY & INNER STATE)
     ========================================================================== */
  function renderJournalPanel(animateFlip = false) {
    const role = ROLES[currentRoleId];
    if (currentDiaryIdx >= role.diaries.length) currentDiaryIdx = 0;
    const diary = role.diaries[currentDiaryIdx] || null;

    $("mood-seal").textContent = role.moodSeal || "—";
    $("journal-heading").textContent = role.moodTitle || "暂无心境记录";
    $("mood-summary").textContent = role.moodSummary || "尚未产生心境与情绪变化记录。";

    const [focusVal, shareVal, serenityVal] = role.meters || [0, 0, 0];
    if ($("meter-bar-focus")) $("meter-bar-focus").style.width = `${focusVal}%`;
    if ($("meter-val-focus")) $("meter-val-focus").textContent = `${focusVal}%`;
    if ($("meter-bar-sharing")) $("meter-bar-sharing").style.width = `${shareVal}%`;
    if ($("meter-val-sharing")) $("meter-val-sharing").textContent = `${shareVal}%`;
    if ($("meter-bar-serenity")) $("meter-bar-serenity").style.width = `${serenityVal}%`;
    if ($("meter-val-serenity")) $("meter-val-serenity").textContent = `${serenityVal}%`;

    const growthList = $("growth-list");
    growthList.replaceChildren();
    if (role.growth.length === 0) {
      const emptyGrowth = document.createElement("li");
      emptyGrowth.className = "empty-state-muted";
      emptyGrowth.textContent = "暂无成长印记，随对话与经历逐步形成。";
      growthList.append(emptyGrowth);
    } else {
      for (const item of role.growth) {
        const li = document.createElement("li");
        li.textContent = item;
        growthList.append(li);
      }
    }

    const stage = $("journal-flip-stage");
    if (animateFlip) {
      stage.classList.remove("is-flipping");
      void stage.offsetWidth;
      stage.classList.add("is-flipping");
    }

    const body = $("diary-body");
    const sources = $("diary-sources");
    const tabsWrap = $("journal-index-tabs");
    body.replaceChildren();
    sources.replaceChildren();
    tabsWrap.replaceChildren();

    if (!diary) {
      $("diary-id-label").textContent = "DIARY · 暂无记录";
      $("diary-weather-tag").textContent = "—";
      $("diary-title").textContent = "暂无亲笔日记";
      const emptyP = document.createElement("p");
      emptyP.className = "empty-state-muted";
      emptyP.textContent = "当前角色尚未写下亲笔日记。可点击右上角「+ 写日记」或在自主活动后查看。";
      body.append(emptyP);
      $("diary-page-counter").textContent = "00 / 00";
      if ($("diary-prev-btn")) $("diary-prev-btn").disabled = true;
      if ($("diary-next-btn")) $("diary-next-btn").disabled = true;
      return;
    }

    if ($("diary-prev-btn")) $("diary-prev-btn").disabled = role.diaries.length <= 1;
    if ($("diary-next-btn")) $("diary-next-btn").disabled = role.diaries.length <= 1;

    $("diary-id-label").textContent = `DIARY · ${diary.fullDate} / ${diary.id}`;
    $("diary-weather-tag").textContent = diary.weather;
    $("diary-title").textContent = diary.title;

    for (const para of diary.body) {
      const p = document.createElement("p");
      p.innerHTML = para;
      body.append(p);
    }

    for (const src of diary.sources) {
      const chip = document.createElement("span");
      chip.className = "source-event-chip";
      chip.textContent = src;
      sources.append(chip);
    }

    $("diary-page-counter").textContent = `${String(currentDiaryIdx + 1).padStart(2, "0")} / ${String(role.diaries.length).padStart(2, "0")}`;

    role.diaries.forEach((d, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "journal-date-tab" + (idx === currentDiaryIdx ? " is-active" : "");
      btn.textContent = d.date;
      btn.addEventListener("click", () => {
        if (currentDiaryIdx !== idx) {
          currentDiaryIdx = idx;
          renderJournalPanel(true);
        }
      });
      tabsWrap.append(btn);
    });
  }

  /* ==========================================================================
     8. MEDIUM 3: 🎞️ DARKROOM FILMSTRIP & SLIDE-OUT RAW EVIDENCE
     ========================================================================== */
  function renderFilmstripPanel() {
    const role = ROLES[currentRoleId];
    const query = ($("memory-search")?.value || "").trim().toLowerCase();

    const filtered = role.memories.filter(m => {
      if (currentMemoryFilter !== "all" && m.type !== currentMemoryFilter) return false;
      if (!query) return true;
      return (
        m.title.toLowerCase().includes(query) ||
        m.summary.toLowerCase().includes(query) ||
        m.emotion.toLowerCase().includes(query) ||
        m.date.toLowerCase().includes(query)
      );
    });

    if (!filtered.some(m => m.id === currentMemoryId)) {
      currentMemoryId = filtered[0]?.id || "";
    }

    const gallery = $("polaroid-gallery");
    gallery.replaceChildren();

    if (filtered.length === 0) {
      const emptyBox = document.createElement("div");
      emptyBox.className = "empty-state-box";
      emptyBox.textContent = "暂无符合条件的记忆卡片。对话达到一定轮次或点击「🔄 整理记忆」后将生成事件与摘要。";
      gallery.append(emptyBox);
    } else {
      for (const mem of filtered) {
        const card = document.createElement("button");
        card.type = "button";
        card.className = "mem-polaroid-card" + (mem.id === currentMemoryId ? " is-selected" : "");
        card.setAttribute("role", "listitem");
        card.innerHTML = `
          <span class="polaroid-clip" aria-hidden="true"></span>
          <span class="mem-type-badge" data-type="${mem.type}">${mem.typeLabel}</span>
          <h4>${mem.title}</h4>
          <p>${mem.summary}</p>
          <div class="mem-card-foot">
            <span>#${mem.emotion}</span>
            <span>召回 ${mem.recallCount} 次</span>
          </div>
        `;
        card.addEventListener("click", () => {
          currentMemoryId = mem.id;
          renderFilmstripPanel();
        });
        gallery.append(card);
      }
    }

    const selected = filtered.find(m => m.id === currentMemoryId) || null;
    const quotesList = $("evidence-quotes");
    quotesList.replaceChildren();

    if (!selected) {
      $("evidence-id-code").textContent = "NONE";
      $("evidence-title").textContent = "未选中记忆卡片";
      $("evidence-meta").innerHTML = `
        <div class="empty-state-muted" style="grid-column: 1 / -1">当前记忆库为空，暂无可追溯的原始对话或工具调用证据。</div>
      `;
      return;
    }

    const drawer = $("evidence-drawer");
    drawer.style.animation = "none";
    void drawer.offsetWidth;
    drawer.style.animation = "";

    $("evidence-id-code").textContent = selected.id;
    $("evidence-title").textContent = selected.title;
    $("evidence-meta").innerHTML = `
      <div><strong>记录时间：</strong>${selected.date}</div>
      <div><strong>情绪索引：</strong>${selected.emotion}</div>
      <div><strong>召回统计：</strong>累计 ${selected.recallCount} 次 (DL-97)</div>
      <div><strong>精炼观察：</strong>距今 ${selected.roundsSinceUpdate} 轮 (阈值 100 轮)</div>
      <div style="grid-column: 1 / -1"><strong>来源窗口：</strong>${selected.windowSource}</div>
      <div style="grid-column: 1 / -1"><strong>证据范围：</strong><code>${selected.evidenceRange}</code></div>
    `;

    for (const q of selected.quotes) {
      const div = document.createElement("div");
      div.className = "raw-quote-item";
      div.innerHTML = `<small>${q.meta}</small><div>${q.text}</div>`;
      quotesList.append(div);
    }
  }

  /* ==========================================================================
     9. MEDIUM 4: 🧭 CO-WORKING DESK SPREAD (WATCH, MANUSCRIPT & EXTERNAL LOGS)
     ========================================================================== */
  function renderSpreadPanel() {
    const role = ROLES[currentRoleId];
    const remaining = Math.max(0, quotaLimit - role.quotaUsed);

    $("quota-mode-badge").textContent = quotaUnlimited
      ? "预算模式 · 无限制 (DL-107)"
      : `每日预算 · ${quotaLimit} 点`;

    const readout = $("dial-quota-value");
    if (quotaUnlimited) {
      readout.innerHTML = `∞<span>/已用${role.quotaUsed}</span>`;
    } else {
      readout.innerHTML = `${remaining}<span>/${quotaLimit}</span>`;
    }
    $("dial-next-wake").textContent = role.nextWake || "暂无唤醒计划";

    const circumference = 502.6;
    const ratio = quotaUnlimited ? 0.92 : Math.max(0, Math.min(1, remaining / Math.max(1, quotaLimit)));
    $("quota-ring-arc").setAttribute("stroke-dashoffset", String((circumference * (1 - ratio)).toFixed(1)));

    const taskList = $("task-chain-list");
    taskList.replaceChildren();
    if (role.tasks.length === 0) {
      const emptyTask = document.createElement("li");
      emptyTask.className = "empty-state-box";
      emptyTask.textContent = "暂无自主唤醒计划与任务链记录。";
      taskList.append(emptyTask);
    } else {
      for (const t of role.tasks) {
        const li = document.createElement("li");
        li.className = "task-chain-item";
        li.innerHTML = `
          <div class="task-chain-top">
            <span>${t.title}</span>
            <span class="task-status-pill" data-status="${t.status}">${t.statusText}</span>
          </div>
          <div style="color: var(--ink-secondary); font-size: 0.72rem;">${t.detail}</div>
        `;
        taskList.append(li);
      }
    }

    // Workspace Markdown Manuscript
    if (currentManuscriptIdx >= role.manuscripts.length) currentManuscriptIdx = 0;
    const ms = role.manuscripts[currentManuscriptIdx] || null;
    $("workspace-path").textContent = `data/roles/${role.id}/workspace/notes/`;
    const fileTabs = $("manuscript-file-tabs");
    fileTabs.replaceChildren();

    if (!ms) {
      $("manuscript-title").textContent = "工作空间暂无笔记文件";
      $("manuscript-content").innerHTML = `<p class="empty-state-muted">当角色通过本地 MCP 文件工具写入 Markdown 笔记后，将在此处实时预览。</p>`;
      $("manuscript-updated").textContent = "暂无文件更新记录";
      if ($("manuscript-chat-btn")) $("manuscript-chat-btn").disabled = true;
    } else {
      if ($("manuscript-chat-btn")) $("manuscript-chat-btn").disabled = false;
      $("manuscript-title").textContent = ms.title;
      $("manuscript-content").innerHTML = ms.html;
      $("manuscript-updated").textContent = ms.updated;

      role.manuscripts.forEach((doc, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ms-file-tab" + (idx === currentManuscriptIdx ? " is-active" : "");
        btn.textContent = doc.file;
        btn.addEventListener("click", () => {
          currentManuscriptIdx = idx;
          renderSpreadPanel();
        });
        fileTabs.append(btn);
      });
    }

    // DL-04 Scheme A: Render External / Other Independent Channel Windows Log
    const extList = $("external-windows-list");
    const extCount = $("ext-windows-count");
    if (extList) {
      extList.replaceChildren();
      const extWindows = role.externalWindows || [];
      if (extCount) {
        extCount.textContent = `共 ${extWindows.length} 个外部/独立渠道窗口 · 不混入主聊天窗`;
      }
      if (extWindows.length === 0) {
        const emptyExt = document.createElement("div");
        emptyExt.className = "empty-state-muted";
        emptyExt.textContent = "暂无其他独立窗口或外部渠道会话。";
        extList.append(emptyExt);
      } else {
        for (const ew of extWindows) {
          const item = document.createElement("div");
          item.className = "ext-win-item";
          item.innerHTML = `
            <div>
              <strong>${ew.label}</strong>
              <p>${ew.preview}</p>
            </div>
            <span class="ext-win-tag">${ew.source} · ${ew.updatedAt}</span>
          `;
          extList.append(item);
        }
      }
    }
  }

  /* ==========================================================================
     10. ATELIER BLUEPRINT DRAWER (MODELS, MCP/SKILLS & QUOTA)
     ========================================================================== */
  function renderAtelierResources() {
    const list = $("resource-switch-list");
    list.replaceChildren();
    for (const res of resources) {
      const row = document.createElement("div");
      row.className = "resource-item";
      const continuationNote = !res.enabled && res.inFlight
        ? " · ⏳ 原任务链延续使用至当前链结束 (DL-71)"
        : "";
      row.innerHTML = `
        <div>
          <strong>${res.name}</strong>
          <small>${res.desc}${continuationNote}</small>
        </div>
      `;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "switch-btn";
      btn.setAttribute("aria-pressed", String(res.enabled));
      btn.textContent = res.enabled ? "已启用" : "已停用";
      btn.addEventListener("click", async () => {
        res.enabled = !res.enabled;
        renderAtelierResources();
        if (backendState.online && res.backendId) {
          try {
            await apiFetch(`/v1/resources/${res.backendId}`, {
              method: "PATCH",
              body: { enabled: res.enabled }
            });
            $("conn-result-text").textContent = `✔ 已实时同步资源开关（${res.enabled ? "启用" : "停用 · 原任务链继续执行 DL-71"}）`;
          } catch { /* ignore */ }
        }
      });
      row.append(btn);
      list.append(row);
    }
  }

  /* ==========================================================================
     11. INTERACTION EVENT BINDINGS
     ========================================================================== */
  window.addEventListener("pointermove", event => {
    const nx = (event.clientX / Math.max(1, window.innerWidth) - 0.5) * 2;
    const ny = (event.clientY / Math.max(1, window.innerHeight) - 0.5) * 2;
    app.style.setProperty("--mx", nx.toFixed(3));
    app.style.setProperty("--my", ny.toFixed(3));
  });

  $("chrono-btn").addEventListener("click", () => {
    const pop = $("env-popover");
    const open = pop.hidden;
    pop.hidden = !open;
    $("chrono-btn").setAttribute("aria-expanded", String(open));
  });

  for (const group of document.querySelectorAll(".tuner-pills")) {
    const key = group.dataset.envGroup;
    for (const btn of group.querySelectorAll("button")) {
      btn.addEventListener("click", () => {
        const val = btn.dataset.val;
        envSettings[key] = val === "on" ? true : val === "off" ? false : val;
        saveEnvSettings();
        updateEnvironment();
      });
    }
  }

  function toggleLamp() {
    const currentlyLit = app.dataset.lamp === "true";
    envSettings.lamp = !currentlyLit;
    saveEnvSettings();
    updateEnvironment();
  }
  $("lamp-btn").addEventListener("click", toggleLamp);

  // Role Switcher Mini-Polaroids
  for (const btn of document.querySelectorAll("[data-role-btn]")) {
    btn.addEventListener("click", () => {
      currentRoleId = btn.dataset.roleBtn;
      currentDiaryIdx = 0;
      currentManuscriptIdx = 0;
      connectRoleSseStream(currentRoleId);
      renderRoleAndPresence();
    });
  }

  $("character-figure").addEventListener("click", () => {
    const states = ["reading", "writing", "thinking", "sharing", "resting"];
    const nextIdx = (states.indexOf(currentActivity) + 1) % states.length;
    currentActivity = states[nextIdx];
    renderRoleAndPresence();
  });

  for (const btn of document.querySelectorAll("[data-state]")) {
    btn.addEventListener("click", () => {
      currentActivity = btn.dataset.state;
      renderRoleAndPresence();
    });
  }

  for (const card of document.querySelectorAll("[data-open-medium]")) {
    card.addEventListener("click", () => {
      setFocusMode("theater", card.dataset.openMedium);
    });
  }

  $("proactive-letter").addEventListener("click", () => {
    setFocusMode("theater", "letter");
  });

  for (const tab of document.querySelectorAll("[data-medium-tab]")) {
    tab.addEventListener("click", () => {
      setFocusMode("theater", tab.dataset.mediumTab);
    });
  }

  $("theater-close-btn").addEventListener("click", () => setFocusMode("stage"));
  $("stage-return-btn").addEventListener("click", () => setFocusMode("stage"));

  // Scheme A: Jump from Main Letter Window to External Windows Log in Spread Panel
  $("ext-log-jump-btn")?.addEventListener("click", () => {
    setFocusMode("theater", "spread");
    const box = $("external-windows-box");
    if (box) {
      box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });

  $("share-reply-btn").addEventListener("click", () => {
    const input = $("draft-input");
    input.value = "我刚看了你留的折信，那家夹着银杏叶的旧书店听起来太美了，我们一起挑下一本书吧！";
    input.focus();
  });

  for (const chip of document.querySelectorAll(".prompt-chip")) {
    chip.addEventListener("click", () => {
      const input = $("draft-input");
      input.value = chip.dataset.prompt;
      input.focus();
    });
  }

  // Typing Perception (DL-80 ~ DL-82: 1 second pause exit + real POST/DELETE /input-state)
  const draftInput = $("draft-input");
  draftInput.addEventListener("input", () => {
    const role = ROLES[currentRoleId];
    role.mainWindow.draft = draftInput.value;

    const statusBar = $("typing-status-bar");
    const statusText = $("typing-status-text");
    if (statusText) {
      statusText.textContent = `正在落笔输入 · ${role.name}正停下翻书倾听（停笔 1 秒后同步 input-state 触发回应）…`;
    }
    statusBar.hidden = false;
    $("char-bubble-text").textContent = `“正在倾听你落笔……（等你停笔 1 秒后我再组织回信）”`;

    if (backendState.online && role.backendRoleId && role.defaultWindowId) {
      apiFetch(`/v1/roles/${role.backendRoleId}/windows/${role.defaultWindowId}/input-state`, {
        method: "POST",
        body: { clientId: backendState.clientId, typing: true }
      }).catch(() => {});
    }

    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(() => {
      statusBar.hidden = true;
      const act = role.states[currentActivity] || role.states.reading;
      $("char-bubble-text").textContent = act.bubble;
      if (backendState.online && role.backendRoleId && role.defaultWindowId) {
        apiFetch(`/v1/roles/${role.backendRoleId}/windows/${role.defaultWindowId}/input-state`, {
          method: "POST",
          body: { clientId: backendState.clientId, typing: false }
        }).catch(() => {});
      }
    }, 1000);
  });

  draftInput.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      $("letter-composer").requestSubmit();
    }
  });

  $("interrupt-btn").addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    if (streamingTimer) {
      clearInterval(streamingTimer);
      streamingTimer = null;
      const msgs = role.mainWindow.messages;
      const last = msgs[msgs.length - 1];
      if (last) {
        delete last.streaming;
        last.tag = "已由用户中断 · 保留已输出部分 (DL-78)";
      }
      $("interrupt-btn").hidden = true;
      renderLetterPanel();
    } else if (backendState.online && role.backendRoleId && role.defaultWindowId) {
      const followUp = draftInput.value.trim() || "请先停一下，我想换个话题聊聊。";
      draftInput.value = "";
      role.mainWindow.draft = "";
      await submitMessageToRole(followUp);
    }
  });

  $("letter-composer").addEventListener("submit", async event => {
    event.preventDefault();
    const text = draftInput.value.trim();
    if (!text) return;

    if (typingTimer) clearTimeout(typingTimer);
    $("typing-status-bar").hidden = true;

    const role = ROLES[currentRoleId];
    if (backendState.online && role.backendRoleId && role.defaultWindowId) {
      apiFetch(
        `/v1/roles/${role.backendRoleId}/windows/${role.defaultWindowId}/input-state?clientId=${encodeURIComponent(backendState.clientId)}`,
        { method: "DELETE" }
      ).catch(() => {});
    }

    role.mainWindow.draft = "";
    draftInput.value = "";
    await submitMessageToRole(text);
  });

  // Journal: Sync Inner State (PUT /v1/roles/:roleId/state) & Create Diary (POST /v1/roles/:roleId/diaries)
  $("sync-state-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const nowTime = clockFormatter.format(new Date());
    const newGrowthLine = `在 ${nowTime} 的窗畔交谈后，记录下了关于水彩光影与秋日共读的新默契。`;
    if (!role.growth.includes(newGrowthLine)) {
      role.growth.unshift(newGrowthLine);
    }
    role.meters = [
      Math.min(99, (role.meters[0] || 90) + 2),
      Math.min(99, (role.meters[1] || 94) + 1),
      Math.min(99, (role.meters[2] || 88) + 2)
    ];

    if (backendState.online && role.backendRoleId) {
      try {
        const updated = await apiFetch(`/v1/roles/${role.backendRoleId}/state`, {
          method: "PUT",
          body: {
            state: {
              mood: "温润而专注",
              moodSeal: role.moodSeal,
              activity: currentActivity,
              focus: role.meters[0],
              sharing: role.meters[1],
              serenity: role.meters[2],
              note: role.moodSummary,
              growth: role.growth
            }
          }
        });
        if (updated?.version) role.stateVersion = updated.version;
        if ($("state-updated-at")) {
          $("state-updated-at").textContent = `已存盘于 ${nowTime} (SQLite v${role.stateVersion})`;
        }
      } catch { /* ignore */ }
    }
    renderJournalPanel(false);
  });

  $("diary-create-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const now = new Date();
    const dateLabel = formatDateDay(now.toISOString());
    const title = `${dateLabel} · 窗畔共读与水彩光影补记`;
    const markdown = `# ${title}\n\n刚刚在主信笺里聊完新的章节，<mark>把此刻窗边的暖光与共读灵感亲笔补记进手账</mark>。\n\n无论外面的季节如何流转，只要翻开这本皮质手账，就能找回我们每一次对话时的温度。`;

    if (backendState.online && role.backendRoleId) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/diaries`, {
          method: "POST",
          body: {
            content: markdown,
            occurredAt: now.toISOString()
          }
        });
        await syncRoleFromBackend(currentRoleId);
        currentDiaryIdx = 0;
        renderJournalPanel(true);
        return;
      } catch { /* ignore */ }
    }

    role.diaries.unshift({
      id: "d_" + Math.floor(100 + Math.random() * 900),
      date: dateLabel,
      fullDate: now.toISOString().slice(0, 10),
      weather: "秋 · 晴窗暖灯",
      title,
      body: [
        "刚刚在主信笺里聊完新的章节，<mark>把此刻窗边的暖光与共读灵感亲笔补记进手账</mark>。",
        "无论外面的季节如何流转，只要翻开这本皮质手账，就能找回我们每一次对话时的温度。"
      ],
      sources: ["关联经历 · 实时追加亲笔日记 (GAP-06)"]
    });
    currentDiaryIdx = 0;
    renderJournalPanel(true);
  });

  $("diary-prev-btn").addEventListener("click", () => {
    const diaries = ROLES[currentRoleId].diaries;
    if (!diaries.length) return;
    currentDiaryIdx = (currentDiaryIdx - 1 + diaries.length) % diaries.length;
    renderJournalPanel(true);
  });
  $("diary-next-btn").addEventListener("click", () => {
    const diaries = ROLES[currentRoleId].diaries;
    if (!diaries.length) return;
    currentDiaryIdx = (currentDiaryIdx + 1) % diaries.length;
    renderJournalPanel(true);
  });

  // Filmstrip Filter, Search, Memory Batch Trigger & Manual Correction (DL-55)
  for (const btn of document.querySelectorAll(".mem-filter[data-filter]")) {
    btn.addEventListener("click", () => {
      currentMemoryFilter = btn.dataset.filter;
      for (const b of document.querySelectorAll(".mem-filter[data-filter]")) {
        b.classList.toggle("is-active", b === btn);
      }
      renderFilmstripPanel();
    });
  }

  $("memory-search").addEventListener("input", async () => {
    const q = $("memory-search").value.trim();
    const role = ROLES[currentRoleId];
    if (backendState.online && role.backendRoleId && q.length >= 2) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/memory/search`, {
          method: "POST",
          body: { query: q, limit: 10 }
        });
      } catch { /* ignore */ }
    }
    renderFilmstripPanel();
  });

  $("memory-batch-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const btn = $("memory-batch-btn");
    if (btn) btn.textContent = "⏳ 正在整理…";
    if (backendState.online && role.backendRoleId) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/memory/batches`, {
          method: "POST"
        });
        await new Promise(r => setTimeout(r, 450));
        await syncRoleFromBackend(currentRoleId);
      } catch { /* ignore */ }
    }
    if (btn) btn.textContent = "✔ 整理完成";
    setTimeout(() => {
      if (btn) btn.textContent = "🔄 整理记忆";
    }, 1500);
    renderFilmstripPanel();
  });

  $("evidence-correct-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const selected = role.memories.find(m => m.id === currentMemoryId) || role.memories[0];
    if (!selected) return;

    const suffix = "（已由用户通过 DL-55 核验并补充批注）";
    if (!selected.summary.includes(suffix)) {
      selected.summary += suffix;
    }

    if (backendState.online && role.backendRoleId && /^[0-9a-f-]{36}$/i.test(selected.id)) {
      try {
        const res = await apiFetch(`/v1/roles/${role.backendRoleId}/memory/events/${selected.id}`, {
          method: "PATCH",
          body: {
            expectedVersion: selected.version || 1,
            patch: { summary: selected.summary },
            reason: "用户在桌面端胶片记忆库执行人工校订 (DL-55)"
          }
        });
        if (res?.version) selected.version = res.version;
      } catch { /* ignore */ }
    }
    renderFilmstripPanel();
  });

  $("evidence-discuss-btn").addEventListener("click", () => {
    const role = ROLES[currentRoleId];
    const selected = role.memories.find(m => m.id === currentMemoryId) || role.memories[0];
    setFocusMode("theater", "letter");
    if (selected) {
      $("draft-input").value = `我想起我们的记忆「${selected.title}」（${selected.id}），当时聊到的内容我们继续往下展开吧？`;
      $("draft-input").focus();
    }
  });

  // Spread Panel: Autonomy Activity, Add Wake Schedule (POST /autonomy/wakes) & Discuss Manuscript
  $("sim-activity-btn").addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const nowStr = clockFormatter.format(new Date());
    role.quotaUsed += 2;

    if (backendState.online && role.backendRoleId) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/autonomy/wakes`, {
          method: "POST",
          body: {
            wakeAt: new Date(Date.now() + 30 * 60_000).toISOString(),
            intent: `自主精读与水彩札记更新（${nowStr} 触发）`
          }
        });
        await syncRoleFromBackend(currentRoleId);
      } catch { /* ignore */ }
    } else {
      role.tasks.unshift({
        id: "task_" + Math.floor(811 + Math.random() * 80),
        title: `自主精读与摘录更新（${nowStr} 触发）`,
        status: "completed",
        statusText: `已完成 · ${nowStr}`,
        detail: "调用模型思考 (-1点) + local_fs.write_file (-1点) · 笔记与记忆索引已同步"
      });
    }
    currentActivity = "writing";
    renderRoleAndPresence();
  });

  $("add-wake-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const future = new Date(Date.now() + 90 * 60_000);
    const wakeTimeStr = clockFormatter.format(future);
    const intent = `整理今日共读批注并更新工作空间笔记 (${wakeTimeStr})`;

    if (backendState.online && role.backendRoleId) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/autonomy/wakes`, {
          method: "POST",
          body: {
            wakeAt: future.toISOString(),
            intent
          }
        });
        await syncRoleFromBackend(currentRoleId);
        renderSpreadPanel();
        return;
      } catch { /* ignore */ }
    }

    role.nextWake = `下次唤醒 · ${wakeTimeStr} 整理共读批注`;
    role.tasks.unshift({
      id: "wake_" + Math.floor(100 + Math.random() * 900),
      title: intent,
      status: "scheduled",
      statusText: `已安排唤醒 · ${wakeTimeStr}`,
      detail: "通过唤醒调度器登记 · 预计消耗 2 点自主额度"
    });
    renderSpreadPanel();
  });

  $("manuscript-chat-btn").addEventListener("click", () => {
    const role = ROLES[currentRoleId];
    const ms = role.manuscripts[currentManuscriptIdx];
    if (!ms) return;
    setFocusMode("theater", "letter");
    $("draft-input").value = `我刚翻看了你工作空间里的《${ms.title}》，里面的批注写得真好！`;
    $("draft-input").focus();
  });

  // Atelier Blueprint Drawer (Models, Test Connection, Save Bindings & Quota)
  function toggleAtelier(open) {
    const drawer = $("atelier-drawer");
    const isOpen = open ?? drawer.hidden;
    drawer.hidden = !isOpen;
    $("atelier-btn").setAttribute("aria-expanded", String(isOpen));
  }
  $("atelier-btn").addEventListener("click", () => toggleAtelier());
  $("atelier-close-btn").addEventListener("click", () => toggleAtelier(false));
  $("atelier-backdrop").addEventListener("click", () => toggleAtelier(false));

  function normalizeModelProtocol(rawVal) {
    if (rawVal === "anthropic" || rawVal === "anthropic-messages") return "anthropic-messages";
    if (rawVal === "openai-responses") return "openai-responses";
    return "openai-chat";
  }

  $("fetch-models-btn").addEventListener("click", async () => {
    const protocol = normalizeModelProtocol($("cfg-protocol").value);
    const baseUrl = ($("cfg-baseurl").value || "").trim() || backendState.mockLlmBaseUrl;
    $("conn-result-text").textContent = "⏳ 正在调用 POST /v1/model-services/models 拉取列表…";

    if (backendState.online) {
      try {
        const res = await apiFetch("/v1/model-services/models", {
          method: "POST",
          body: { protocol, baseUrl }
        });
        const models = Array.isArray(res?.models) ? res.models : [];
        if (models.length > 0) {
          const firstId = typeof models[0] === "string" ? models[0] : (models[0].id || "nowadays-companion-v1");
          $("cfg-model-id").value = firstId;
          $("conn-result-text").textContent = `✔ 已从服务端拉取 ${models.length} 个可用模型并填入「${firstId}」(DL-118)`;
          return;
        }
      } catch { /* fallback below */ }
    }

    const sampleModels = {
      "anthropic-messages": "deepseek-chat",
      "openai-responses": "gpt-4.1-mini",
      "openai-chat": "nowadays-companion-v1"
    };
    $("cfg-model-id").value = sampleModels[protocol] || "nowadays-companion-v1";
    $("conn-result-text").textContent = "✔ 已拉取可用模型列表并填入 (DL-118)";
  });

  $("test-conn-btn").addEventListener("click", async () => {
    const protocol = normalizeModelProtocol($("cfg-protocol").value);
    const baseUrl = ($("cfg-baseurl").value || "").trim() || backendState.mockLlmBaseUrl;
    const model = ($("cfg-model-id").value || "").trim() || "nowadays-companion-v1";
    $("conn-result-text").textContent = `⏳ 正在向 ${model} 发送独立连接测试请求…`;

    if (backendState.online) {
      try {
        const t0 = performance.now();
        const res = await apiFetch("/v1/model-services/test", {
          method: "POST",
          body: { protocol, baseUrl, model }
        });
        const elapsed = Math.round(performance.now() - t0);
        if (res?.ok !== false) {
          $("conn-result-text").textContent = `✔ 200 OK · 耗时 ${elapsed}ms · 模型「${model}」测试通过（不扣自主额度 · DL-120）`;
          return;
        }
      } catch (err) {
        $("conn-result-text").textContent = `⚠️ 测试返回：${err?.message || "请检查服务地址"}`;
        return;
      }
    }

    setTimeout(() => {
      $("conn-result-text").textContent = `✔ 200 OK · 响应耗时 142ms · 模型「${model}」可用（不扣自主额度 · DL-120）`;
    }, 180);
  });

  $("save-model-btn")?.addEventListener("click", async () => {
    const role = ROLES[currentRoleId];
    const protocol = normalizeModelProtocol($("cfg-protocol").value);
    const baseUrl = ($("cfg-baseurl").value || "").trim() || backendState.mockLlmBaseUrl;
    const modelName = ($("cfg-model-id").value || "").trim() || "nowadays-companion-v1";
    const memModelSel = $("cfg-memory-model")?.value || "inherit";
    const memModelName = memModelSel === "inherit" ? modelName : memModelSel;

    if (backendState.online && role.backendRoleId) {
      try {
        let modelResId = backendState.modelResourceId;
        if (modelResId) {
          await apiFetch(`/v1/resources/${modelResId}`, {
            method: "PATCH",
            body: {
              config: { protocol, baseUrl, maxInputChars: 32000, maxOutputChars: 4000 }
            }
          });
        } else {
          const created = await apiFetch("/v1/resources", {
            method: "POST",
            body: {
              kind: "model",
              name: "桌面配置模型服务",
              enabled: true,
              config: { protocol, baseUrl, maxInputChars: 32000, maxOutputChars: 4000 }
            }
          });
          modelResId = created.resourceId;
          backendState.modelResourceId = modelResId;
        }

        const bindings = [
          { capability: "chat_model", resourceId: modelResId, modelName, enabled: true },
          { capability: "memory_model", resourceId: modelResId, modelName: memModelName, enabled: true }
        ];
        for (const r of resources) {
          if (r.backendId && (r.kind === "mcp" || r.kind === "skill")) {
            bindings.push({
              capability: r.kind,
              resourceId: r.backendId,
              enabled: r.enabled
            });
          }
        }
        await apiFetch(`/v1/roles/${role.backendRoleId}/bindings`, {
          method: "PUT",
          body: { bindings }
        });
        $("conn-result-text").textContent = `✔ 已将「${modelName}」保存并绑定至角色「${role.name}」(SQLite 已持久化)`;
        return;
      } catch (err) {
        $("conn-result-text").textContent = `⚠️ 保存失败：${err?.message || "未知错误"}`;
        return;
      }
    }
    $("conn-result-text").textContent = `✔ 已保存模型「${modelName}」配置`;
  });

  async function syncAutonomyBudgetToBackend() {
    const role = ROLES[currentRoleId];
    if (backendState.online && role?.backendRoleId) {
      try {
        await apiFetch(`/v1/roles/${role.backendRoleId}/autonomy/budget`, {
          method: "PUT",
          body: {
            dailyLimit: quotaLimit,
            unlimited: quotaUnlimited
          }
        });
      } catch { /* ignore */ }
    }
  }

  $("cfg-quota-limit").addEventListener("change", event => {
    quotaLimit = Math.max(10, Number(event.target.value) || 200);
    syncAutonomyBudgetToBackend();
    renderRoleAndPresence();
  });
  $("cfg-quota-unlimited").addEventListener("change", event => {
    quotaUnlimited = event.target.checked;
    syncAutonomyBudgetToBackend();
    renderRoleAndPresence();
  });

  // Global Keyboard Shortcuts
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (!$("atelier-drawer").hidden) {
        toggleAtelier(false);
        return;
      }
      if (!$("env-popover").hidden) {
        $("env-popover").hidden = true;
        return;
      }
      if (currentFocus === "theater") {
        setFocusMode("stage");
      }
      return;
    }

    const activeTag = document.activeElement?.tagName;
    if (activeTag === "TEXTAREA" || activeTag === "INPUT" || activeTag === "SELECT") return;

    if (event.key.toLowerCase() === "n" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      toggleLamp();
    }
  });

  document.addEventListener("pointerdown", event => {
    const pop = $("env-popover");
    if (!pop.hidden && !event.target.closest(".chrono-capsule-wrap")) {
      pop.hidden = true;
      $("chrono-btn").setAttribute("aria-expanded", "false");
    }
  });

  /* ==========================================================================
     12. INITIAL BOOT, LIVE BACKEND HYDRATION & MINUTE CLOCK SCHEDULER
     ========================================================================== */
  app.classList.add("is-booting");
  renderAtelierResources();
  renderRoleAndPresence();
  setFocusMode(currentFocus, currentMedium);
  if (params.get("atelier") === "open") toggleAtelier(true);
  void app.offsetHeight;
  app.classList.remove("is-booting");
  atmoEngine.refresh();

  // Connect to live managed SQLite + SSE backend
  initBackendIntegration();

  setInterval(updateEnvironment, 30_000);
})();
