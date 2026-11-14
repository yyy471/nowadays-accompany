const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

function defaultBinaryRelativePath(platform = process.platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
  return 'electron';
}

function readExecutableFromPackageDir(packageDir, env = process.env, platform = process.platform) {
  const pathFile = path.join(packageDir, 'path.txt');
  let relativeExec = '';
  if (fs.existsSync(pathFile)) {
    relativeExec = fs.readFileSync(pathFile, 'utf8').trim();
  }
  const binaryRel = relativeExec || defaultBinaryRelativePath(platform);
  if (env.ELECTRON_OVERRIDE_DIST_PATH) {
    const overridden = path.join(env.ELECTRON_OVERRIDE_DIST_PATH, binaryRel);
    return fs.existsSync(overridden) ? overridden : '';
  }
  const distCandidate = path.join(packageDir, 'dist', binaryRel);
  if (fs.existsSync(distCandidate)) return distCandidate;

  const indexFile = path.join(packageDir, 'index.js');
  if (fs.existsSync(indexFile)) {
    try {
      const resolved = createRequire(indexFile)(packageDir);
      if (typeof resolved === 'string' && resolved && fs.existsSync(resolved)) {
        return resolved;
      }
    } catch {
      /* 忽略不可用入口，交由后续候选路径或错误提示处理 */
    }
  }
  return '';
}

/**
 * 解析桌面端 E2E 测试使用的 Electron 可执行文件路径与来源（292 R08）：
 * 1. 显式环境变量 `NOWADAYS_ELECTRON_PATH` / `ELECTRON_EXEC_PATH`；
 * 2. `desktop/desk-preview/node_modules/electron`（优先于祖先目录残留）；
 * 3. 基于 `desktop/desk-preview` 的 Node 模块解析；
 * 4. 开发机历史根目录 `node_modules/electron` 兜底（可通过 `allowRootFallback: false` 或 `NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK=0` 关闭）。
 */
function resolveElectronExecutableInfo(options = {}) {
  const desktopDir = path.resolve(options.desktopDir ?? path.resolve(__dirname, '..'));
  const repoRoot = path.resolve(options.repoRoot ?? path.resolve(desktopDir, '../..'));
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const rawFallback = typeof env.NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK === 'string'
    ? env.NOWADAYS_ALLOW_ROOT_ELECTRON_FALLBACK.trim().toLowerCase()
    : '';
  const allowRootFallback = options.allowRootFallback ?? !['0', 'false', 'no'].includes(rawFallback);

  for (const key of ['NOWADAYS_ELECTRON_PATH', 'ELECTRON_EXEC_PATH']) {
    const explicit = typeof env[key] === 'string' ? env[key].trim() : '';
    if (explicit) {
      const candidate = path.resolve(explicit);
      if (!fs.existsSync(candidate)) {
        throw new Error(`ELECTRON_EXECUTABLE_MISSING: 环境变量 ${key} 指向的可执行文件不存在: ${candidate}`);
      }
      return { executable: candidate, source: 'env' };
    }
  }

  const localPackageDir = path.join(desktopDir, 'node_modules', 'electron');
  if (fs.existsSync(localPackageDir)) {
    const localExec = readExecutableFromPackageDir(localPackageDir, env, platform);
    if (localExec) return { executable: localExec, source: 'desktop-local' };
  }

  const legacyPackageDir = path.join(repoRoot, 'node_modules', 'electron');
  try {
    const desktopPkg = path.join(desktopDir, 'package.json');
    const resolver = createRequire(fs.existsSync(desktopPkg) ? desktopPkg : __filename);
    const resolvedEntry = resolver.resolve('electron', { paths: [desktopDir] });
    const resolvedPkgDir = path.dirname(resolvedEntry);
    const hitsLegacyRoot = path.resolve(resolvedPkgDir) === path.resolve(legacyPackageDir);
    if (allowRootFallback || !hitsLegacyRoot) {
      const resolvedExec = readExecutableFromPackageDir(resolvedPkgDir, env, platform);
      if (resolvedExec) {
        return {
          executable: resolvedExec,
          source: hitsLegacyRoot ? 'repo-root-fallback' : 'desktop-node-resolve',
        };
      }
    }
  } catch {
    /* 未安装独立依赖时继续检查历史根目录兜底 */
  }

  if (allowRootFallback && fs.existsSync(legacyPackageDir)) {
    const rootExec = readExecutableFromPackageDir(legacyPackageDir, env, platform);
    if (rootExec) return { executable: rootExec, source: 'repo-root-fallback' };
  }

  throw new Error(
    `ELECTRON_EXECUTABLE_NOT_FOUND: 未在 ${localPackageDir} 找到 Electron 可执行文件；请先在 desktop/desk-preview 执行依赖安装，或设置 NOWADAYS_ELECTRON_PATH。`,
  );
}

function resolveElectronExecutable(options = {}) {
  return resolveElectronExecutableInfo(options).executable;
}

module.exports = { resolveElectronExecutable, resolveElectronExecutableInfo };
