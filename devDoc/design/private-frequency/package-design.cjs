const fs=require('node:fs');const path=require('node:path');const root=__dirname;
const html=fs.readFileSync(path.join(root,'index.html'),'utf8');const css=fs.readFileSync(path.join(root,'tokens.css'),'utf8');let js=fs.readFileSync(path.join(root,'app.js'),'utf8');
const asset='data:image/png;base64,'+fs.readFileSync(path.join(root,'character.png')).toString('base64');js=js.replaceAll('character.png','${characterAsset}');
const result=html.replace('<link rel="stylesheet" href="tokens.css">',()=>'<style>'+css+'</style>').replace('<script src="app.js"></script>',()=>'<script>const characterAsset='+JSON.stringify(asset)+';\n'+js+'</script>');
fs.writeFileSync(path.join(root,'nowadays-frequency.html'),result);console.log('Created standalone offline design.');
