const fs=require('node:fs'),path=require('node:path');let html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
for(const name of ['tokens.css','style.css','anime.css'])html=html.replace(`<link rel="stylesheet" href="${name}">`,()=>'<style>'+fs.readFileSync(path.join(__dirname,name),'utf8')+'</style>');
const asset='data:image/png;base64,'+fs.readFileSync(path.join(__dirname,'xiacheng.png')).toString('base64');
const app=fs.readFileSync(path.join(__dirname,'app.js'),'utf8').replaceAll('xiacheng.png','${xiachengAsset}');
html=html.replace('<script src="app.js"></script>',()=>'<script>const xiachengAsset='+JSON.stringify(asset)+';\n'+app+'</script>');
html=html.replace('<script src="anime.js"></script>',()=>'<script>'+fs.readFileSync(path.join(__dirname,'anime.js'),'utf8')+'</script>');
fs.writeFileSync(path.join(__dirname,'nowadays-toy-anime.html'),html);console.log('Created standalone toy/anime design.');
