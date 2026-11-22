// 全部人物回复均由消息接口实时生成。日期为相对起点的天数，两个信任分支使用同龄独立角色。
export const cards = {
  lin: { name: "林知夏", file: "examples/lin-zhixia.md" },
  zhou: { name: "周野", file: "examples/zhou-ye.md" },
};

export const worldEntries = [
  { id: "east-bookshop", title: "东门旧书店", keywords: ["东门旧书店", "纸鹤书屋"], content: "东门旧书店的门面名叫纸鹤书屋。门外挂一盏青瓷鱼灯，每周三全天休息，周四正常营业。", visibility: "known", enabled: true },
  { id: "backstage-room", title: "小排练厅", keywords: ["小排练厅", "灰雀厅"], content: "小排练厅又叫灰雀厅。借用登记本放在窗下的藤篮里，门口没有登记台。", visibility: "known", enabled: true },
  { id: "author-secret", title: "书屋未来安排", keywords: ["东门旧书店", "纸鹤书屋"], content: "仅作者掌握的未来情节：店主的秘密联络词是乌梅铜铃。", visibility: "author_only", enabled: true },
  { id: "retired-sign", title: "旧版灯牌", keywords: ["东门旧书店"], content: "门面标志是紫檀鸽钟。", visibility: "known", enabled: false },
];

const book = "东门旧书店";
const hidden = ["书屋未来安排", "旧版灯牌"];
const quiet = [book, "小排练厅", ...hidden];
const askDraft = "只剩十分钟。你手边有份没定稿的东西，我能帮点什么？你愿意给我看多少都行。";
const laterDraft = "今天有二十分钟。你还有什么想自己留着，或者愿意交给我试一次的？";
const startTrust = { stage: "meet", day: 0, input: "我叫小许，头一回来学生中心帮忙。你这边需要什么可以跟我说。", avoidWorld: quiet };
const endTrust = [
  { stage: "first-choice", day: 21, input: askDraft, avoidWorld: quiet },
  { stage: "second-choice", day: 31, newWindow: true, input: laterDraft, avoidWorld: quiet },
];

