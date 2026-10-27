const fs=require('node:fs'),path=require('node:path');
const p=path.join(__dirname,'index.html');let html=fs.readFileSync(p,'utf8');
if(!html.includes('refinement.css'))html=html.replace('</head>','<link rel="stylesheet" href="refinement.css"></head>');
if(!html.includes('refinement.js'))html=html.replace('<script src="app.js"></script>','<script src="app.js"></script><script src="refinement.js"></script>');
html=html.replace('<title>nowadays / 放课后通信</title>','<title>nowadays / 放课后通信 · UI 精修</title>');
fs.writeFileSync(p,html);console.log('Prepared refined prototype entry.');
