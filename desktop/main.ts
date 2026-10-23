import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, session, shell } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createCore, createLogger, type Core, type Logger, type LogLevel } from '../src/index.js';
import { SafeStorageCredentialVault } from './safe-storage-vault.js';
import { desktopUserDataPath } from './branding.js';

app.setName('nowadays');
app.setPath('userData', desktopUserDataPath(app.getPath('appData'), existsSync));
if (process.platform === 'win32') app.setAppUserModelId('com.nowadays.desktop');

const primary = app.requestSingleInstanceLock();
let core: Core | undefined;
let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let logger: Logger | undefined;
let dataRoot = '';
let apiUrl = '';
let quitting = false;
let shutdown: Promise<void> | undefined;
let hiddenHintShown = false;
let choosingRuntime = false;

ipcMain.handle('nowadays:choose-runtime-directory', async (event): Promise<string | null> => {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame || choosingRuntime) return null;
  if (new URL(event.senderFrame.url).origin !== apiUrl) return null;
  choosingRuntime = true;
  try {
    const result = await dialog.showOpenDialog(window, {
      title: '选择已自行安装的 SnowLuma 运行目录',
      properties: ['openDirectory'],
      ...(core?.injectionSettings().runtimeDir ? { defaultPath: core.injectionSettings().runtimeDir } : {})
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  } finally {
    choosingRuntime = false;
  }
});

function assetPath(name: string): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'assets', name)
    : path.join(app.getAppPath(), 'desktop', 'assets', name);
}

function uiDir(): string {
  const override = process.env.NOWADAYS_UI_DIR ?? process.env.ACCOMPANY_UI_DIR;
  return override
    ? path.resolve(override)
    : path.join(app.getAppPath(), 'desktop', 'renderer', 'dist');
}

function resolveDataRoot(): string {
  const override = process.env.NOWADAYS_DATA_ROOT ?? process.env.ACCOMPANY_DATA_ROOT;
  return override
    ? path.resolve(override)
    : path.join(app.getPath('userData'), 'data');
}

function showWindow(): void {
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function createWindow(token: string): void {
  const info = encodeURIComponent(
    JSON.stringify({
      apiBaseUrl: apiUrl,
      token,
      version: app.getVersion(),
      platform: process.platform
    } satisfies Record<string, string>)
  );
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#f2eee5',
    title: 'nowadays',
    icon: assetPath('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'desktop-dist', 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--nowadays-info=${info}`]
    }
  });
  window = win;
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => {
    win.show();
    logger?.info('desktop window shown', { visible: win.isVisible() });
  });
  win.on('close', (event) => {
    logger?.info('desktop window close requested', { quitting });
    if (quitting) return;
    event.preventDefault();
    win.hide();
    if (!hiddenHintShown && process.platform === 'win32') {
      hiddenHintShown = true;
      tray?.displayBalloon({
        title: 'nowadays 仍在运行',
        content: '窗口已最小化到托盘，QQ 注入与插件继续工作。'
      });
    }
  });
  win.on('closed', () => {
    window = undefined;
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!apiUrl || !url.startsWith(apiUrl)) event.preventDefault();
  });
  void win.loadURL(`${apiUrl}/`).catch((error: unknown) => {
    logger?.error('failed to load desktop UI', {
      message: error instanceof Error ? error.message : String(error)
    });
  });
}

function createTray(): void {
  const image = nativeImage.createFromPath(assetPath('icon.png'));
  tray = new Tray(image.resize({ width: 16, height: 16 }));
  tray.setToolTip('nowadays');
  const menu = Menu.buildFromTemplate([
    { label: '打开主窗口', click: showWindow },
    {
      label: '打开数据目录',
      click: () => {
        void shell.openPath(dataRoot);
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        void requestQuit();
      }
    }
  ]);
  tray.setContextMenu(menu);
  tray.on('double-click', showWindow);
}

function requestQuit(): Promise<void> {
  if (shutdown) return shutdown;
  quitting = true;
  shutdown = (async () => {
    logger?.info('desktop quitting');
    try {
      await core?.stop();
    } catch (error) {
      logger?.warn('core stop failed during quit', {
        message: error instanceof Error ? error.message : String(error)
      });
    }
    try {
      tray?.destroy();
    } catch {
      // tray may already be gone
    }
    window?.destroy();
    app.exit(0);
  })();
  return shutdown;
}

async function prepareLogFile(): Promise<string> {
  const dir = path.join(app.getPath('userData'), 'logs');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'desktop.log');
  try {
    const stat = await fs.stat(file);
    if (stat.size > 5 * 1024 * 1024) await fs.rename(file, `${file}.1`);
  } catch {
    // first run
  }
  return file;
}

async function bootstrap(): Promise<void> {
  const logFile = await prepareLogFile();
  const level = ((process.env.NOWADAYS_LOG_LEVEL ?? process.env.ACCOMPANY_LOG_LEVEL) as LogLevel | undefined) ?? 'info';
  logger = createLogger({
    scope: 'desktop',
    level,
    sink: (record) => {
      const line = `${JSON.stringify(record)}\n`;
      process.stdout.write(line);
      void fs.appendFile(logFile, line).catch(() => {});
    }
  });

  try {
    dataRoot = resolveDataRoot();
    await fs.mkdir(dataRoot, { recursive: true, mode: 0o700 });
    const token = crypto.randomBytes(32).toString('base64url');
    const credentialVault = new SafeStorageCredentialVault();
    if (!credentialVault.available) {
      logger.warn('system credential protection is unavailable; provider keys cannot be saved');
    }
    const instance = await createCore({
      dataRoot,
      instances: [],
      persistSlots: true,
      manualStartOnly: true,
      autoStartSnowLuma: false,
      autoFakeChannel: true,
      credentialVault,
      api: {
        enabled: true,
        host: '127.0.0.1',
        port: 0,
        token,
        uiDir: uiDir()
      },
      logger: logger.child('core')
    });
    core = instance;
    await instance.start();
    const url = instance.status().apiUrl;
    if (!url) throw new Error('control API did not expose a URL');
    apiUrl = url;

    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) => {
      // 控制台只保留复制路径/诊断所需的剪贴板写入，其余权限一律拒绝。
      callback(permission === 'clipboard-sanitized-write');
    });
    createWindow(token);
    createTray();
    logger.info('desktop ready', { dataRoot, apiUrl });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    logger.error('desktop failed to start', { message });
    dialog.showErrorBox(
      'nowadays 启动失败',
      `${error instanceof Error ? error.message : String(error)}\n\n数据目录：${dataRoot}\n日志：${path.join(app.getPath('userData'), 'logs', 'desktop.log')}`
    );
    await core?.stop().catch(() => {});
    app.exit(1);
  }
}

if (!primary) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('activate', showWindow);
  app.on('window-all-closed', () => {
    // 关闭窗口只隐藏到托盘，退出由托盘菜单或 before-quit 处理。
  });
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });
  app.whenReady().then(bootstrap).catch((error: unknown) => {
    logger?.error('desktop bootstrap rejected', {
      message: error instanceof Error ? error.stack ?? error.message : String(error)
    });
    app.exit(1);
  });
}
