const fs=require('node:fs'),path=require('node:path');
const sharp=require('C:/Users/24349/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
(async()=>{
 const names=['home','roles','models'];const captions=['主页 / 导航、标题、操作与台词框','角色 / 名册、立绘、表单的层次','模型 / 能力目录、输入与测试反馈'];
 const layers=[];
 for(let row=0;row<names.length;row++)for(let col=0;col<2;col++){
  const input=path.join(__dirname,col===0?'../after-school-letters':'',`preview-${names[row]}.png`);
  const tile=await sharp(input).resize(1100,734,{fit:'contain',background:'#f0f1f7'}).png().toBuffer();
  layers.push({input:tile,left:48+col*1148,top:215+row*820});
 }
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2344" height="2675"><rect width="2344" height="2675" fill="#f0f1f7"/><text x="48" y="66" fill="#283149" font-family="Microsoft YaHei" font-size="33">放课后通信 / UI 精修前后对照</text><text x="48" y="106" fill="#70788c" font-family="Microsoft YaHei" font-size="18">两版使用完全相同的原画，只比较界面、字体与控件。</text><text x="48" y="163" fill="#70788c" font-family="Microsoft YaHei" font-size="22">精修前</text><text x="1196" y="163" fill="#5966ad" font-family="Microsoft YaHei" font-size="22">精修后</text>${captions.map((t,i)=>`<text x="48" y="${197+i*820}" fill="#70788c" font-family="Microsoft YaHei" font-size="16">${t}</text>`).join('')}</svg>`);
 await sharp(svg).composite(layers).jpeg({quality:95}).toFile(path.join(__dirname,'before-after.jpg'));
 const tiles=await Promise.all(names.map(n=>sharp(path.join(__dirname,`preview-${n}.png`)).resize(1100,734,{fit:'contain',background:'#f0f1f7'}).png().toBuffer()));
 const board=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2344" height="1818"><rect width="2344" height="1818" fill="#f0f1f7"/><text x="48" y="74" fill="#283149" font-family="Microsoft YaHei" font-size="39">放课后通信 / UI 精修</text><text x="48" y="117" fill="#70788c" font-family="Microsoft YaHei" font-size="19">保留角色与场景 · 统一字级、圆角、深度与操作反馈</text><text x="48" y="174" fill="#283149" font-family="Microsoft YaHei" font-size="18">01 首页</text><text x="1196" y="174" fill="#283149" font-family="Microsoft YaHei" font-size="18">02 角色档案</text><text x="48" y="1007" fill="#283149" font-family="Microsoft YaHei" font-size="18">03 模型设定</text><text x="1260" y="1200" fill="#5966ad" font-family="Microsoft YaHei" font-size="48">同样的画面，</text><text x="1260" y="1285" fill="#283149" font-family="Microsoft YaHei" font-size="48">更清楚的界面。</text><text x="1260" y="1400" fill="#70788c" font-family="Microsoft YaHei" font-size="23">现代功能字体 / 统一控件 / 稳定布局</text><text x="1260" y="1460" fill="#70788c" font-family="Microsoft YaHei" font-size="19">独立设计原型，全部为示例数据</text></svg>`);
 await sharp(board).composite([{input:tiles[0],left:48,top:200},{input:tiles[1],left:1196,top:200},{input:tiles[2],left:48,top:1036}]).jpeg({quality:95}).toFile(path.join(__dirname,'design-board.jpg'));
 console.log('Created three-page board and original/refined comparison.');
})().catch(e=>{console.error(e);process.exitCode=1});