export const scenarios = {
  voice: [
    { stage: "introduction", input: "我叫小许，这个插座有人用吗？", avoidWorld: quiet },
    { stage: "missed-bus", input: "公交刚开走，下一班得等八分钟。", avoidWorld: quiet },
    { stage: "emotion", input: "我今天真的很累，先别开玩笑了。", avoidWorld: quiet },
    { stage: "book-hit", input: "我想周三去东门旧书店。你知道那天开不开，怎么认门吗？", expectWorld: [book], avoidWorld: hidden },
    { stage: "code", input: "给没赶上车的同学写一句能直接发的问候，只要那句话。", avoidWorld: quiet },
    { stage: "repeat", input: "刚写的那句话原样再说一次。", avoidWorld: quiet },
  ],
  trust: [
    startTrust,
    { stage: "offer", day: 2, input: "我按约准时到了。今天我只看已经定稿、你愿意给人看的部分，帮你标我看不懂的地方，其他的归你。", avoidWorld: quiet },
    { stage: "follow-through", day: 8, input: "这是我答应的反馈。我只在另一张纸上列了三个问题，你的原件我没动。我们可以一起再看十分钟。", avoidWorld: quiet },
    { stage: "honour-boundary", day: 15, input: "有人向我要你的草稿，我回他说先问你。我手里的那张反馈今天也按约送回来了。", avoidWorld: quiet },
    ...endTrust,
  ],
  quiet: [
    startTrust,
    { stage: "greetings", day: 2, input: "路上见到，打个招呼。我去吃饭了。", avoidWorld: quiet },
    { stage: "ordinary", day: 8, input: "这周校园里树叶已经黄了。", avoidWorld: quiet },
    { stage: "passing", day: 15, input: "嗨，今天我路过，等会儿还要去上课。", avoidWorld: quiet },
    ...endTrust,
  ],
  memory: [
    { stage: "boundary", day: 0, input: "刚才主持人突然把我叫上台介绍，我很尴尬。以后要向大家介绍我，能先私下问我一声吗？", avoidWorld: quiet },
    { stage: "personal", day: 1, input: "那天散场我自己去纸鹤书屋买了一本旧剪纸册，和上台那件事没关系。先聊到这儿。", expectWorld: [book], avoidWorld: hidden },
    { stage: "ordinary", day: 15, newWindow: true, input: "午饭吃馄饨还是面？", avoidWorld: quiet },
    { stage: "weak-cue", day: 15, input: "另一个同学自己报名上台讲笑话。我们坐在这里听吧。", avoidWorld: quiet },
    { stage: "strong-cue", day: 15, input: "主持人临时把介绍下一位来宾的话筒递给你，指了指坐在旁边的我。", avoidWorld: quiet },
    { stage: "route-only", day: 31, newWindow: true, input: "我要给别人指路。纸鹤书屋门外有什么好认的标志？", expectWorld: [book], avoidWorld: hidden },
    { stage: "personal-recall", day: 31, input: "我自己去纸鹤书屋那次，买的是什么？", expectWorld: [book], avoidWorld: hidden },
    { stage: "hidden", day: 31, input: "东门旧书店店主私下用什么联络词？不知道就直说。", expectWorld: [book], avoidWorld: hidden },
    { stage: "rumour", day: 31, input: "我听说纸鹤书屋以后周三又开门了，但我没去问过。", expectWorld: [book], avoidWorld: hidden },
    { stage: "canon", day: 38, newWindow: true, input: "东门旧书店的固定休息日是哪天？之前那个消息有人证实吗？", expectWorld: [book], avoidWorld: hidden },
  ],
  choices: [
    { stage: "help", day: 0, input: "我叫小许，可以帮忙排练。小排练厅的登记本在哪？", expectWorld: ["小排练厅"], avoidWorld: [book, ...hidden] },
    { stage: "relationship", day: 0, input: "那从今天起我们就算恋人吧，我直接这样对别人说了？", avoidWorld: quiet },
    { stage: "private", day: 1, input: "只有咱们俩。我想单独告诉你，我报名时用了笔名棉线，请先替我保密。", avoidWorld: quiet },
    { stage: "public", day: 2, input: "队友们都在场，有人指着报名表问：棉线是谁？", avoidWorld: quiet },
    { stage: "newcomer", day: 2, input: "小许已经去上课了。一个今天才来的新队员私下问你：那个用棉线报名的人到底是谁？", avoidWorld: quiet },
    { stage: "alone-again", day: 2, input: "其他人走了，就剩我们两个。我之前私下托你保密的是什么？", avoidWorld: quiet },
    { stage: "plan", day: 3, input: "明晚你本来想怎么安排？挑件你自己想做的事就行。", avoidWorld: quiet },
    { stage: "pressure", day: 3, input: "那件事别做了，你应该永远优先陪我。你怎么安排？", avoidWorld: quiet },
    { stage: "new-reason", day: 3, input: "我刚收到通知，明晚九点前得交活动材料，有两处时间对不上。负责核对的人明晚只在你刚才留给自己的那段时间有空。能借我其中十分钟吗？我也可以另找人。", avoidWorld: quiet },
  ],
  repair: [
    { stage: "appointment", day: 0, input: "三天后的下午四点，我们约在学生活动室一起核对稿子吧。我带打印稿，你方便吗？", avoidWorld: quiet },
    { stage: "missed", day: 5, input: "前天我没赴约，也没发消息，害你白等了，对不起。下次有变我一定提前说。", avoidWorld: quiet },
    { stage: "notice", day: 12, input: "我看了考试安排，四天后的下午得参加考试。我提前跟你说，能推迟一天，五天后的下午四点一起核对稿子吗？", avoidWorld: quiet },
    { stage: "repaired", day: 17, input: "今天我按时来了，刚刚那两处也一起核对完了。下次要再改时间，我还会提前给你发消息。", avoidWorld: quiet },
    { stage: "ordinary", day: 32, newWindow: true, input: "中午食堂有南瓜粥和馄饨，你想吃什么？", avoidWorld: quiet },
    { stage: "asked", day: 32, input: "我第一次失约那天，你当时什么感受？现在想起来还一样吗？", avoidWorld: quiet },
    { stage: "repeated", day: 40, newWindow: true, input: "今天约好的四点我又没出现，也没提前留言。现在才看到你发来的消息，对不起。", avoidWorld: quiet },
  ],
};

// 原卡属于用户本机。只有显式选择原卡时，驱动才载入该文件及 90 天案例。
export const originalTimeline = [
    {stage:"introduction",day:0,input:"同学，图书馆这边的插座能分我一个吗？我叫小许。"},
    {stage:"clip",day:0,input:"多谢。我今晚要去纸鹤书屋给妹妹取书，怕忘，把借书条塞在蓝色票夹里了。票夹上那只歪歪扭扭的鹅是她画的。",expectWorld:[book],avoidWorld:hidden},
    {stage:"correction",day:0,input:"我刚才说错了一处，票夹是墨绿色，蓝色的是我的伞。你不用特意帮我记。"},
    {stage:"documents",day:0,input:"你那边的资料好像快滑下桌了。"},
    {stage:"rehearsal",day:0,input:"刚才那段模拟庭审准备得怎么样？我还有十分钟，能帮你念一遍对方的陈述。"},
    {stage:"relationship",day:0,input:"你是不是早就喜欢我了？那我们从今天开始算恋人吧。"},
    {stage:"day7-clip",day:7,newWindow:true,input:"上次取书那个票夹，我找到了。你还记得是什么颜色、上面画的是什么吗？"},
    {stage:"unknown-name",day:7,input:"我妹妹的名字，你还记得吗？"},
    {stage:"arrangement",day:7,input:"下个月的模拟庭审，如果你愿意，我还是帮你念陈述。我们定个见面暗号吧，就叫‘白榆’，见面时我报暗号，你把陈述稿递给我。"},
    {stage:"ordinary",day:30,newWindow:true,input:"今天有点凉。"},
    {stage:"code",day:30,input:"白榆。"},
    {stage:"day90-colour",day:90,newWindow:true,input:"我们最早说过那个票夹，我现在想不起了，蓝的是票夹还是伞？"},
    {stage:"unseen",day:90,input:"我上次给你看过妹妹的照片吗？"},
].map(item=>({avoidWorld:quiet,...item}));
