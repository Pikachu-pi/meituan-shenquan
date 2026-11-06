'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { loadConfig, ensureBrowser } = require('./browser.cjs');
const { createWorkflow } = require('./workflow.cjs');
const { ensureAllStores } = require('./store-scope.cjs');
const { acquireLock, createRunState } = require('./run-state.cjs');

const PHASES = ['check-scope', 'preflight', 'execute', 'prepare-cancel', 'cancel', 'verify-cancel', 'prepare-register', 'register', 'confirm-register', 'verify-register', 'result-details', 'verify'];
function parseArgs(args) {
  const options = { phase: 'preflight' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--brand', '--phase', '--run-dir'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw Error('参数格式：--brand xiaocang|lexinyi [--phase preflight|execute] [--run-dir 目录]');
    const name = key.slice(2);
    if (seen.has(name)) throw Error(`重复参数 ${key}`);
    seen.add(name);
    options[name] = args[++i];
  }
  if (!['xiaocang', 'lexinyi'].includes(options.brand) || !PHASES.includes(options.phase)) throw Error('必须指定正确的中台和执行阶段');
  return options;
}

function writeSummary(out, state, error) {
  const lines = ['# 神券活动运行结果', '', `中台：${state.brand}；账号：${state.account}；活动：${state.activityId}`, '', `运行目录：${out}`, '', `结果：${error ? '停止，需要核对' : state.phase === 'execute' && state.registerReceipt?.failed ? '已完成，包含失败门店' : '完成'}`, ''];
  if (state.phase === 'preflight') lines.push('本次仅验证前置流程，没有提交取消或报名。', '');
  if (state.cancelIntent) lines.push(`取消：${state.cancelIntent.skipped ? '没有已报名门店，无需取消' : `${state.cancelCount} 家；${state.cancelIntent.outcome}`}`, '');
  if (state.cancelIntent?.outcome === 'confirmed' && !state.cancelIntent.skipped && state.registerIntent?.outcome !== 'confirmed') lines.push('已确认取消，但尚无重报成功回执；不能视为整轮业务完成。', '');
  if (state.registerReceipt) lines.push(`报名：成功 ${state.registerReceipt.successful} 家，失败 ${state.registerReceipt.failed} 家。`, '');
  if (state.verification) lines.push(`回读：${state.verification.activeCount} 家；原门店缺失 ${state.verification.missingOriginalIds.length} 家；库存或状态异常 ${state.verification.invalidRows.length} 家。`, '');
  if (state.failedStores?.length) lines.push(`失败原因：${[...new Set(state.failedStores.map(row => row['失败原因']))].join('；')}`, '', '逐店明细见 failed-stores.json 和 register-result-details.csv。', '');
  if (error) lines.push(`停止原因：${error}`, '', '不要重新提交；优先核对原目录中的 state.json 和本次平台回执。', '');
  lines.push(`本阶段耗时：${state.elapsedSeconds} 秒。`);
  fs.writeFileSync(path.join(out, '结果.md'), lines.join('\n'));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const settings = loadConfig(); const selected = settings.brands[options.brand];
  if (!selected?.expectedAccount?.trim()) throw Error('未配置预期账号，请先按使用指南安装并完成登录核验');
  const out = path.resolve(options['run-dir'] || path.join(settings.home, 'runs', `${new Date().toISOString().replace(/[:.]/g, '-')}-${options.brand}`));
  for (const item of Object.values(settings.brands)) {
    const profile = path.resolve(item.profileDir).toLowerCase();
    const target = out.toLowerCase(); if (target === profile || target.startsWith(profile + path.sep)) throw Error('运行记录不能写入浏览器资料目录');
  }
  fs.mkdirSync(out, { recursive: true });
  const run = createRunState({ home: settings.home, out, brand: options.brand, account: selected.expectedAccount, activityId: settings.activityId, phase: options.phase });
  const { state, save, step } = run;
  run.checkPending();
  const release = acquireLock(settings.home, options.brand, out);
  try { run.checkPending(); } catch (error) { release(); throw error; }
  let browser, workflow, errorText; const started = Date.now();
  state.phase = options.phase; save();
  const interrupt = () => {
    state.error = { message: '运行被中断；若有未决提交，先核对原回执', at: new Date().toISOString() };
    state.elapsedSeconds = Math.round((Date.now() - started) / 10) / 100;
    save(); writeSummary(out, state, state.error.message); release(); process.exit(130);
  };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const { endpoint } = await ensureBrowser(settings, options.brand, { visible: false });
    const { chromium } = require(path.join(settings.runtimeDir, 'node_modules', 'playwright-core'));
    browser = await chromium.connectOverCDP(endpoint);
    let pages = browser.contexts().flatMap(context => context.pages()).filter(p => p.url().startsWith('https://shangoue.meituan.com/'));
    if (!pages.length && browser.contexts()[0].pages().every(p => p.url() === 'about:blank')) {
      const fresh = await browser.contexts()[0].newPage();
      await fresh.goto('https://shangoue.meituan.com/#/marketing/shangou/pc/marketingEntry/inviteList?isEntryBackFill=notfill', { waitUntil: 'domcontentloaded' }); pages = [fresh];
    }
    if (pages.length !== 1) throw Error('该中台应只有一个业务标签页，请关闭重复页面后重试');
    const page = pages[0]; page.setDefaultTimeout(15000); page.setDefaultNavigationTimeout(30000);
    workflow = createWorkflow({ page, settings, brand: options.brand, state, out, save, step, beginIntent: run.beginIntent, resolveIntent: run.resolveIntent, completeCycle: run.completeCycle });
    await workflow.identity();
    const scope = await ensureAllStores(page); await workflow.identity(); step('all-stores-verified', scope);
    const version = await fetch(endpoint + '/json/version').then(r => r.json());
    const browserKey = crypto.createHash('sha256').update(version.webSocketDebuggerUrl).digest('hex');
    if (['cancel', 'register', 'confirm-register'].includes(options.phase) && (scope.switched || state.browserKey !== browserKey)) throw Error('浏览器会话或门店范围改变，请重新准备后再提交');
    if (!['verify-cancel', 'verify-register'].includes(options.phase)) state.browserKey = browserKey;
    step('connected', { brand: options.brand, account: selected.expectedAccount, phase: options.phase, mode: 'headless' });
    const actions = {
      'prepare-cancel': workflow.prepareCancel, cancel: workflow.cancel, 'verify-cancel': workflow.verifyCancel,
      'prepare-register': workflow.prepareRegister, register: workflow.register, 'confirm-register': workflow.confirmRegister,
      'verify-register': workflow.verifyRegister, 'result-details': workflow.resultDetails, verify: workflow.verify,
    };
    if (actions[options.phase]) await actions[options.phase]();
    if (options.phase === 'preflight') {
      if (await workflow.prepareCancel()) {
        const details = await workflow.frame('/shenquan/detailPc');
        await details.getByRole('button', { name: '我再想想', exact: true }).click();
        await details.getByRole('button', { name: '取消', exact: true }).click();
      }
      await workflow.prepareRegister();
    }
    if (options.phase === 'execute') {
      await workflow.prepareCancel(); await workflow.cancel(); await workflow.prepareRegister();
      await workflow.register(); await workflow.verify(); await workflow.resultDetails();
    }
    step('phase-complete', { phase: options.phase });
    if (options.phase === 'execute' && state.registerReceipt?.failed) process.exitCode = 2;
  } catch (error) {
    errorText = error.message.split('\n')[0]; state.error = { message: errorText, at: new Date().toISOString() }; save();
    console.error(errorText); if (workflow) await workflow.shot('error').catch(() => {}); process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    state.elapsedSeconds = Math.round((Date.now() - started) / 10) / 100; save();
    writeSummary(out, state, errorText);
    try { if (browser) await browser.close(); } finally { release(); }
    console.log(JSON.stringify({ resultFile: path.join(out, '结果.md'), elapsedSeconds: state.elapsedSeconds, exitCode: process.exitCode || 0 }));
  }
}

if (require.main === module) main().catch(error => { console.error(error.message.split('\n')[0]); process.exitCode = 1; });
module.exports = { parseArgs, writeSummary };
