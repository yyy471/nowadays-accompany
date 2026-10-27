const path=require('node:path');
const sharp=require('C:/Users/24349/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
(async()=>{
 const views=['home','roles','models'];
 const images=await Promise.all(views.map(v=>sharp(path.join(__dirname,`preview-${v}.png`)).resize(1100,734,{fit:'contain',background:'#f3f0e9'}).png().toBuffer()));
 const svg=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2344" height="1818"><rect width="2344" height="1818" fill="#e4e9f7"/><text x="48" y="78" fill="#344fbd" font-family="Trebuchet MS,Arial" font-weight="bold" font-size="48">SOFT MACHINES / ANIME EDITION</text><text x="48" y="119" fill="#6b7282" font-family="Microsoft YaHei" font-size="20">桌面玩具的布局与控件 × 夏澄的二次元立绘 · 示例数据</text><text x="48" y="174" fill="#273247" font-family="Microsoft YaHei" font-size="18">01 桌面 / 左侧角色，右侧账号与操作</text><text x="1196" y="174" fill="#273247" font-family="Microsoft YaHei" font-size="18">02 关系 / 沿用可展开的配对名册</text><text x="48" y="1007" fill="#273247" font-family="Microsoft YaHei" font-size="18">03 模型 / 沿用五个能力抽屉</text><text x="1260" y="1205" fill="#344fbd" font-family="Trebuchet MS,Arial" font-weight="bold" font-size="91">HELLO,</text><text x="1260" y="1310" fill="#344fbd" font-family="Trebuchet MS,Arial" font-weight="bold" font-size="91">AGAIN.</text><text x="1260" y="1410" fill="#c3574b" font-family="Microsoft YaHei" font-size="26">奶油白 × 钴蓝 × 珊瑚红</text><text x="1260" y="1472" fill="#6b7282" font-family="Microsoft YaHei" font-size="21">顶部账号切换 / 底部 Dock / 按压反馈</text><text x="1260" y="1555" fill="#6b7282" font-family="Microsoft YaHei" font-size="18">只调整二次元表达，保留用户选定的 UI 基底</text></svg>`);
 await sharp(svg).composite([{input:images[0],left:48,top:200},{input:images[1],left:1196,top:200},{input:images[2],left:48,top:1036}]).jpeg({quality:95}).toFile(path.join(__dirname,'design-board.jpg'));
 const layers=[];
 for(let row=0;row<views.length;row++)for(let col=0;col<2;col++){
  const input=await sharp(path.join(__dirname,col===0?'../soft-machines':'',`preview-${views[row]}.png`)).resize(1100,734,{fit:'contain',background:'#f3f0e9'}).png().toBuffer();
  layers.push({input,left:48+col*1148,top:215+row*820});
 }
 const labels=['主页 / 相同的展示与操作结构','关系 / 相同的配对名册','模型 / 相同的能力抽屉'];
 const comparison=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="2344" height="2675"><rect width="2344" height="2675" fill="#f3f0e9"/><text x="48" y="65" fill="#273247" font-family="Microsoft YaHei" font-size="32">桌面玩具 / 原版与二次元版</text><text x="48" y="108" fill="#6b7282" font-family="Microsoft YaHei" font-size="18">保留布局、字号、控件和操作逻辑，调整角色素材与少量配色。</text><text x="48" y="161" fill="#6b7282" font-family="Microsoft YaHei" font-size="21">桌面玩具 · 原版</text><text x="1196" y="161" fill="#344fbd" font-family="Microsoft YaHei" font-size="21">桌面玩具 · 二次元版</text>${labels.map((text,i)=>`<text x="48" y="${197+820*i}" fill="#6b7282" font-family="Microsoft YaHei" font-size="16">${text}</text>`).join('')}</svg>`);
 await sharp(comparison).composite(layers).jpeg({quality:95}).toFile(path.join(__dirname,'toy-anime-comparison.jpg'));
 console.log('Created the three-page board and toy/anime comparison.');
})().catch(e=>{console.error(e);process.exitCode=1});
