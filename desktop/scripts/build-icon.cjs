const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();

const root = path.resolve(__dirname, '..', '..');
const svgFile = path.join(root, 'desktop', 'assets', 'icon.svg');
const pngFile = path.join(root, 'desktop', 'assets', 'icon.png');
const icoFile = path.join(root, 'desktop', 'assets', 'icon.ico');

app.whenReady().then(async () => {
  const svg = await fs.readFile(svgFile, 'utf8');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:1024px;height:1024px}</style></head><body>${svg}</body></html>`;
  const win = new BrowserWindow({
    width: 1024,
    height: 1024,
    useContentSize: true,
    frame: false,
    transparent: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { offscreen: true, zoomFactor: 1 }
  });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  const png = image.getSize().width === 1024 ? image.toPNG() : image.resize({ width: 1024, height: 1024 }).toPNG();
  await fs.writeFile(pngFile, png);
  await fs.copyFile(pngFile, path.join(root, 'desktop', 'renderer', 'public', 'nowadays-icon.png'));
  const toIco = (await import('png-to-ico')).default;
  await fs.writeFile(icoFile, await toIco(pngFile));
  console.log('icon written', pngFile, icoFile);
  win.destroy();
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
