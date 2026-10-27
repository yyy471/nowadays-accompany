// Isolated native test window: no Core, preload, QQ, tray or application data.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const profile = path.resolve(__dirname, '../../test-results', `ui-native-${Date.now()}-${process.pid}`);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', profile);
const value = process.argv.find(argument => argument.startsWith('--ui-workbench-url='))?.split('=').slice(1).join('=');
const url = new URL(value || 'http://127.0.0.1:50318/ui-workbench.html');
if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:') throw new Error('Workbench must use local HTTP');
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 1280, height: 800, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, target) => { if (new URL(target).origin !== url.origin) event.preventDefault(); });
  await window.loadURL(url.href);
});
app.on('window-all-closed', () => app.quit());
