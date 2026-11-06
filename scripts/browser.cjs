'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const BRANDS = { xiaocang: 'msedge.exe', lexinyi: 'chrome.exe' };
function dataHome() {
  const base = process.env.MEITUAN_SHENQUAN_HOME || (process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'MeituanShenquan'));
  if (!base) throw Error('Cannot find local application data; set MEITUAN_SHENQUAN_HOME');
  return path.resolve(base);
}
function validateConfig(config) {
  if (config.version !== 1 || config.viewport?.width !== 1920 || config.viewport?.height !== 1080) throw Error('Unsupported configuration or viewport');
  if (!config.nodePath || !config.pwshPath || !config.runtimeDir) throw Error('Runtime paths are missing; run setup.ps1');
  if (![config.nodePath, config.pwshPath, config.runtimeDir].every(p => path.isAbsolute(p))) throw Error('Runtime paths must be absolute');
  for (const [brand, exe] of Object.entries(BRANDS)) {
    const selected = config.brands?.[brand];
    if (!selected || !Number.isInteger(selected.port) || selected.port < 1024 || selected.port > 65535) throw Error(`Invalid ${brand} port`);
    if (path.basename(selected.executable || '').toLowerCase() !== exe || !path.isAbsolute(selected.profileDir || '')) throw Error(`Invalid ${brand} executable/profile`);
    if (!selected.expectedAccount || /[\r\n]/.test(selected.expectedAccount)) throw Error(`Configure the expected ${brand} website account before login`);
  }
  if (config.brands.xiaocang.port === config.brands.lexinyi.port) throw Error('The two browser ports must differ');
  if (path.resolve(config.brands.xiaocang.profileDir).toLowerCase() === path.resolve(config.brands.lexinyi.profileDir).toLowerCase()) throw Error('The two browser profiles must differ');
  return config;
}
function loadConfig() {
  const home = dataHome();
  const config = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8').replace(/^\uFEFF/, ''));
  config.home = home;
  return validateConfig(config);
}
function processInfo(config, brand) {
  if (process.platform !== 'win32') throw Error('This package supports Windows 10/11');
  const selected = config.brands[brand];
  if (!selected) throw Error('Unknown brand');
  const code = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$OutputEncoding=[Console]::OutputEncoding;$ErrorActionPreference='Stop';$p=[int]$env:SQ_BROWSER_PORT;$profile=$env:SQ_BROWSER_PROFILE;$exe=$env:SQ_BROWSER_EXE;$owners=@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue|Select-Object -ExpandProperty OwningProcess -Unique);$owner=@($owners|ForEach-Object{Get-CimInstance Win32_Process -Filter "ProcessId=$_"|Select-Object ProcessId,Name,ExecutablePath,CommandLine,CreationDate});$profileProcesses=@(Get-CimInstance Win32_Process -Filter "Name='$exe'"|Where-Object{$_.CommandLine -and $_.CommandLine.IndexOf($profile,[StringComparison]::OrdinalIgnoreCase)-ge 0}|Select-Object ProcessId,Name,ExecutablePath,CommandLine,CreationDate);@{owners=$owner;profileProcesses=$profileProcesses}|ConvertTo-Json -Depth 5 -Compress`;
  return JSON.parse(execFileSync(config.pwshPath, ['-NoProfile', '-NonInteractive', '-Command', code], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, SQ_BROWSER_PORT: String(selected.port), SQ_BROWSER_PROFILE: selected.profileDir, SQ_BROWSER_EXE: BRANDS[brand] },
  }).replace(/^\uFEFF/, ''));
}
function ownerMatches(owner, selected) {
  const normalize = value => path.resolve(value).toLowerCase();
  const cmd = owner.CommandLine || '';
  const escaped = selected.profileDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const quotedWhole = `"--user-data-dir=${escaped}"`;
  const quotedValue = `--user-data-dir="${escaped}"`;
  const plain = /\s/.test(selected.profileDir) ? '' : `|--user-data-dir=${escaped}`;
  return owner.ExecutablePath && normalize(owner.ExecutablePath) === normalize(selected.executable)
    && new RegExp(`(?:^|\\s)(?:--remote-debugging-port=${selected.port}|"--remote-debugging-port=${selected.port}")(?=\\s|$)`).test(cmd)
    && new RegExp(`(?:^|\\s)(?:${quotedWhole}|${quotedValue}${plain})(?=\\s|$)`, 'i').test(cmd);
}
function headless(owner) { return /(?:^|\s)--headless(?:=|\s|$)/.test(owner.CommandLine || ''); }
function hasBarrier(config, brand) { return fs.existsSync(path.join(config.home, 'pending', brand + '.json')); }
function checkLoginIdle(config, brand) {
  if (hasBarrier(config, brand)) throw Error('An earlier submission needs readback; browser mode was preserved');
  if (fs.existsSync(path.join(config.home, 'locks', brand + '.json'))) throw Error('A workflow owns this browser; finish it before opening login');
}
function launchArguments(selected, { visible = false, startupUrl = 'https://shangoue.meituan.com/' } = {}) {
  return ['--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${selected.port}`, `--user-data-dir=${selected.profileDir}`,
    '--profile-directory=Default', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-background-mode',
    '--window-size=1920,1080', '--force-device-scale-factor=1', ...(visible ? [] : ['--headless=new']), startupUrl];
}
async function fetchVersion(endpoint) {
  const response = await fetch(endpoint + '/json/version', { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw Error('Browser endpoint is unavailable');
  return response.json();
}
async function closeOwnedBrowser(config, brand) {
  checkLoginIdle(config, brand);
  const selected = config.brands[brand]; const info = processInfo(config, brand);
  if (info.owners.length !== 1 || !ownerMatches(info.owners[0], selected)) throw Error('Cannot verify browser ownership for normal shutdown');
  const endpoint = `http://127.0.0.1:${selected.port}`; await fetchVersion(endpoint);
  const { chromium } = require(path.join(config.runtimeDir, 'node_modules', 'playwright-core'));
  const browser = await chromium.connectOverCDP(endpoint);
  try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close').catch(error => { if (!/closed|disconnected/i.test(error.message)) throw error; }); }
  finally { await browser.close().catch(() => {}); }
  for (let i = 0; i < 60; i++) { if (!processInfo(config, brand).owners.length) return; await sleep(100); }
  throw Error('Browser did not close normally; no second browser was started');
}
async function resizeVisible(config, endpoint) {
  const { chromium } = require(path.join(config.runtimeDir, 'node_modules', 'playwright-core'));
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const session = await browser.newBrowserCDPSession(); const targets = await session.send('Target.getTargets');
    const target = targets.targetInfos.find(t => t.type === 'page' && t.url.startsWith('https://shangoue.meituan.com/')) || targets.targetInfos.find(t => t.type === 'page');
    if (!target) throw Error('Dedicated login window has no page');
    const { windowId } = await session.send('Browser.getWindowForTarget', { targetId: target.targetId });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds: { width: 1920, height: 1080 } });
    await session.send('Target.activateTarget', { targetId: target.targetId });
  } finally { await browser.close(); }
}
async function ensureBrowser(config, brand, { visible = false, startupUrl } = {}) {
  validateConfig(config); const selected = config.brands[brand];
  if (!selected) throw Error('Unknown brand');
  const lockFile = path.join(config.home, 'locks', brand + '.json');
  if (fs.existsSync(lockFile)) {
    let lock; try { lock = JSON.parse(fs.readFileSync(lockFile, 'utf8').replace(/^\uFEFF/, '')); } catch { throw Error('Browser lock cannot be read; preserve it for inspection'); }
    if (lock.pid !== process.pid) throw Error('Another workflow owns this browser; its process was preserved');
  }
  if (visible) checkLoginIdle(config, brand);
  const endpoint = `http://127.0.0.1:${selected.port}`;
  let info = processInfo(config, brand);
  if (info.owners.length) {
    if (info.owners.length !== 1 || !ownerMatches(info.owners[0], selected)) throw Error('Port belongs to another process/profile; existing processes were preserved');
    await fetchVersion(endpoint);
    if (headless(info.owners[0]) === !visible) { if (visible) await resizeVisible(config, endpoint); return { endpoint, started: false, visible }; }
    if (!visible) throw Error('Close the dedicated login browser normally before running silently');
    await closeOwnedBrowser(config, brand); info = processInfo(config, brand);
  }
  if (hasBarrier(config, brand)) throw Error('An earlier submission needs verification; automatic browser restart is blocked');
  if (info.profileProcesses.length) throw Error('Dedicated profile is running without its configured port; close it normally before retrying');
  if (!fs.existsSync(selected.executable)) throw Error('Configured browser executable is missing; run setup.ps1');
  fs.mkdirSync(selected.profileDir, { recursive: true });
  const child = spawn(selected.executable, launchArguments(selected, { visible, startupUrl }), { detached: true, stdio: 'ignore', windowsHide: !visible });
  let launchError; child.once('error', error => { launchError = error; }); child.unref();
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    try { await fetchVersion(endpoint); const live = processInfo(config, brand); if (live.owners.length !== 1 || !ownerMatches(live.owners[0], selected) || headless(live.owners[0]) === visible) throw Error('Started browser ownership/mode mismatch'); if (visible) await resizeVisible(config, endpoint); return { endpoint, started: true, visible }; }
    catch (error) { if (/mismatch/.test(error.message)) throw error; }
    await sleep(250);
  }
  throw Error('Dedicated browser did not become ready; no process was killed');
}
async function verifyLogin(config, brand) {
  const { endpoint } = await ensureBrowser(config, brand, { visible: false });
  const { chromium } = require(path.join(config.runtimeDir, 'node_modules', 'playwright-core'));
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0];
    let page = context.pages().find(p => p.url().startsWith('https://shangoue.meituan.com/'));
    if (!page) { page = await context.newPage(); await page.goto('https://shangoue.meituan.com/', { waitUntil: 'domcontentloaded' }); }
    const expected = config.brands[brand].expectedAccount;
    await page.locator('.acctinfo-container .txt').filter({ hasText: expected }).waitFor({ state: 'visible', timeout: 20000 });
    if ((await page.locator('.acctinfo-container .txt').innerText()).trim() !== expected) throw Error('Website account mismatch');
    return { brand, account: expected, loginVerified: true, visible: false };
  } finally { await browser.close(); }
}
async function main() {
  const command = process.argv[2] || 'status'; const brandIndex = process.argv.indexOf('--brand');
  const brand = brandIndex >= 0 ? process.argv[brandIndex + 1] : process.argv[3]; const config = loadConfig();
  if (!BRANDS[brand]) throw Error('Specify xiaocang or lexinyi');
  if (command === 'login') { const result = await ensureBrowser(config, brand, { visible: true }); console.log(JSON.stringify({ ...result, brand, message: 'Log in to the configured website account, then close this dedicated browser normally.' })); }
  else if (command === 'verify-login') console.log(JSON.stringify(await verifyLogin(config, brand)));
  else if (command === 'status') { const info = processInfo(config, brand); console.log(JSON.stringify({ brand, running: info.owners.length === 1, owned: info.owners.length === 1 && ownerMatches(info.owners[0], config.brands[brand]), headless: info.owners.length === 1 && headless(info.owners[0]), pending: hasBarrier(config, brand) })); }
  else throw Error('Unknown browser command');
}
if (require.main === module) main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
module.exports = { dataHome, loadConfig, validateConfig, ensureBrowser, verifyLogin, closeOwnedBrowser, processInfo, ownerMatches, launchArguments };
