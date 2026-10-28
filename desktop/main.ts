import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeTheme, session, shell, type IpcMainInvokeEvent } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createCore, createLogger, type Core, type Logger, type LogLevel } from '../src/index.js';
import { SafeStorageCredentialVault } from './safe-storage-vault.js';
import { desktopUserDataPath } from './branding.js';
import { QuitCoordinator } from './quit-coordinator.js';
import { ArtifactImportController } from './artifact-import-controller.js';
import { applyWindowTheme } from './window-theme.js';
import { WINDOW_THEME_TOKENS } from './window-theme-tokens.js';

app.setName('Nowadays');
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
let quitCoordinator: QuitCoordinator | undefined;
let hiddenHintShown = false;
let choosingRuntime = false;
let artifactImports: ArtifactImportController | undefined;

function artifactRoot(): string {
  if (!core || quitting || (quitCoordinator && quitCoordinator.current !== 'idle')) throw new Error('应用尚未就绪或正在退出。');
  return core.diagnostics().artifacts.publicRoot;
}

ipcMain.handle('nowadays:open-artifacts-directory', async (event): Promise<void> => {
  if (!isTrustedWindowSender(event)) throw new Error('无效的资源操作来源。');
  const root = artifactRoot();
  await fs.mkdir(root, { recursive: true });
  const failure = await shell.openPath(root);
  if (failure) throw new Error(`无法打开资源目录：${failure}`);
});

ipcMain.handle('nowadays:preview-artifact-import', async (event, mode: unknown = 'directory') => {
  if (!isTrustedWindowSender(event)) throw new Error('无效的资源操作来源。');
  if (mode !== 'directory' && mode !== 'tavern-card' && mode !== 'worldbook') throw new Error('不支持的导入类型。');
  const root = artifactRoot();
  artifactImports ??= new ArtifactImportController(root);
  return artifactImports.preview(async () => {
    const target = window;
    if (!target || target.isDestroyed() || quitting) throw new Error('应用窗口不可用。');
    const result = await dialog.showOpenDialog(target, mode === 'worldbook'
      ? { title: '选择独立世界书 JSON', properties: ['openFile'], filters: [{ name: '世界书', extensions: ['json'] }] }
      : mode === 'tavern-card'
      ? { title: '选择酒馆角色卡 JSON 或 PNG', properties: ['openFile'], filters: [{ name: '酒馆角色卡', extensions: ['json', 'png'] }] }
      : { title: '选择包含 manifest.json 的资源目录', properties: ['openDirectory'] });
    if (!isTrustedWindowSender(event) || quitting || (quitCoordinator && quitCoordinator.current !== 'idle')) return;
    return result.canceled ? undefined : result.filePaths[0];
  }, mode);
});

ipcMain.handle('nowadays:commit-artifact-import', async (event, token: unknown) => {
  if (!isTrustedWindowSender(event)) throw new Error('无效的资源操作来源。');
  artifactRoot();
  if (!artifactImports) throw new Error('请先选择资源并检查预览。');
  return artifactImports.commit(token);
});

