import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const root = process.cwd();
const portableOnly = process.argv.includes('--portable');

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const productName = pkg.build?.productName ?? 'nowadays';
const version = pkg.version;
const outputDir = path.join(root, 'release');
const staging = path.join(root, `.packaging-${process.pid}`);
const winUnpacked = path.join(staging, 'win-unpacked');
const appStaging = path.join(staging, 'app');
if (path.dirname(path.resolve(staging)) !== path.resolve(root) || !/^\.packaging-\d+$/.test(path.basename(staging))) {
  throw new Error('packaging staging must stay inside the project root');
}

const electronDist = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
const builderCli = require.resolve('electron-builder/cli.js');
const iconPng = path.join(root, 'desktop', 'assets', 'icon.png');
const iconIco = path.join(root, 'desktop', 'assets', 'icon.ico');

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function assemble() {
  for (const required of [
    path.join(root, 'desktop-dist', 'main.mjs'),
    path.join(root, 'desktop-dist', 'preload.cjs'),
    path.join(root, 'desktop', 'renderer', 'dist', 'index.html')
  ]) {
    if (!(await exists(required))) {
      throw new Error(`missing build output ${required}; run npm run desktop:build first`);
    }
  }

  await fs.rm(staging, { recursive: true, force: true });
  await fs.mkdir(winUnpacked, { recursive: true });
  await fs.cp(electronDist, winUnpacked, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'default_app.asar'
  });

  await fs.mkdir(path.join(appStaging, 'desktop', 'renderer'), { recursive: true });
  await fs.writeFile(
    path.join(appStaging, 'package.json'),
    `${JSON.stringify(
      {
        name: pkg.name,
        version,
        description: pkg.description,
        type: 'module',
        main: 'desktop-dist/main.mjs'
      },
      null,
      2
    )}\n`
  );
  await fs.cp(path.join(root, 'desktop-dist'), path.join(appStaging, 'desktop-dist'), { recursive: true });
  await fs.cp(
    path.join(root, 'desktop', 'renderer', 'dist'),
    path.join(appStaging, 'desktop', 'renderer', 'dist'),
    { recursive: true }
  );

  await fs.cp(appStaging, path.join(winUnpacked, 'resources', 'app'), { recursive: true });

  const assetsDir = path.join(winUnpacked, 'resources', 'assets');
  await fs.mkdir(assetsDir, { recursive: true });
  await fs.copyFile(iconPng, path.join(assetsDir, 'icon.png'));
  await fs.copyFile(iconIco, path.join(assetsDir, 'icon.ico'));

  const sourceExe = path.join(winUnpacked, 'electron.exe');
  const targetExe = path.join(winUnpacked, `${productName}.exe`);
  await fs.rename(sourceExe, targetExe);

  const rcedit = process.env.RCEDIT_PATH
    ? path.resolve(process.env.RCEDIT_PATH)
    : path.join(root, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe');
  if (await exists(rcedit)) {
    try {
      execFileSync(rcedit, [
        targetExe,
        '--set-icon',
        iconIco,
        '--set-version-string',
        'ProductName',
        productName,
        '--set-version-string',
        'FileDescription',
        productName,
        '--set-version-string',
        'CompanyName',
        'nowadays',
        '--set-version-string',
        'OriginalFilename',
        `${productName}.exe`,
        '--set-file-version',
        version,
        '--set-product-version',
        version
      ]);
    } catch (error) {
      console.warn('rcedit failed; executable metadata stays default:', error instanceof Error ? error.message : error);
    }
  } else {
    console.warn('rcedit not found; executable metadata stays default');
  }
}

async function packageApp() {
  await fs.mkdir(outputDir, { recursive: true });
  const targets = portableOnly ? ['portable'] : ['nsis', 'portable'];
  execFileSync(
    process.execPath,
    [
      builderCli,
      '--win',
      ...targets,
      '--prepackaged',
      winUnpacked,
      '--config.directories.output',
      outputDir
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
    }
  );
}

await assemble();
await packageApp();
try {
  await fs.rm(staging, { recursive: true, force: true });
} catch (error) {
  console.warn(
    'packaging staging left on disk (files still scanned or locked):',
    error instanceof Error ? error.message : error
  );
}

const artifacts = (await fs.readdir(outputDir)).filter((name) => name.endsWith('.exe'));
console.log(`packaged ${productName} ${version}:`);
for (const artifact of artifacts) console.log(`  ${path.join('release', artifact)}`);
