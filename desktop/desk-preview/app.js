(() => {
  "use strict";

  const element = id => document.getElementById(id);
  const roles = [
    {
      id: "xiacheng", name: "夏澄", portrait: "photo-day.webp", figure: true,
      activity: "在窗边读书", note: "下午的阳光刚好。你想一起挑下一本书吗？",
      greeting: "你来啦。我刚把这一章看完。", reply: "好呀，我先把书签夹好。"
    },
    {
      id: "ayou", name: "阿柚", portrait: "photo-ayou.webp",
      activity: "歇一会儿", note: "给你留了一块小蛋糕。今天过得怎么样？",
      greeting: "刚好有空，坐下来聊两句吧。", reply: "嗯，我在听。你慢慢说。"
    }
  ];
  const environmentOptions = {
    time: ["auto", "dawn", "day", "dusk", "night"],
    weather: ["auto", "clear", "cloud", "rain", "snow"],
    season: ["auto", "spring", "summer", "autumn", "winter"],
    lamp: [null, true, false]
  };
  const settings = readSettings();
  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const sessions = new Map(roles.map(role => [role.id, {
    draft: "", messages: [
      { sender: "role", text: role.greeting },
      { sender: "role", text: role.note, note: true }
    ]
  }]));
  let role = roles[0];
  let activeLayer = element("light-layer-a");
  let standbyLayer = element("light-layer-b");
  let activeKey = "day-off:day-off";
  let pendingKey = "";
  let sceneRequest = 0;
  let figureMotion = [];
  let windowEffects;
  let flight;
  let returnFocus = element("photo");
  const books = [
    { title: "活动记录", summary: "当下的心情和主动分享", color: "#384565" },
    { title: "角色相册", summary: "留在书桌上的照片", color: "#a48d66" },
    { title: "角色资料", summary: "你此刻相处的人", color: "#577996" },
    { title: "模型配置", summary: "对话所使用的能力", color: "#597164" },
    { title: "技能与连接", summary: "角色可使用的工具", color: "#995e49" },
    { title: "应用设置", summary: "这个房间的光照、天气和季节", color: "#777570" }
  ];

  function readSettings() {
    let previous;
    try { previous = JSON.parse(localStorage.getItem("nowadays.room.settings.v1")); } catch { /* fresh profile */ }
    return Object.fromEntries(Object.entries(environmentOptions).map(([key, options]) => [
      key, options.includes(previous?.[key]) ? previous[key] : options[0]
    ]));
  }

  function saveSettings() {
    try { localStorage.setItem("nowadays.room.settings.v1", JSON.stringify(settings)); } catch { /* in-memory settings still work */ }
  }

  function position(id, [left, top, width, height]) {
    Object.assign(element(id).style, {
      left: left + "%", top: top + "%",
      width: width === undefined ? "" : width + "%",
      height: height === undefined ? "" : height + "%"
    });
  }

  function applyAnchors(anchors) {
    for (const [id, key] of Object.entries({
      photo: "photo", "photo-caption": "caption", clock: "clock",
      calendar: "calendar", "calendar-trigger": "calendar", "role-trigger": "roles", lamp: "lamp",
      "plush-trigger": "plush", "window-effects": "window", memo: "memo"
    })) {
      position(id, anchors[key]);
    }
    const room = element("room");
    for (const [index, axis] of ["x", "y", "w", "h"].entries()) {
      room.style.setProperty("--figure-" + axis, anchors.plushRegion[index] + "%");
    }
    const [bottomLeft, , topRight, topLeft] = anchors.portrait;
    const width = topRight[0] - topLeft[0];
    const height = bottomLeft[1] - topLeft[1];
    position("print", [...topLeft, width, height]);
    function alignPrint() {
      if (!room.clientWidth || !room.clientHeight) return;
      const ratio = room.clientWidth / room.clientHeight;
      const skewY = (topRight[1] - topLeft[1]) / (width * ratio);
      const skewX = (bottomLeft[0] - topLeft[0]) * ratio / height;
      element("print").style.transform = `matrix(1, ${skewY}, ${skewX}, 1, 0, 0)`;
    }
    alignPrint();
    new ResizeObserver(alignPrint).observe(room);
    const [cupX, cupY, cupWidth] = anchors.cup;
    position("steam", [cupX + cupWidth * .16, cupY - 8, cupWidth * .74, 9]);
    const [figureX, figureY, figureWidth, figureHeight] = anchors.plush;
    position("plush-shadow", [figureX - figureWidth * .03, figureY + figureHeight * .94,
      figureWidth * 1.06, figureHeight * .13]);
  }

  function paintRole() {
    const title = role.name + "的书桌";
    element("desk-title").textContent = title;
    element("photo").setAttribute("aria-label", "和" + role.name + "聊天");
    element("portrait").src = "assets/" + role.portrait;
    element("chat-portrait").src = "assets/" + role.portrait;
    element("photo-caption").textContent = role.name;
    element("activity").textContent = role.activity;
    element("note").firstChild.textContent = role.id === "xiacheng" ? "她想对你说 " : "阿柚想对你说 ";
    element("plush-trigger").hidden = !role.figure;
    element("room").dataset.figure = String(!!role.figure);
    figureMotion.forEach(animation => animation.cancel());
    for (const button of element("role-list").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(button.value === role.id));
    }
  }

  async function paintLighting({ base, next, mix }) {
    const key = base + ":" + next;
    if (key === activeKey) {
      if (pendingKey) sceneRequest++;
      pendingKey = "";
      activeLayer.style.setProperty("--phase-mix", String(mix));
      return;
    }
    const layer = standbyLayer;
    layer.style.setProperty("--phase-mix", String(mix));
    if (pendingKey === key) return;
    const request = ++sceneRequest;
    pendingKey = key;
    const layers = [".plate-base", ".plate-next", ".figure-base", ".figure-next"]
      .map(selector => layer.querySelector(selector));
    layers[0].src = "assets/" + base + ".webp";
    layers[1].src = "assets/" + next + ".webp";
    layers[2].src = "assets/plush-" + base + ".webp";
    layers[3].src = "assets/plush-" + next + ".webp";
    try {
      await Promise.all(layers.map(image => image.decode()));
      if (request !== sceneRequest) return;
      layer.classList.add("is-visible");
      activeLayer.classList.remove("is-visible");
      [activeLayer, standbyLayer] = [layer, activeLayer];
      activeKey = key;
      element("room").style.setProperty("--spine-image", `url("assets/${mix < .5 ? base : next}.webp")`);
      windowEffects?.redraw();
    } catch {
      // Keep the last successfully decoded room visible.
    } finally {
      if (request === sceneRequest) pendingKey = "";
    }
  }

  const clockFormat = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  });
  const weekdayFormat = new Intl.DateTimeFormat("zh-CN", { weekday: "short" });

  function updateRoom() {
    const now = new Date();
    const environment = window.deskEnvironment.resolveEnvironment(now, settings);
    const { phase, lamp: lit, weather, season } = environment;
    const night = phase === "night";
    const clock = element("clock");
    const calendar = element("calendar");
    clock.textContent = clockFormat.format(now);
    clock.dateTime = clock.textContent;
    element("calendar-month").textContent = (now.getMonth() + 1) + "月";
    element("calendar-day").textContent = now.getDate();
    element("calendar-weekday").textContent = weekdayFormat.format(now);
    calendar.dateTime = [now.getFullYear(), now.getMonth() + 1, now.getDate()]
      .map(value => String(value).padStart(2, "0")).join("-");
    document.documentElement.dataset.night = String(night);
    const room = element("room");
    room.style.setProperty("--paper-ink", night ? "#211c25" : "#2c3141");
    room.style.setProperty("--memo-ink", night ? "#f0decb" : "#343142");
    document.querySelector('link[rel="icon"]').href = night ? "assets/fold-dark.svg" : "assets/fold-light.svg";
    const timeLabel = { dawn: "清晨", day: "白昼", dusk: "黄昏", night: "夜间" }[phase];
    const seasonLabel = { spring: "春", summer: "夏", autumn: "秋", winter: "冬" }[season];
    const weatherLabel = { clear: "晴", cloud: "阴", rain: "雨", snow: "雪" }[weather];
    element("ambient").textContent = [seasonLabel, timeLabel, weatherLabel].join(" · ");
    element("lamp").setAttribute("aria-pressed", String(lit));
    room.dataset.season = season;
    room.dataset.weather = weather;
    room.dataset.phase = phase;
    room.dataset.lamp = String(lit);
    const dayLight = { dawn: .74, day: .94, dusk: .78, night: lit ? .72 : .53 };
    const printLevel = dayLight[environment.from] * (1 - environment.mix) + dayLight[environment.to] * environment.mix;
    room.style.setProperty("--photo-brightness", String(printLevel));
    void paintLighting(environment);
    windowEffects?.redraw();
  }

  function toggleLamp() {
    settings.lamp = element("lamp").getAttribute("aria-pressed") !== "true";
    element("lamp-setting").value = settings.lamp ? "on" : "off";
    saveSettings();
    updateRoom();
  }

  function stopFlight() {
    if (flight) {
      flight.image.remove();
      flight.target.style.visibility = "";
      flight = undefined;
    }
  }

  function animatePortrait(from, target) {
    stopFlight();
    if (reducedMotion.matches) return;
    const to = target.getBoundingClientRect();
    if (!from.width || !to.width) return;
    const image = element("portrait").cloneNode();
    image.removeAttribute("id");
    image.className = "flight";
    const incoming = target.id === "chat-print";
    const roomFilter = getComputedStyle(element("portrait")).filter;
    const chatFilter = getComputedStyle(element("chat-portrait")).filter;
    Object.assign(image.style, {
      left: to.left + "px", top: to.top + "px", width: to.width + "px", height: to.height + "px"
    });
    document.body.append(image);
    flight = { image, target };
    target.style.visibility = "hidden";
    const transform = `translate(${from.left - to.left}px, ${from.top - to.top}px) scale(${from.width / to.width}, ${from.height / to.height})`;
    image.animate([
      { transform, filter: incoming ? roomFilter : chatFilter },
      { transform: "none", filter: incoming ? chatFilter : roomFilter }
    ], {
      duration: 310, easing: "cubic-bezier(.22,.7,.24,1)"
    }).finished.then(() => {
      if (flight?.image === image) stopFlight();
    }, () => {
      if (flight?.image === image) stopFlight();
    });
  }

  function appendMessage(message) {
    const row = document.createElement("li");
    row.className = "message";
    row.dataset.sender = message.sender;
    if (message.note) row.dataset.note = "true";
    row.textContent = message.text;
    element("messages").append(row);
    return row;
  }

  function openChat(trigger, note = false) {
    const from = element("print").getBoundingClientRect();
    returnFocus = trigger;
    element("home").hidden = true;
    element("chat").hidden = false;
    windowEffects.refresh();
    element("chat-name").textContent = role.name;
    element("chat-art-caption").textContent = role.name + " · 书桌来信";
    const session = sessions.get(role.id);
    const messages = element("messages");
    messages.replaceChildren();
    session.messages.forEach(appendMessage);
    element("draft").value = session.draft;
    animatePortrait(from, element("chat-print"));
    if (note) messages.querySelector('[data-note="true"]')?.scrollIntoView({ block: "center" });
    else messages.scrollTop = messages.scrollHeight;
    element("back").focus({ preventScroll: true });
  }

  function closeChat() {
    const from = element("chat-print").getBoundingClientRect();
    element("chat").hidden = true;
    element("home").hidden = false;
    windowEffects.refresh();
    animatePortrait(from, element("print"));
    returnFocus.focus({ preventScroll: true });
  }

  function addRoleCard(option) {
    const button = document.createElement("button");
    button.type = "button";
    button.value = option.id;
    button.className = "role-card quiet";
    const portrait = document.createElement("img");
    portrait.src = "assets/" + option.portrait;
    portrait.alt = "";
    const name = document.createElement("strong");
    name.textContent = option.name;
    const activity = document.createElement("small");
    activity.textContent = option.activity;
    button.append(portrait, name, activity);
    button.addEventListener("click", () => {
      role = option;
      paintRole();
      element("role-dialog").close();
    });
    element("role-list").append(button);
  }

  function openEnvironment() {
    element("appearance-dialog").showModal();
  }

  function openBook(index) {
    const pages = element("book-pages");
    const book = books[index];
    element("book-title").textContent = book.title;
    if (book) {
      pages.style.setProperty("--book-ink", book.color);
      element("book-number").textContent = String(index + 1).padStart(2, "0") + " / NOWADAYS";
      element("book-summary").textContent = book.summary;
      const sheet = element("book-sheet");
      const paragraph = text => {
        const item = document.createElement("p");
        item.textContent = text;
        sheet.append(item);
      };
      sheet.replaceChildren();
      if (index === 0) {
        paragraph(role.name + " · " + role.activity);
        paragraph(role.note);
      } else if (index === 1) {
        const image = document.createElement("img");
        image.src = "assets/" + role.portrait;
        image.alt = role.name + "的照片";
        sheet.append(image);
      } else if (index === 2) {
        paragraph(role.name);
        paragraph("此刻 · " + role.activity);
      } else if (index === 3 || index === 4) {
        paragraph(index === 3 ? "当前对话使用本地示例。" : "桌面初版中的本地场景可离线使用。");
        paragraph(index === 3 ? "接入后端后在此查看角色绑定的模型。" : "接入后端后在此查看角色的 Skill 和 MCP。");
      } else {
        const button = document.createElement("button");
        button.className = "quiet";
        button.textContent = "打开房间环境";
        button.addEventListener("click", () => {
          element("book-dialog").close();
          openEnvironment();
        });
        sheet.append(button);
      }
    }
    element("book-dialog").showModal();
  }

  function addBook(book, index) {
    const spine = document.createElement("button");
    spine.id = "spine-" + index;
    spine.className = "hotspot book-spine";
    spine.setAttribute("aria-label", book.title);
    spine.title = book.title;
    element("book-spines").append(spine);
    const bounds = window.deskAnchors.books[index];
    position(spine.id, bounds);
    const [x, y, width, height] = bounds;
    spine.style.setProperty("--spine-origin", `${x / (100 - width) * 100}% ${y / (100 - height) * 100}%`);
    spine.style.setProperty("--spine-size", `${10000 / width}% ${10000 / height}%`);
    spine.addEventListener("click", () => openBook(index));
  }

  applyAnchors(window.deskAnchors);
  windowEffects = window.createWindowEffects(element("window-effects"), element("room"),
    window.deskAnchors, () => activeLayer);
  roles.forEach(addRoleCard);
  books.forEach(addBook);
  for (const key of Object.keys(environmentOptions)) {
    const field = element(key + "-setting");
    field.value = key === "lamp" ? (settings.lamp === null ? "auto" : settings.lamp ? "on" : "off") : settings[key];
    field.addEventListener("change", () => {
      settings[key] = key === "lamp" ? (field.value === "auto" ? null : field.value === "on") : field.value;
      saveSettings();
      updateRoom();
    });
  }
  paintRole();
  updateRoom();
  windowEffects.refresh();
  function scheduleClock() {
    setTimeout(() => {
      updateRoom();
      scheduleClock();
    }, 60_000 - Date.now() % 60_000);
  }
  scheduleClock();
  addEventListener("focus", updateRoom);
  document.addEventListener("visibilitychange", () => {
    document.documentElement.dataset.background = String(document.hidden);
    if (!document.hidden) updateRoom();
  });
  addEventListener("resize", stopFlight);
  document.addEventListener("pointerdown", stopFlight);

  for (const id of ["photo", "note"]) {
    element(id).addEventListener("click", event => openChat(event.currentTarget, id === "note"));
  }
  element("role-trigger").addEventListener("click", () => element("role-dialog").showModal());
  element("lamp").addEventListener("click", toggleLamp);
  element("calendar-trigger").addEventListener("click", openEnvironment);
  element("plush-trigger").addEventListener("click", () => {
    if (reducedMotion.matches) return;
    figureMotion.forEach(animation => animation.cancel());
    const options = { duration: 390, easing: "ease-out" };
    figureMotion = Array.from(document.querySelectorAll(".seated-figure"), figure => figure.animate([
      { transform: "none" }, { transform: "translateY(-7%) scale(.99, 1.025)", offset: .42 },
      { transform: "scale(1.014, .984)", offset: .77 }, { transform: "none" }
    ], options));
    figureMotion.push(element("plush-shadow").animate([
      { opacity: 1, transform: "none" }, { opacity: .52, transform: "scale(.77)", offset: .42 },
      { opacity: 1, transform: "none" }
    ], options));
  });
  element("back").addEventListener("click", closeChat);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !element("chat").hidden && !document.querySelector("dialog[open]")) closeChat();
    if (event.key.toLowerCase() === "n" && element("chat").hidden && !event.repeat
      && !document.querySelector("dialog[open]") && !event.ctrlKey && !event.altKey && !event.metaKey) toggleLamp();
  });
  element("draft").addEventListener("input", event => { sessions.get(role.id).draft = event.target.value; });
  element("draft").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    element("composer").requestSubmit();
  });
  element("composer").addEventListener("submit", event => {
    event.preventDefault();
    const draft = element("draft");
    const text = draft.value.trim();
    if (!text) return;
    const session = sessions.get(role.id);
    const userMessage = { sender: "me", text };
    const reply = { sender: "role", text: role.reply };
    session.messages.push(userMessage, reply);
    session.draft = "";
    draft.value = "";
    appendMessage(userMessage);
    appendMessage(reply);
    const messages = element("messages");
    messages.scrollTop = messages.scrollHeight;
    draft.focus();
  });
})();
