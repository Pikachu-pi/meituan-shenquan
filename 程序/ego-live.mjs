import { createRequire } from 'node:module';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { selectAllEligibleStores, selectStoresById, waitFor } from './ego-preflight.mjs';
import { openMerchant, routes } from './ego-merchant.mjs';
import { active, parseReceipt, reconcileReadback, registrationFailures } from './ego-evidence.mjs';

const require = createRequire(import.meta.url);
const { acquireLock, atomicJson, normalizeActivityId, normalizeInventory } = require('./run-state.cjs');
const { activityTitle } = require('./ego-activity.cjs');
const { storeIds } = require('./data.cjs');
const inventoryPrompt = /^请输入\s*(\d+)\s*[-–—~～至到]\s*(\d+)\s*间的正整数$/;
const load = path => readFile(path, 'utf8').then(JSON.parse).catch(error => {
  if (error.code !== 'ENOENT') throw error;
});

function checkFinalControl({ action, final, account, activityTitle, ids, count, inventory, activate }) {
  const visible = node => node.getClientRects().length &&
    node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
  const scope = document.querySelector('.poilist-container .current-poi');
  if (document.querySelector('.acctinfo-container .txt')?.innerText.trim() !== account ||
      scope?.title !== '全部门店' || scope.querySelector('.txt')?.innerText.trim() !== '全部门店') {
    throw Error('提交前商家账号或门店范围改变');
  }
  const route = action === 'cancel' ? '/shenquan/detailPc' : '/shenquan/createPc';
  const frames = [...document.querySelectorAll('iframe')].filter(frame =>
    visible(frame) && frame.contentDocument?.URL.includes(route));
  if (frames.length !== 1) throw Error('无法唯一核对提交表单');
  const doc = frames[0].contentDocument;
  const text = doc.body.innerText;
  if (!text.split(/\r?\n/).some(line => line.trim() === activityTitle)) throw Error('提交前活动名称不一致');

  const label = action === 'cancel' ? '确认取消' : final ? '确认提交' : '提交报名';
  const buttons = [...doc.querySelectorAll('button')].filter(node =>
    visible(node) && !node.disabled && node.innerText.trim() === label);
  if (buttons.length !== 1) throw Error('无法唯一核对提交按钮');
  if (action === 'cancel') {
    const fields = [...doc.querySelectorAll('textarea')];
    if (!text.includes('确认取消报名吗') || fields.length !== 1 || fields[0].value !== ids.join(',')) {
      throw Error('取消确认及其门店 ID 不一致');
    }
  } else {
    const formCount = Number(text.match(/(\d+)\s*家\s*按门店名称\s*按门店ID/)?.[1]);
    const fields = [...doc.querySelectorAll('input[placeholder]')].filter(node =>
      visible(node) && /^请输入\s*\d+\s*[-–—~～至到]\s*\d+\s*间的正整数$/.test(node.placeholder));
    if (formCount !== count || fields.length !== 1 || fields[0].value !== String(inventory)) {
      throw Error('报名表单门店数或库存不一致');
    }
    if (final && (!text.includes('信息确认') ||
      !new RegExp('(?:^|\\D)'+inventory+'\\s*张\\s*'+count+'\\s*家').test(text))) {
      throw Error('报名二次确认门店数或库存不一致');
    }
  }
  if (activate) buttons[0].click();
  return true;
}

