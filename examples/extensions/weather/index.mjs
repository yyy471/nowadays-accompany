export const tools = {
  async query(args, ctx) {
    const city = args.city || ctx.config.city;
    if (!city) throw new Error('请在账号插件配置或调用参数中填写城市。');
    return { status: 'ok', text: `示例天气：${city} 多云，24°C。` };
  }
};
