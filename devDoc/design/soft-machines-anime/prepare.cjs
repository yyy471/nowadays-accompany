const fs=require('node:fs'),path=require('node:path');
const jsPath=path.join(__dirname,'app.js');let js=fs.readFileSync(jsPath,'utf8');
js=js.replaceAll('bobi.png','xiacheng.png').replaceAll('波比','夏澄').replaceAll('BOBI','XIA CHENG');
fs.writeFileSync(jsPath,js);
const htmlPath=path.join(__dirname,'index.html');let html=fs.readFileSync(htmlPath,'utf8');
if(!html.includes('anime.css'))html=html.replace('</head>','<link rel="stylesheet" href="anime.css"></head>');
if(!html.includes('anime.js'))html=html.replace('<script src="app.js"></script>','<script src="app.js"></script><script src="anime.js"></script>');
html=html.replace('<title>nowadays / SOFT MACHINES</title>','<title>nowadays / 桌面玩具 · 二次元</title>');fs.writeFileSync(htmlPath,html);
const verifyPath=path.join(__dirname,'verify.cjs');if(fs.existsSync(verifyPath)){let verify=fs.readFileSync(verifyPath,'utf8');verify=verify.replaceAll("==='波比'","==='夏澄'");fs.writeFileSync(verifyPath,verify);}
console.log('Prepared anime presentation on the preferred desk layout.');