async function prepareRegistration(merchant, state, record) {
  const { ui, page, save, find, enrollment, assertScope, idLabel, card, hasTitle } = merchant;
  const { rows } = await enrollment('提交前报名明细');
  const existing = new Map(rows.map(row => [row['门店ID'], row]));
  const existingNonActiveIds = state.registrationIds.filter(id => existing.has(id) && !active(existing.get(id)));
  const alreadyActive = state.registrationIds.filter(id => active(existing.get(id))).length;
  const requestedIds = state.registrationIds.filter(id => !existing.has(id));
  record({ alreadyActive, existingNonActiveIds, before: rows.length });
  if (state.workbook && !requestedIds.length) return { ids: [], count: 0 };

  if ((await find('待报名')).found) await ui.button(routes.list, '立即报名', '打开指定活动报名入口', card);
  else if ((await find('已报名')).found) await ui.button(routes.list, '继续报名', '打开指定活动继续报名', card);
  else throw Error('指定活动没有报名入口');

  const intro = await waitFor(async () => {
    const text = await ui.body(routes.intro);
    return idLabel.test(text) && text;
  }, '核对报名介绍页活动 ID');
  if (activityTitle(intro, idLabel) !== state.activityTitle) throw Error('报名介绍活动名称不匹配');
  const agreement = 'label.roo-checkbox';
  await ui.one(routes.intro, agreement);
  const agreed = () => page.evaluate(route => {
    const frame = [...document.querySelectorAll('iframe')].find(item =>
      item.getClientRects().length && item.contentDocument?.URL.includes(route));
    return frame?.contentDocument.querySelector('label.roo-checkbox input[type="checkbox"]')?.checked;
  }, routes.intro);
  if (!(await agreed())) await ui.click(routes.intro, agreement, {}, '确认已核对活动规则');
  if (!(await agreed())) throw Error('活动规则复选框未选中');
  await ui.button(routes.intro, '立即报名', '打开指定活动配置');
  await waitFor(async () => hasTitle(await ui.body(routes.form)), '核对配置页活动名称');
  const field = await waitFor(async () => {
    const inputs = (await ui.read(routes.form, 'input[placeholder]')).filter(input => inventoryPrompt.test(input.placeholder));
    if (inputs.length > 1) throw Error('库存输入框不唯一');
    return inputs[0];
  }, '核对平台库存范围');
  const [, min, max] = field.placeholder.match(inventoryPrompt);
  if (state.inventory < Number(min) || state.inventory > Number(max)) throw Error('每日库存超出该活动允许范围');
  await ui.fill(routes.form, 'input[placeholder='+JSON.stringify(field.placeholder)+']', String(state.inventory));
  await assertScope();
  if (!state.workbook) {
    const count = await selectAllEligibleStores(ui, save);
    return { selectionMode: 'all-eligible', count, beforeIds: [...existing.keys()] };
  }
  const count = await selectStoresById(page, ui, requestedIds, (_stage, values) => record(values), save, { allowEmpty: true });
  const rejected = new Set(state.rejectedIds);
  const selected = requestedIds.filter(id => !rejected.has(id));
  if (selected.length !== count) throw Error('可提交的门店集合与平台选店数量不一致');
  return { ids: selected, count };
}

async function prepareCancellation(merchant, record) {
  const { enrollment, ui, assertScope } = merchant;
  const { rows, total } = await enrollment('取消前报名明细');
  record({ before: total });
  if (!total) return { ids: [], count: 0 };
  if (!rows.every(active)) throw Error('取消前明细含非生效记录，请在后台核对后再操作');
  const ids = rows.map(row => row['门店ID']);
  await assertScope();
  await ui.button(routes.details, '批量取消报名', '打开批量取消表单');
  await ui.fill(routes.details, 'textarea', ids.join(','));
  if ((await ui.one(routes.details, 'textarea')).value !== ids.join(',')) throw Error('取消门店 ID 回读与当次导出不符');
  await ui.button(routes.details, '确定', '打开取消二次确认');
  return { ids, count: ids.length };
}

async function verifySubmission(merchant, state, intent, record) {
  const { notice, closeMessages, downloadNotice, page, enrollment } = merchant;
  const register = state.action === 'register';
  const label = register ? '报名' : '取消';
  const messageTitle = label+'结果通知';
  const byName = intent.selectionMode === 'all-eligible';
  const submitted = intent.count ?? intent.ids.length;
  let receipt;
  let detailRows;
  const issues = [];
  try {
    const message = await notice(messageTitle, intent.at, label);
    await writeFile(join(state.out, label+'回执.txt'), message);
    receipt = parseReceipt(message, state.action, submitted);
    record({ submitted, ...receipt });
    if (register && (receipt.failed || byName)) {
      try {
        detailRows = await downloadNotice(messageTitle, message, intent.at, label, '报名结果明细.csv');
      } catch (error) {
        issues.push('逐店结果下载：'+error.message.split('\n')[0]);
      }
    }
  } catch (error) {
    issues.push('平台回执：'+error.message.split('\n')[0]);
  }

  try {
    await closeMessages();
    await page.reload({ timeout: 30000 });
    const { rows } = await enrollment('提交后报名明细');
    let ids = intent.ids;
    if (byName) {
      if (!detailRows) throw Error('全选报名需要本次平台逐店结果确认门店 ID');
      ids = storeIds(detailRows);
      const before = new Set(intent.beforeIds);
      if (ids.length !== submitted || ids.some(id => before.has(id))) throw Error('全选报名明细数量不符或包含提交前已有的门店');
    }
    const selected = { ...intent, ids };
    const readback = reconcileReadback(state.action, selected, receipt, rows);
    record({ readback, excludedActiveAfter: rows.filter(row => active(row) && state.excludedIds.includes(row['门店ID'])).length });
    if (detailRows) {
      const failures = registrationFailures(detailRows, selected, receipt, readback.verifiedIds);
      if (receipt.failed) {
        atomicJson(join(state.out, '报名失败门店.json'), failures);
        record({ failureReasons: failures.reasons });
      }
    }
  } catch (error) {
    issues.push('回读或逐店核对：'+error.message.split('\n')[0]);
  }
  record({ verificationPending: issues.length > 0 });
  if (issues.length) throw Error(issues.join('；'));
}

