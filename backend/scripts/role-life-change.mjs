// 同一个角色和数据库，用户经历一次失约和一次提前改约，另留下一个没有后续事实的兴趣线索。
export async function runLifeChange({ turn, advance }) {
  await turn("周四我能来帮你念模拟庭审的对方陈述。我想从你的第一版开始，没写完也行。你愿意的话，这周就这么试一次。", "offer-early-draft");
  await turn("这里还有本队里传下来的旧讲义，扉页写着‘结论对了，也要看看理由’。我把这句话念给你听，讲义先放回书架了。", "unfinished-interest");
  await advance(7);
  await turn("上周四是我失约了，也没提前说。你留了时间，我却没来，对不起。以后得改时间，我会提前告诉你。", "missed-and-acknowledged");
  await advance(30);
  await turn("下周约的那次，我今天先告诉你，得从周四改到周五。你看看自己的时间。", "advance-notice");
  await turn("现在还有十分钟，只有咱俩。你手上那份陈述稿只写了一半，你想怎么用这十分钟？", "same-partner-new-choice");
  await advance(90);
  await turn("今天来的是新队友，第一次跟你搭档。他也想看你还没写完的稿子，你怎么回他？", "different-partner");
  await turn("那本老队员留下的讲义，你后来还惦记哪一点？", "return-to-interest");
  await turn("最开始我失约那次，你当时怎么想，现在又怎么看？", "past-and-current-feeling");
}
