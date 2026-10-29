import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import postcss from 'postcss';
const root=fileURLToPath(new URL('../../',import.meta.url));
const source=path.join(root,'devDoc/design/relationship-journal/reference/assets');
const target=path.join(root,'desktop/renderer/src/assets/relationship-journal');
await fs.mkdir(target,{recursive:true});
for(const name of ['hand.woff','title.woff','FONTS-LICENSE.txt'])await fs.copyFile(path.join(source,'fonts',name),path.join(target,name));
const sandbox={window:{}};vm.runInNewContext(await fs.readFile(path.join(source,'js/art.js'),'utf8'),sandbox);
for(const look of ['clerk','host','post','keeper','garden','announcer'])await fs.writeFile(path.join(target,look+'.svg'),sandbox.window.WJArt.portrait(look,'wj-'+look).replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" '));
const document=JSON.parse(await fs.readFile(path.join(root,'devDoc/design/character-studio/tokens.json'),'utf8'));
const raw={handFont:'"WJ Hand", "KaiTi", "STKaiti", sans-serif',titleFont:'"WJ Title", "SimSun", serif'};
let css='/* 原貌迁移：来自冻结的 wiring-journal-radio-v3。限定作用域；数值由正式 token 提供。 */\n';
const omitted=/^(?:\.shell|\.top(?:\b|-)|\.brand|\.theme-sw|\.foot\b|\.dock(?:\b|-)|\.runtime|\.edition|\.icon-btn\b)/;
const styleNames=['base','stage','day','night','ov','spec','cf','fx'];
const animationNames=new Set();
for(const name of styleNames){const ast=postcss.parse(await fs.readFile(path.join(source,'css',name+'.css'),'utf8'));ast.walkAtRules(rule=>{if(/keyframes$/.test(rule.name))animationNames.add(rule.params);});}
for(const name of styleNames){
  const ast=postcss.parse(await fs.readFile(path.join(source,'css',name+'.css'),'utf8'));
  ast.walkAtRules(rule=>{if(rule.name==='font-face'){rule.walkDecls('src',d=>{d.value=d.value.replace('../fonts/','../assets/relationship-journal/');});}});
  ast.walkRules(rule=>{
    if(rule.parent.type==='atrule'&&/keyframes$/.test(rule.parent.name))return;
    const selectors=rule.selectors.filter(s=>!omitted.test(s.trim()));
    if(!selectors.length){rule.remove();return;}
    rule.selectors=selectors.map(s=>{
      s=s.trim().replace(/\bbtn\b/g,'wj-action');if(s===':root'||s==='html'||s==='body'||s==='html,body')return '.wj-journal';
      if(s.startsWith(':root'))return s.replace(':root','.wj-journal');
      if(s.startsWith('[data-ui-preset'))return s.replace(/^(\[data-ui-preset[^\]]+\])(?:\s+body)?/,'.wj-journal$1');
      return '.wj-journal '+s;
    });
  });
  ast.walkDecls(d=>{
    if(d.prop==='font-family'&&/^"WJ (Hand|Title)"/.test(d.value))return;
    d.value=d.value.replace(/#[0-9a-f]{3,8}\b/gi,color=>{const key='c'+color.slice(1).toLowerCase();raw[key]=color;return `var(--nd-component-relationship-journal-${key})`;});
    d.value=d.value.replace(/\b(\d+(?:\.\d+)?)ms\b/g,(duration,n)=>{const key='duration'+n.replace('.','-');raw[key]=duration;return `var(--nd-component-relationship-journal-${key})`;});
    d.value=d.value.replace(/\b(\d+(?:\.\d+)?)s\b/g,(_,n)=>{const ms=Number(n)*1000,key='duration'+ms;raw[key]=ms+'ms';return `var(--nd-component-relationship-journal-${key})`;});
    if(d.prop==='animation'||d.prop==='animation-name')for(const name of animationNames)d.value=d.value.replace(new RegExp('\\b'+name+'\\b','g'),'wj-'+name);
    if(d.prop==='--hand')d.value='var(--nd-component-relationship-journal-hand-font)';
    if(d.prop==='--title')d.value='var(--nd-component-relationship-journal-title-font)';
  });
  ast.walkAtRules(rule=>{if(/keyframes$/.test(rule.name))rule.params='wj-'+rule.params;});
  css+=ast.toString()+'\n';
}
document.primitive.relationshipJournal=raw;
document.semantic.relationshipJournal=Object.fromEntries(Object.keys(raw).map(k=>[k,'@primitive.relationshipJournal.'+k]));
document.component.relationshipJournal=Object.fromEntries(Object.keys(raw).map(k=>[k,'@semantic.relationshipJournal.'+k]));
await fs.writeFile(path.join(root,'devDoc/design/character-studio/tokens.json'),JSON.stringify(document,null,2)+'\n');
await fs.writeFile(path.join(root,'desktop/renderer/src/ui/relationship-journal.css'),css.trimEnd()+'\n');
console.log('Imported scoped relationship design and tokens');
