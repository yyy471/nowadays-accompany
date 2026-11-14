const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { resolveElectronExecutable, resolveElectronExecutableInfo } = require('./electron-executable.cjs');

function writeFakeElectron(pkgDir, relativeExec) {
  const execPath = path.join(pkgDir, 'dist', relativeExec);
  fs.mkdirSync(path.dirname(execPath), { recursive: true });
  fs.writeFileSync(execPath, 'fake-electron-binary');
  fs.writeFileSync(path.join(pkgDir, 'path.txt'), relativeExec);
  fs.writeFileSync(
    path.join(pkgDir, 'index.js'),
    "const path = require('node:path');\nconst fs = require('node:fs');\nmodule.exports = path.join(__dirname, 'dist', fs.readFileSync(path.join(__dirname, 'path.txt'), 'utf8').trim());\n",
  );
  return execPath;
}

test('干净检出仅安装 desktop/desk-preview 依赖时可直接解析本地 Electron，且优先于根目录残留', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-r08-'));
  try {
    const repoRoot = path.join(tmp, 'repo');
    const desktopDir = path.join(repoRoot, 'desktop', 'desk-preview');
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(desktopDir, 'package.json'), '{"name":"nowadays-desk","private":true}');

    // 1. 仅安装 desktop/desk-preview/node_modules/electron（无根目录 node_modules）
    const localExec = writeFakeElectron(
      path.join(desktopDir, 'node_modules', 'electron'),
      'electron',
    );
    assert.deepEqual(
      resolveElectronExecutableInfo({ desktopDir, repoRoot, env: {}, platform: 'linux', allowRootFallback: false }),
      { executable: localExec, source: 'desktop-local' },
    );

    // 2. 同时存在根目录残留时，依然优先使用 desktop/desk-preview 下的版本
    const rootExec = writeFakeElectron(
      path.join(repoRoot, 'node_modules', 'electron'),
      'electron',
    );
    assert.notEqual(rootExec, localExec);
    assert.deepEqual(
      resolveElectronExecutableInfo({ desktopDir, repoRoot, env: {}, platform: 'linux' }),
      { executable: localExec, source: 'desktop-local' },
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('无本地 electron 时支持环境变量覆盖与开发机根目录兜底，均缺失时给出清晰错误', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nowadays-r08-fallback-'));
  try {
    const repoRoot = path.join(tmp, 'repo');
    const desktopDir = path.join(repoRoot, 'desktop', 'desk-preview');
    fs.mkdirSync(desktopDir, { recursive: true });
    fs.writeFileSync(path.join(desktopDir, 'package.json'), '{"name":"nowadays-desk","private":true}');

    assert.throws(
      () => resolveElectronExecutable({ desktopDir, repoRoot, env: {}, allowRootFallback: false }),
      /ELECTRON_EXECUTABLE_NOT_FOUND/,
    );

    const customExec = path.join(tmp, 'custom-electron.exe');
    fs.writeFileSync(customExec, 'override');
    assert.deepEqual(
      resolveElectronExecutableInfo({
        desktopDir,
        repoRoot,
        env: { NOWADAYS_ELECTRON_PATH: customExec },
        allowRootFallback: false,
      }),
      { executable: customExec, source: 'env' },
    );
    assert.throws(
      () =>
        resolveElectronExecutable({
          desktopDir,
          repoRoot,
          env: { NOWADAYS_ELECTRON_PATH: path.join(tmp, 'missing.exe') },
        }),
      /ELECTRON_EXECUTABLE_MISSING/,
    );

    const rootExec = writeFakeElectron(
      path.join(repoRoot, 'node_modules', 'electron'),
      'electron.exe',
    );
    assert.deepEqual(
      resolveElectronExecutableInfo({ desktopDir, repoRoot, env: {}, platform: 'win32' }),
      { executable: rootExec, source: 'repo-root-fallback' },
    );
    assert.throws(
      () =>
        resolveElectronExecutableInfo({
          desktopDir,
          repoRoot,
          env: { NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK: '0' },
          platform: 'win32',
        }),
      /ELECTRON_EXECUTABLE_NOT_FOUND/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