ipcMain.handle('nowadays:choose-runtime-directory', async (event): Promise<string | null> => {
  if (!isTrustedWindowSender(event) || choosingRuntime || !window) return null;
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

ipcMain.handle('nowadays:open-runtime-directory', async (event): Promise<boolean> => {
  if (!isTrustedWindowSender(event)) return false;
  const runtimeDir = core?.injectionSettings().runtimeDir;
  if (!runtimeDir) return false;
  return (await shell.openPath(runtimeDir)) === '';
});

function isTrustedWindowSender(event: IpcMainInvokeEvent): boolean {
  if (!window || window.isDestroyed() || event.sender !== window.webContents
    || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return Boolean(apiUrl && new URL(event.senderFrame.url).origin === apiUrl); } catch { return false; }
}

ipcMain.handle('nowadays:set-window-theme', (event, preset: unknown): boolean => {
  if (!isTrustedWindowSender(event) || !window || quitting) return false;
  return applyWindowTheme(window, nativeTheme, preset, process.platform);
});

ipcMain.handle('nowadays:quit-alive', (event, requestId: unknown): boolean => {
  return isTrustedWindowSender(event) && typeof requestId === 'string' && (quitCoordinator?.keepAlive(requestId) ?? false);
});

ipcMain.handle('nowadays:quit-response', (event, payload: unknown): boolean => {
  if (!isTrustedWindowSender(event)) return false;
  if (!payload || typeof payload !== 'object') return false;
  const { requestId, allowed } = payload as { requestId?: unknown; allowed?: unknown };
  if (typeof requestId !== 'string' || typeof allowed !== 'boolean') return false;
  return quitCoordinator?.respond(requestId, allowed) ?? false;
});

ipcMain.handle('nowadays:quit-ack', (event, payload: unknown): boolean => {
  if (!isTrustedWindowSender(event)) return false;
  if (!payload || typeof payload !== 'object') return false;
  const { requestId } = payload as { requestId?: unknown };
  if (typeof requestId !== 'string') return false;
  return quitCoordinator?.ack(requestId) ?? false;
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
    backgroundColor: WINDOW_THEME_TOKENS.daylight.backgroundColor,
    title: 'Nowadays',
    icon: assetPath(process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
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
    logger?.info('desktop window close requested', { quitting, quitState: quitCoordinator?.current });
    if (quitting) return;
    event.preventDefault();
    if (quitCoordinator?.current === 'checking') {
      showWindow();
      return;
    }
    win.hide();
    if (!hiddenHintShown && process.platform === 'win32') {
      hiddenHintShown = true;
      tray?.displayBalloon({
        title: 'Nowadays 仍在运行',
        content: '窗口已最小化到托盘，QQ 注入与插件继续工作。'
      });
    }
  });
  win.on('closed', () => {
    window = undefined;
  });
  win.webContents.on('render-process-gone', (_event, details) => {
    // 渲染进程在退出预检期间消失：按通信失联放弃本轮，回到空闲且不停止 Core。
    logger?.warn('desktop renderer gone', { reason: details.reason, quitState: quitCoordinator?.current });
    quitCoordinator?.cancel();
  });
  win.on('unresponsive', () => { quitCoordinator?.unavailable(); });
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
  tray = new Tray(assetPath(process.platform === 'win32' ? 'tray.ico' : 'icon.png'));
  tray.setToolTip('Nowadays');
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

function quitCoordinatorInstance(): QuitCoordinator {
  if (quitCoordinator) return quitCoordinator;
  quitCoordinator = new QuitCoordinator({
    onStateChange: (event) => {
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        window.webContents.send('nowadays:quit-state', event);
      }
    },
    requestId: () => crypto.randomUUID(),
    sendCheck: (requestId) => {
      if (!window || window.isDestroyed() || window.webContents.isDestroyed()) return false;
      showWindow();
      window.webContents.send('nowadays:quit-check', { requestId });
      return true;
    },
    showUnavailableDialog: async () => {
      showWindow();
      const options = {
        type: 'warning' as const,
        buttons: ['取消', '继续退出'],
        defaultId: 0,
        cancelId: 0,
        title: 'Nowadays 无法确认未保存修改',
        message: '界面未能确认是否有未保存的修改。',
        detail: '继续退出可能丢失尚未保存的编辑。'
      };
      const target = window && !window.isDestroyed() ? window : undefined;
      const result = target ? await dialog.showMessageBox(target, options) : await dialog.showMessageBox(options);
      return result.response === 1;
    },
    shutdown: async () => {
      quitting = true;
      logger?.info('desktop quitting');
      try {
        // Imports are independent of Core; let an already accepted atomic publication finish.
        await artifactImports?.drain();
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
    }
  });
  return quitCoordinator;
}

function requestQuit(): Promise<void> {
  return quitCoordinatorInstance().request();
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
      'Nowadays 启动失败',
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