export async function runEgoLive(options, browser, connect = openMerchant) {
  const { home, out, brand, verifyOnly } = options;
  if (!['xiaocang', 'lexinyi'].includes(brand) || !['check', 'register', 'cancel'].includes(options.action)) throw Error('未知的中台或操作');
  if (!options.runId || !options.account?.trim() || (!options.profileId && !options.profileName?.trim())) throw Error('运行参数缺少身份');
  const registrationIds = options.registrationIds ?? [];
  const excludedIds = options.excludedIds ?? [];
  const allIds = [...registrationIds, ...excludedIds];
  if (allIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id)) || new Set(allIds).size !== allIds.length) throw Error('清单 ID 重复或无效');
  if (options.action === 'register' && (options.workbook ? !options.workbook.sha256 : allIds.length > 0)) {
    throw Error('报名清单和门店范围不一致');
  }
  if (options.activityTitle && !options.activityTitle.startsWith('【美团神券】')) throw Error('活动名称不是已支持的神券活动');
  if (options.action !== 'check' && !verifyOnly && options.submit !== true) {
    throw Error('正式操作需要明确提交参数');
  }

  const activityId = normalizeActivityId(options.activityId);
  const inventory = options.inventory == null ? undefined : normalizeInventory(options.inventory);
  if (options.action === 'register' && !inventory) throw Error('请提供有效的每日库存');
  const statePath = join(out, '结果.json');
  const intentPath = join(out, '提交意图.json');
  const pendingPath = join(home, 'pending', brand+'.json');
  await mkdir(out, { recursive: true });
  const release = options.action === 'check' ? () => {} : acquireLock(home, brand, out);
  const identity = { runId: options.runId, runDir: resolve(out), brand, account: options.account, activityId,
    operation: options.action, inventory, engine: 'ego-lite' };
  const sameRun = (saved, title) => saved.activityTitle === title &&
    Object.entries(identity).every(([key, value]) => saved[key] === value);
  let merchant;
  let state;
  let saveResult = false;
  const record = data => {
    Object.assign(state, data, { updatedAt: new Date().toISOString() });
    atomicJson(statePath, state);
  };
  try {
    const previous = await load(statePath);
    const intent = await load(intentPath);
    const title = options.activityTitle || (verifyOnly ? previous?.activityTitle || intent?.activityTitle : undefined);
    if (previous && (previous.runId !== options.runId || previous.brand !== brand ||
      previous.account !== options.account || previous.activityId !== activityId ||
      previous.action !== options.action || (options.action !== 'check' &&
        ((title && previous.activityTitle !== title) || previous.inventory !== inventory)))) {
      throw Error('原目录属于其他运行');
    }
    const pending = options.action === 'check' ? undefined : await load(pendingPath);
    if (intent) {
      const allEligible = options.action === 'register' && !options.workbook;
      const validIds = ids => Array.isArray(ids) && ids.every(id => typeof id === 'string' && /^\d+$/.test(id)) && new Set(ids).size === ids.length;
      const validSelection = allEligible
        ? intent.selectionMode === 'all-eligible' && Number.isSafeInteger(intent.count) && intent.count > 0 && validIds(intent.beforeIds)
        : !intent.selectionMode && validIds(intent.ids) && intent.ids.length &&
          (intent.count == null || intent.count === intent.ids.length) &&
          (options.action !== 'register' || intent.ids.every(id => registrationIds.includes(id)));
      if (!title?.startsWith('【美团神券】') || !sameRun(intent, title) ||
        !Number.isSafeInteger(intent.at) || !validSelection) throw Error('原提交意图身份或门店范围不符');
    }
    if (pending && (!verifyOnly || !sameRun(pending, title) || !intent || pending.at !== intent.at)) {
      throw Error('该中台有未决提交，请核对原运行目录 '+pending.runDir);
    }
    if (intent && !verifyOnly) throw Error('该运行已有提交意图，请用 Verify 核对原任务');
    if (verifyOnly && !intent) throw Error('该中台没有提交意图，未进入最终确认');
    if (!verifyOnly && options.action !== 'check') {
      const cycle = await load(join(home, 'active-run', brand+'.json'));
      if (cycle) throw Error('该中台旧版运行尚未收尾，请核对 '+cycle.runDir);
    }
    if (previous?.stage === 'complete') {
      if (pending) await unlink(pendingPath);
      return previous;
    }

    state = { ...previous, ...options, activityId, activityTitle: title, inventory, registrationIds, excludedIds };
    if (state.action === 'register') state.selectionMode = options.workbook ? 'store-id' : 'all-eligible';
    if (verifyOnly && previous?.profileId) state.profileId = previous.profileId;
    delete state.error;
    saveResult = true;
    if (!verifyOnly && state.action === 'register' && state.workbook && !registrationIds.length) {
      record({ stage: 'complete', submitted: 0, successful: 0, failed: 0, skipped: true, skipReason: '清单没有该中台可报名的门店 ID' });
      return state;
    }
    record({ stage: 'connecting' });
    merchant = await connect(browser, state, record);
    if (state.action === 'check') {
      const { found, total } = await merchant.enrollment('只读核验', false);
      if (!found && !(await merchant.find('待报名')).found) throw Error('已报名与待报名均找不到指定活动');
      await merchant.save('只读核验-活动');
      record({ stage: 'verified', before: total });
    } else if (verifyOnly) {
      await verifySubmission(merchant, state, intent, record);
    } else {
      const selection = state.action === 'register' ? await prepareRegistration(merchant, state, record) : await prepareCancellation(merchant, record);
      if (selection.count) {
        if (!state.activityTitle?.startsWith('【美团神券】')) throw Error('提交前未核对指定活动名称');
        const { ids, count } = selection;
        const control = { action: state.action, account: state.account, activityTitle: state.activityTitle, ids, count, inventory };
        await merchant.page.evaluate(checkFinalControl, control);
        await merchant.save('提交前');
        const at = Date.now();
        const submittedIdentity = { ...identity, activityTitle: state.activityTitle };
        const newIntent = { ...submittedIdentity, at, ...selection };
        await writeFile(intentPath, JSON.stringify(newIntent, null, 2), { flag: 'wx' });
        await mkdir(join(home, 'pending'), { recursive: true });
        await writeFile(pendingPath, JSON.stringify({ ...submittedIdentity, at, count }, null, 2), { flag: 'wx' });
        record({ stage: 'pending', intended: count, intentAt: new Date(at).toISOString() });
        if (state.action === 'register') {
          await merchant.page.evaluate(checkFinalControl, { ...control, activate: true });
          await merchant.ui.one(routes.form, 'button', { exact: '确认提交' });
          await merchant.page.evaluate(checkFinalControl, { ...control, final: true });
          await merchant.save('最终确认前');
        }
        await merchant.page.evaluate(checkFinalControl, { ...control, final: true, activate: true });
        record({ submitted: count });
        await verifySubmission(merchant, state, newIntent, record);
      } else {
        record({ submitted: 0, successful: 0, failed: 0, skipped: true });
      }
    }
    record({ stage: 'complete' });
    if (await load(intentPath)) {
      const marker = await load(pendingPath);
      if (marker && !sameRun(marker, state.activityTitle)) throw Error('未决记录归属改变');
      if (marker) await unlink(pendingPath);
    }
    try {
      await merchant.task.finish({ keep: [] });
    } catch (error) {
      record({ browserCleanupWarning: error.message.split('\n')[0] });
    }
    return state;
  } catch (error) {
    if (saveResult) {
      if (merchant) await merchant.save('停止现场').catch(() => {});
      record({ stage: 'stopped', error: error.message.split('\n')[0] });
    }
    throw error;
  } finally {
    release();
  }
}
