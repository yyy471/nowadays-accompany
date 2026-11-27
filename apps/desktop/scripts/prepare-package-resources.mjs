import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { backendDir, desktopDir, localNode24Exe, repoRoot } from '../../../scripts/repo-paths.mjs';

const hash = '1c331340fa6cac5e4294725959070a143fa0507195a78ad77eed7943f719aac9';
const runtimeDir = path.dirname(localNode24Exe);
const stage = path.join(desktopDir, 'build-staging');
const piDir = path.join(repoRoot, 'apps', 'pi-mcp');
async function download(url, target) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status} ${url}`);
  const data = Buffer.from(await response.arrayBuffer());
  if (target === localNode24Exe && createHash('sha256').update(data).digest('hex') !== hash) throw new Error('Downloaded Node runtime SHA256 mismatch');
  await writeFile(target, data);
}
await mkdir(runtimeDir, { recursive: true });
if (!existsSync(localNode24Exe)) await download('https://nodejs.org/dist/v24.22.2/win-x64/node.exe', localNode24Exe);
if (createHash('sha256').update(await readFile(localNode24Exe)).digest('hex') !== hash) throw new Error('Node runtime SHA256 mismatch');
const license = path.join(runtimeDir, 'LICENSE');
if (!existsSync(license)) await download('https://raw.githubusercontent.com/nodejs/node/v24.22.2/LICENSE', license);
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.status ?? result.error}`);
}
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run via npm so npm_execpath is available');
run(localNode24Exe, ['-e', `if(process.version !== 'v24.22.2' || process.arch !== 'x64' || process.platform !== 'win32') process.exit(1)`], repoRoot);
const npmEnv = { ...process.env, PATH: `${runtimeDir}${path.delimiter}${process.env.PATH}` };
if (existsSync(path.join(backendDir, 'node_modules'))) {
  run(localNode24Exe, [npm, 'run', 'build'], backendDir, npmEnv);
} else {
  const buildDir = await mkdtemp(path.join(runtimeDir, 'package-compiler-'));
  try {
    for (const item of ['src', 'scripts/build.mjs', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json']) {
      await mkdir(path.dirname(path.join(buildDir, item)), { recursive: true });
      await cp(path.join(backendDir, item), path.join(buildDir, item), { recursive: true });
    }
    run(localNode24Exe, [npm, 'ci', '--include=dev'], buildDir, npmEnv);
    run(localNode24Exe, [npm, 'run', 'build'], buildDir, npmEnv);
    await rm(path.join(backendDir, 'dist'), { recursive: true, force: true });
    await cp(path.join(buildDir, 'dist'), path.join(backendDir, 'dist'), { recursive: true });
  } finally { await rm(buildDir, { recursive: true, force: true }); }
}
await rm(stage, { recursive: true, force: true });
await mkdir(path.join(stage, 'node-runtime'), { recursive: true });
await cp(localNode24Exe, path.join(stage, 'node-runtime', 'node.exe'));
await cp(license, path.join(stage, 'node-runtime', 'LICENSE'));
await cp(path.join(backendDir, 'assets', 'presets'), path.join(stage, 'preset-assets'), { recursive: true });
for (const [name, source, content] of [['backend', backendDir, 'dist'], ['pi-mcp', piDir, 'src']]) {
  const target = path.join(stage, name);
  await mkdir(target, { recursive: true });
  await cp(path.join(source, content), path.join(target, content), { recursive: true });
  for (const file of ['package.json', 'package-lock.json']) await cp(path.join(source, file), path.join(target, file));
  if (existsSync(path.join(source, 'node_modules'))) {
    await cp(path.join(source, 'node_modules'), path.join(target, 'node_modules'), { recursive: true, dereference: true });
    run(localNode24Exe, [npm, 'prune', '--omit=dev', '--offline'], target, npmEnv);
  } else run(localNode24Exe, [npm, 'ci', '--omit=dev'], target, npmEnv);
}
const backendModules = path.join(stage, 'backend', 'node_modules');
for (const name of ['tsx', 'typescript']) if (existsSync(path.join(backendModules, name))) throw new Error(`Unexpected development dependency: ${name}`);
const typesDir = path.join(backendModules, '@types');
if (existsSync(typesDir) && (await readdir(typesDir)).length) throw new Error('Unexpected backend @types');
if (existsSync(path.join(stage, 'backend', 'src'))) throw new Error('Unexpected backend source');
const node = path.join(stage, 'node-runtime', 'node.exe');
const smoke = `
const path = require('node:path');
const requireStaged = name => require(path.join(process.argv[1], 'node_modules', name));
async function main() {
  const koffi = requireStaged('koffi');
  const pid = koffi.load('kernel32.dll').func('uint32_t GetCurrentProcessId()')();
  if (pid !== process.pid) throw Error('koffi PID mismatch');
  if (process.argv[2] === 'backend') {
    const Database = requireStaged('better-sqlite3');
    if (new Database(':memory:').prepare('select 1 as n').get().n !== 1) throw Error('sqlite');
    const sharp = requireStaged('sharp');
    const data = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
    if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) throw Error('sharp');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
for (const name of ['backend', 'pi-mcp']) run(node, ['-e', smoke, path.join(stage, name), name], stage);
console.log(`Verified Node v24.22.2 win32 x64 SHA256 ${hash}; ABI: SQLite, sharp, backend koffi, pi-mcp koffi`);
