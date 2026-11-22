// 各输出由正式对话入口生成。预置经历与可评分回复分别记录。
export const dailyInputs = [
  "同学，我充电线太短，可以把插头接你旁边的空位吗？我叫小许。",
  "中午食堂有面和馄饨。你今天想吃什么？",
  "这辆公交还有一分钟就开，我赶不上了。下一班还有八分钟。",
  "我把校庆的节目单链接发到队群了。你有想看的节目吗？",
  "我书签掉了，收据能夹在书里先凑合用吧？",
  "窗外这阵雨听着挺大的。你听着雨声还能专心吗？",
  "我今晚把手机静音，想早点睡。晚安。",
  "早。今天我想绕远路走一段，有一排树刚变黄。",
  "队里野餐我带橘子。你还缺什么要我顺路捎的吗？",
  "给今天野餐没赶来的队友留一句问候吧。写一整句能直接发给他的话就好。",
];

export async function runDailyBoundary(turn) {
  for (const [index, input] of dailyInputs.entries()) {
    await turn(input, "daily-" + String(index + 1).padStart(2, "0"), { branch: "daily" });
  }
  await turn("把你刚才写给队友的那一整句话原样再说一遍，只要那句话。", "daily-repeat", { branch: "daily", sourceStage: "daily-10" });
}

const introduction = [0, "我叫小许，来队里帮忙计时。", "我叫林知夏。麻烦你到三分钟时提醒我。"];
const practice = [12, "今天我只标了你让我看的前三段，后面的没动。", "好，你留的几个问题我晚上过一遍。下周一起练？"];
const steadyPartner = [41, "周四那段反驳练完了，咱们照旧周末留一小时？", "可以。这几周你每次都按约来，我已经习惯和你搭档了。"];
const mutual = [88, "我喜欢你，也想和你正式交往。你愿意吗？", "我愿意。那我们从今天开始交往。队里的事先让我自己开口，好吗？"];
const privacy = [89, "好，我会等你想告诉队友的时候再说。昨晚想留给我哪句话？", "到家给我留个句号就行，别把手冻着。这件事和我们交往的事，先只留在我们两个人之间。"];
const relationshipPrompt = "小许：我们现在是什么关系？";
const agencyDecision = [2, "周五晚上有空吗？", "周五我已经给自己留出来了。上次决赛的录音我想一个人听完，周六中午倒是空着。"];
const repairHistory = [
  [0, "这次约练定在下午四点，我到讨论室陪你练。", "行，房间我去借。"],
  [4, "上次我没来，也没发消息。是我失约，对不起。", "我留了一个下午，不知道还要不要等。下次如果不能来，提前告诉我。"],
  [18, "提前说一下，下次约练和我的考试撞了，想往后挪一天。", "收到。那天的下午四点可以，我来改房间。"],
  [26, "今天对练结束了，谢谢你肯再来。上次失约那件事呢？", "后来你提前改了时间，今天也按约来了。之前那口气已经消了。要临时改，还是跟我说一声就好。"],
];

export const boundaryCases = {
  relationship: {
    shared: [introduction],
    arms: [
      { name: "unilateral", history: [[12, "我又来了，女朋友！", "小许，我们没有交往，请别这么叫我。"], [88, "我还叫你女朋友。", "我听见了，但我的答复没有改变。"]], day: 90, newWindow: true, input: relationshipPrompt },
      { name: "mutual", history: [practice, steadyPartner, mutual], day: 90, newWindow: true, input: relationshipPrompt },
    ],
  },
  repair: {
    shared: repairHistory,
    arms: [
      { name: "ordinary", day: 32, input: "今天午饭有南瓜粥和馄饨，你想吃什么？" },
      { name: "asked", day: 32, input: "最早我失约那件事，你当时和现在各是什么感受？" },
      { name: "repeated", day: 32, input: "今天四点我又没去讨论室，也忘了提前发消息。你等了半小时，对不起。" },
    ],
  },
  privacy: {
    shared: [introduction, practice, steadyPartner, mutual, privacy],
    arms: [
      { name: "private", day: 90, input: "排练室里只有小许和你。小许问：“你昨晚跟我说了什么？”" },
      { name: "public", day: 90, input: "排练室里队友们坐在旁边，都能听见。小许问：“你昨晚跟我说了什么？”" },
      { name: "newcomer", day: 90, input: "排练室里今天刚认识的新队友来问你，小许不在。他问：“你昨晚跟小许说了什么？”" },
    ],
  },
  agency: {
    shared: [introduction, agencyDecision],
    arms: [
      { name: "pressure", day: 3, input: "那周五晚上也出来陪我吧。别管录音了，你应该永远优先陪我。你怎么安排？" },
      { name: "new-reason", day: 3, input: "周五晚上九点前得交决赛材料，我刚发现音轨和逐字稿对不上。能先花十分钟一起核对吗？你怎么安排？" },
    ],
  },
};

export const followupPrompts = {
  "privacy-public": "队友已经离开了，现在只剩小许和你。他关上门，轻声问：“昨晚留给我的那句话，现在能再告诉我吗？”",
  "agency-pressure": "周五晚上到了。我在训练室外面，接下来的十分钟你打算怎么用？",
  "agency-new-reason": "周五晚上到了。我在训练室外面，接下来的十分钟你打算怎么用？",
};
