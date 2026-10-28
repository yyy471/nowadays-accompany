const { app, BrowserWindow } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.disableHardwareAcceleration();
const root = path.resolve(__dirname, '..', '..');
const assets = path.join(root, 'desktop', 'assets');
// 构建进程独用缓存，避免与正在运行的Electron应用争用默认profile。
const profile = path.join(root, 'test-results', 'icon-build-profile');
require('node:fs').mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1024, height: 1024, useContentSize: true, frame: false,
    transparent: true, show: false, backgroundColor: '#00000000',
    webPreferences: { offscreen: true, zoomFactor: 1 }
  });
  try {
    const master = await fs.readFile(path.join(assets, 'icon.svg'), 'utf8');
    const small = await fs.readFile(path.join(assets, 'icon-small.svg'), 'utf8');
    const render = async (svg, size) => {
      win.setContentSize(size, size);
      const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block;width:${size}px;height:${size}px}</style></head><body>${svg}</body></html>`;
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const frame = await win.webContents.capturePage();
      if (frame.getSize().width !== size || frame.getSize().height !== size) {
        throw new Error(`unexpected icon frame size: ${size}`);
      }
      return frame.toPNG();
    };
    const png = await render(master, 1024);
    await fs.writeFile(path.join(assets, 'icon.png'), png);
    await fs.copyFile(path.join(assets, 'icon.png'), path.join(root, 'desktop', 'renderer', 'public', 'nowadays-icon.png'));
    // 小尺寸使用专用像素母版，ICO保留各帧供Windows按实际DPI选用。
    const frames = [];
    for (const size of [16, 20, 24, 32, 48, 64, 128, 256]) {
      frames.push(await render(size < 32 ? small : master, size));
    }
    const toIco = (await import('png-to-ico')).default;
    await fs.writeFile(path.join(assets, 'icon.ico'), await toIco(frames));
    await fs.copyFile(path.join(assets, 'icon.ico'), path.join(root, 'desktop', 'renderer', 'public', 'nowadays-icon.ico'));
    await fs.writeFile(path.join(assets, 'tray.ico'), await toIco(frames.slice(0, 4)));
    console.log('fold N icons written: icon.png, icon.ico, tray.ico');
  } finally {
    win.destroy();
  }
  app.quit();
}).catch((error) => {
  console.error(error);
  app.exit(1);
});
