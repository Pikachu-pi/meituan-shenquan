import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { parseCsv, storeIds } = require('./data.cjs');
const { activityTitle, messageMatchesActivity } = require('./ego-activity.cjs');
const { atomicJson, normalizeActivityId, normalizeInventory } = require('./run-state.cjs');

const host = 'https://shangoue.meituan.com';
const listRoute = '/marketingEntry/inviteList';
const listUrl = host + '/#/marketing/shangou/pc/marketingEntry/inviteList?isEntryBackFill=notfill';
const detailsRoute = '/shenquan/detailPc';
const introRoute = '/merchant/infoNew/pc';
const formRoute = '/shenquan/createPc';
const storeHeader = '.poilist-container .current-poi';
const messageTitle = '请查收神券报名明细';
const closeNotice = 'i.roo-icon-close[style*="position: fixed"]';
const inventoryPrompt = /^请输入\s*(\d+)\s*[-–—~～至到]\s*(\d+)\s*间的正整数$/;
const markedControl = '[data-sq-ego-target]';

// Scope merchant controls to the same-origin frame. Navigation clicks use the
// DOM so a scrolled frame can be operated in its current window state.
function inspectControls({ route, selector, exact, pattern, ancestor, ancestorPattern, mark, activate }) {
  const visible = node => node.getClientRects().length && node.ownerDocument.defaultView.getComputedStyle(node).visibility === 'visible';
  let doc = document;
  if (route) {
    const frames = [...document.querySelectorAll('iframe')].filter(frame =>
      visible(frame) && frame.contentDocument?.URL.includes(route));
    if (frames.length !== 1) return [];
    doc = frames[0].contentDocument;
  }
  const re = pattern && new RegExp(pattern);
  const parentRe = ancestorPattern && new RegExp(ancestorPattern);
  const matches = [...doc.querySelectorAll(selector)].filter(node => {
    if (!visible(node)) return false;
    const text = node.innerText?.trim() || '';
    return (exact === undefined || text === exact) && (!re || re.test(text))
      && (!ancestor || parentRe.test(node.closest(ancestor)?.innerText?.trim() || ''));
  });
  if (activate && matches.length === 1) {
    const control = matches[0];
    if (['确认取消', '提交报名', '确认提交'].includes(control.innerText?.trim())) {
      throw Error('预演不能提交业务操作');
    }
    control.click();
  }
  if (mark && matches.length === 1) {
    const documents = [document, ...[...document.querySelectorAll('iframe')].map(frame => frame.contentDocument)];
    for (const current of documents) {
      current?.querySelectorAll('[data-sq-ego-target]').forEach(node => node.removeAttribute('data-sq-ego-target'));
    }
    matches[0].setAttribute('data-sq-ego-target', '');
    const rect = matches[0].getBoundingClientRect();
    const view = doc.defaultView;
    if (rect.top < 0 || rect.bottom > view.innerHeight || rect.left < 0 || rect.right > view.innerWidth) {
      matches[0].scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    }
  }
  return matches.map(node => ({
    text: node.innerText?.trim(),
    value: node.value,
    checked: node.checked,
    title: node.getAttribute('title'),
    placeholder: node.getAttribute('placeholder'),
  }));
}

export async function waitFor(read, description, timeout = 18000) {
  const end = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(200);
  } while (Date.now() < end);
  throw Error(`等待超时：${description}`);
}

export async function prepareEgoViewport(task, page) {
  const workArea = await page.evaluate(() => ({ width: screen.availWidth, height: screen.availHeight }));
  const size = workArea.width > 0 && workArea.height > 0 ? workArea : { width: 1524, height: 750 };
  const { windowId, bounds } = await task.cdp('Browser.getWindowForTarget', { targetId: page.targetId });
  if (bounds.windowState !== 'minimized') {
    await task.cdp('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await waitFor(async () => {
      const window = await task.cdp('Browser.getWindowBounds', { windowId });
      return window.bounds.windowState === 'minimized';
    }, 'Ego Lite 窗口最小化', 5000);
  }

  const readSize = () => page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Keep the agent tab at desktop size while the OS window is minimized.
  const applySize = () => page.cdp('Emulation.setDeviceMetricsOverride', {
    ...size, deviceScaleFactor: 0, mobile: false,
  });
  await applySize();
  return async () => {
    const viewport = await readSize();
    if (viewport.width !== size.width || viewport.height !== size.height) await applySize();
  };
}

export function merchantUi(page, ensureViewport) {
  const read = (route, selector, filters = {}) => page.evaluate(inspectControls, { route, selector, ...filters });
  const one = (route, selector, filters = {}, description = filters.exact ?? selector) => waitFor(async () => {
    const matches = await read(route, selector, filters);
    if (matches.length > 1) throw Error(`页面控件不唯一：${description}`);
    return matches[0];
  }, description);
  const click = (route, selector, filters, label) => one(route, selector, { ...filters, activate: true }, label);
  const clickPopup = async (route, selector, filters, label) => {
    await ensureViewport();
    await one(route, selector, { ...filters, mark: true });
    try {
      return await page.click(markedControl, { label });
    } catch (error) {
      throw Error(`${label}：${error.message.split('\n')[0]}`, { cause: error });
    }
  };
  const button = (route, exact, label, scope = {}) => click(route, 'button', { exact, ...scope }, label);
  const fill = async (route, selector, value) => {
    await ensureViewport();
    await one(route, selector, { mark: true });
    await page.fill(markedControl, value);
  };
  const body = async route => (await read(route, 'body'))[0]?.text || '';
  const selectTab = (route, tab, container = '') => waitFor(async () => {
    const pattern = `^${tab}(?:\\s|$)`;
    if ((await read(route, container + 'li.tab-item.active > a > span', { pattern })).length) return true;
    await click(route, container + 'li.tab-item > a > span', { pattern }, `打开${tab}页签`);
    return false;
  }, `等待${tab}页签选中`);
  return { read, one, click, button, clickPopup, fill, body, selectTab };
}

function matchesExport(text, { account, activityId }, since) {
  const stamp = text.match(/于(\d{4})年(\d{2})月(\d{2})日(\d{2}):(\d{2}):(\d{2})/);
  if (!stamp || !text.includes(`商家账号${account}于`) || !messageMatchesActivity(text, activityId)) return false;
  const [, y, m, d, hh, mm, ss] = stamp;
  return Date.parse(`${y}-${m}-${d}T${hh}:${mm}:${ss}+08:00`) >= since - 2000;
}

export async function selectStoresById(page, ui, registrationIds, record, savePageState, { allowEmpty = false } = {}) {
  const field = 'textarea[placeholder^="请批量输入门店ID"]';
  const value = registrationIds.join(',');
  const selectionReview = '.poi-check .roo-panel-title';
  await ui.click(formRoute, 'span.add-btn', { exact: '按门店ID' }, '按门店 ID 选店');
  await ui.fill(formRoute, field, value);
  await page.press(markedControl, 'Tab');
  if ((await ui.one(formRoute, field)).value !== value) throw Error('报名门店 ID 回读与清单不一致');
  await ui.click(formRoute, 'button', { pattern: '^确\\s*定$' }, '检查报名门店 ID');

  const outcome = await waitFor(async () => {
    if ((await ui.read(formRoute, selectionReview)).length) return 'review';
    if (!(await ui.read(formRoute, field)).length) return 'applied';
  }, '读取平台按 ID 选店结果');

  const rejected = new Set();
  const reasons = [];
  if (outcome === 'review') {
    const requested = new Set(registrationIds);
    const panels = await ui.read(formRoute, selectionReview);
    for (const { text } of panels) {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const panel = { ancestor: '.poi-check-panel', ancestorPattern: '^' + escaped + '(?:\\s|$)' };
      await ui.click(formRoute, '.poi-check .roo-panel-collapse-flag', panel, `展开平台校验：${text}`);
      const body = await ui.one(formRoute, '.poi-check .roo-panel-body', panel);
      const ids = body.text.split(/[,\s]+/).filter(Boolean);
      if (!ids.length || ids.some(id => !requested.has(id) || rejected.has(id))) {
        throw Error('平台返回的不可选门店与本次输入清单不一致');
      }
      for (const id of ids) rejected.add(id);
      reasons.push({ reason: text, count: ids.length });
    }
    await savePageState('报名按ID平台校验');
  }

  const accepted = registrationIds.length - rejected.size;
  record('registration-id-checked', {
    platformExcludedCount: rejected.size, platformExcludedReasons: reasons, rejectedIds: [...rejected],
  });
  if (!accepted && allowEmpty) return 0;
  if (!accepted) throw Error('平台校验后没有可选门店：' + reasons.map(({ reason, count }) => `${reason} ${count} 家`).join('，'));
  if (outcome === 'review') {
    await ui.button(formRoute, '继续设置', '应用平台可选门店', {
      ancestor: '.poi-check', ancestorPattern: '如继续设置',
    });
  }
  const actual = await waitFor(async () => {
    const count = (await ui.body(formRoute)).match(/(\d+)\s*家\s*按门店名称\s*按门店ID/);
    return count && Number(count[1]) === accepted ? accepted : null;
  }, '核对按 ID 选店后的表单门店数');
  return actual;
}

export async function selectAllEligibleStores(ui, savePageState) {
  const confirm = { pattern: '^确\\s*定$' };
  await ui.click(formRoute, 'span.add-btn', { exact: '按门店名称' }, '按门店名称选店');
  await ui.click(formRoute, 'span.custom-checkbox-label', { exact: '全选所有页' }, '选择全部可报名门店');
  const { count } = await waitFor(async () => {
    const text = await ui.body(formRoute);
    const selected = Number(text.match(/已选门店\s*[（(](\d+)[)）]/)?.[1]);
    if (selected) return { count: selected };
    if (selected === 0 && /暂无可报名门店|暂无数据|没有符合条件的门店/.test(text)) return { count: 0 };
  }, '读取全选后的可报名门店数');
  await savePageState('报名选店');
  if (!count) return 0;
  await ui.click(formRoute, 'button', confirm, '确认选店弹窗范围');
  await waitFor(async () => {
    const text = await ui.body(formRoute);
    const formCount = Number(text.match(/(\d+)\s*家\s*按门店名称\s*按门店ID/)?.[1]);
    return formCount === count && !(await ui.read(formRoute, 'button', confirm)).length;
  }, '核对全选后表单门店数');
  return count;
}

async function preflight(page, state, out, record, registrationIds, ensureViewport) {
  const ui = merchantUi(page, ensureViewport);
  const savePageState = async name => {
    await writeFile(join(out, name + '.txt'), await page.snapshot());
  };
  const idLabel = new RegExp(`活动\\s*ID\\s*[:：]\\s*${state.activityId}(?!\\d)`);
  const card = { ancestor: '.sgyx-shop-invite-card', ancestorPattern: idLabel.source };
  const inventorySelector = 'input[placeholder]';
  const inventoryFields = async () => (await ui.read(formRoute, inventorySelector))
    .filter(input => inventoryPrompt.test(input.placeholder));
  const assertScope = async () => {
    const account = await ui.one(null, '.acctinfo-container .txt');
    if (account.text !== state.account) throw Error('当前商家账号与本次指定账号不符');
    const header = await ui.one(null, storeHeader);
    if (header.text !== '全部门店' || header.title !== '全部门店') throw Error('当前门店范围不是全部门店');
  };
  const closeMessages = async () => {
    if ((await ui.read(null, closeNotice)).length) {
      await ui.click(null, closeNotice, {}, '关闭平台消息面板');
      await waitFor(async () => !(await ui.read(null, closeNotice)).length, '关闭平台消息');
    }
  };
  const findActivity = async tab => {
    const currentUrl = await page.url();
    if (!currentUrl.includes(listRoute)) await page.goto(listUrl, { timeout: 30000 });
    else if (!(await ui.read(listRoute, 'li.tab-item')).length) await page.reload({ timeout: 30000 });
    await ensureViewport();
    await assertScope();
    await ui.selectTab(listRoute, tab);
    await ui.fill(listRoute, 'input[label="活动ID"]', state.activityId);
    await ui.button(listRoute, '查询', '查询指定神券活动');
    return waitFor(async () => {
      const text = await ui.body(listRoute);
      if (text.includes('正在加载')) return null;
      const cards = await ui.read(listRoute, card.ancestor, { pattern: idLabel.source });
      if (cards.length > 1) throw Error('找到多张匹配活动 ID 的卡片');
      if (cards.length) return { found: true };
      if (text.includes('暂无报名活动')) return { found: false };
    }, `查询${tab}的活动 ${state.activityId}`);
  };

  if (!(await page.url()).startsWith(host + '/')) await page.goto(listUrl, { timeout: 30000 });
  await ensureViewport();
  const account = await ui.one(null, '.acctinfo-container .txt');
  if (account.text !== state.account) throw Error(`账号不匹配，当前显示 ${account.text}`);
  const scope = await ui.one(null, storeHeader);
  if (scope.text !== scope.title) throw Error('门店范围标题和可见文字不一致');
  if (scope.title !== '全部门店') {
    await ensureViewport();
    const option = '.poi-list .content[title="全部门店"]';
    if (!(await ui.read(null, option)).length) await page.click(storeHeader, { label: '打开门店范围选择' });
    await page.waitForSelector(option, { timeout: 10000 });
    await page.click(option, { label: '切换到全部门店' });
    await waitFor(async () => (await ui.read(null, storeHeader))[0]?.title === '全部门店', '切换到全部门店');
  }
  await assertScope();
  record('scope-verified', { scope: '全部门店' });

  const enrolled = await findActivity('已报名');
  if (enrolled.found) {
    await ui.button(listRoute, '报名详情', '打开神券报名详情', card);
    await ui.selectTab(detailsRoute, '报名信息');
    const total = Number((await waitFor(async () => (await ui.body(detailsRoute)).match(/共\s*(\d+)\s*条数据/), '读取已报名门店总数'))[1]);
    await assertScope();
    record('export-requested', { listedCount: total });
    const since = Date.now();
    await ui.button(detailsRoute, '下载报名信息', '导出当前报名明细');
    const message = await waitFor(async () => {
      await closeMessages();
      await ui.click(null, '.notice-box[role="button"]', {}, '打开美团平台消息');
      await ui.selectTab(null, '店铺运营', '.notice-box__tab ');
      const cards = await ui.read(null, '.normal-msg-card');
      const found = cards.find(({ text }) => text.includes(messageTitle) && matchesExport(text, state, since));
      if (!found) await delay(1500);
      return found?.text;
    }, '接收本次导出消息', 100000);
    const popupWait = page.waitForEvent('popup', { timeout: 20000 });
    const cardPattern = '^' + message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$';
    const [popup] = await Promise.all([popupWait, ui.clickPopup(null, '.normal-msg-card__head-title', {
      exact: messageTitle, ancestor: '.normal-msg-card', ancestorPattern: cardPattern,
    }, '打开本次导出消息')]);
    const url = await waitFor(async () => {
      const candidate = new URL(await popup.url());
      return candidate.searchParams.has('downloadUrl') && candidate;
    }, '读取导出消息下载页');
    if (!matchesExport(url.searchParams.get('content1') || '', state, since)) throw Error('下载页与本次账号、活动或时间不匹配');
    const title = message.match(/下载的神券活动(.+?)[（(]\s*id\s*[:：]\s*\d+\s*[）)]/i)?.[1].trim();
    if (!title) throw Error('导出消息缺少可核对的神券活动名称');
    const link = new URL(url.searchParams.get('downloadUrl'));
    if (link.protocol !== 'https:' || link.hostname !== 'dpurl.cn') throw Error('报名明细下载地址不符合预期');
    const downloadPath = join(out, '报名明细.csv');
    const response = await fetch(link, { signal: AbortSignal.timeout(30000) });
    if (response.status !== 200 || !/^text\/csv\b/i.test(response.headers.get('content-type') || '')) {
      throw Error('平台未返回有效的报名明细 CSV');
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(downloadPath, bytes);
    const rows = parseCsv(bytes.toString('utf8'));
    const ids = storeIds(rows);
    if (!ids.length || ids.length !== total || rows.some(row => row['状态'] !== '生效中')) {
      throw Error('CSV 的报名数量或状态与页面不一致');
    }
    await writeFile(join(out, '取消门店ID.txt'), ids.join('\n'));
    await writeFile(join(out, '导出消息.txt'), message);
    record('export-verified', { activityTitle: title, enrolledCount: ids.length, csvSha256: createHash('sha256').update(bytes).digest('hex') });
    await popup.close();
    await closeMessages();
    await assertScope();
    await ui.button(detailsRoute, '批量取消报名', '打开批量取消表单');
    await ui.fill(detailsRoute, 'textarea', ids.join(','));
    if ((await ui.one(detailsRoute, 'textarea')).value !== ids.join(',')) throw Error('取消表单门店 ID 回读不一致');
    await ui.button(detailsRoute, '确定', '查看取消二次确认');
    await ui.one(detailsRoute, 'button', { exact: '确认取消' });
    await savePageState('取消确认前');
    await ui.button(detailsRoute, '我再想想', '退出取消确认弹窗');
    record('cancel-previewed', { cancelConfirmationReached: true });
  } else {
    record('cancel-skipped', { enrolledCount: 0, cancelConfirmationReached: false });
  }

  const pending = await findActivity('待报名');
  if (pending.found) await ui.button(listRoute, '立即报名', '打开神券报名入口', card);
  else {
    const current = await findActivity('已报名');
    if (!current.found) throw Error('当前活动没有可用报名入口');
    await ui.button(listRoute, '继续报名', '打开继续报名入口', card);
  }
  const introText = await waitFor(async () => {
    const text = await ui.body(introRoute);
    return idLabel.test(text) && text;
  }, '核对报名介绍页活动 ID');
  const title = activityTitle(introText, idLabel);
  if (!title || (state.activityTitle && state.activityTitle !== title)) throw Error('报名介绍与已报名活动名称不一致');
  record('registration-activity-verified', { activityTitle: title });
  const agreement = 'label.roo-checkbox';
  await ui.one(introRoute, agreement);
  // The actual checkbox may be visually hidden under its styled label.
  const agreed = () => page.evaluate(route => {
    const frame = [...document.querySelectorAll('iframe')].find(item =>
      item.getClientRects().length && item.contentDocument?.URL.includes(route));
    return frame?.contentDocument.querySelector('label.roo-checkbox input[type="checkbox"]')?.checked;
  }, introRoute);
  if (!(await agreed())) await ui.click(introRoute, agreement, {}, '勾选活动规则确认');
  if (!(await agreed())) throw Error('报名规则复选框未选中');
  await ui.button(introRoute, '立即报名', '打开报名配置表单');
  await waitFor(async () => (await ui.body(formRoute)).split('\n').some(line => line.trim() === title), '核对配置表单活动');
  const field = await waitFor(async () => {
    const fields = await inventoryFields();
    if (fields.length > 1) throw Error('库存输入框不唯一');
    return fields[0];
  }, '读取平台库存范围');
  const [, min, max] = field.placeholder.match(inventoryPrompt);
  if (state.inventory < Number(min) || state.inventory > Number(max)) throw Error(`库存超出活动范围 ${min}–${max}`);
  const fieldSelector = `input[placeholder=${JSON.stringify(field.placeholder)}]`;
  await ui.fill(formRoute, fieldSelector, String(state.inventory));
  await assertScope();
  const selected = state.selectionMode === 'store-id'
    ? (registrationIds.length ? await selectStoresById(page, ui, registrationIds, record, savePageState, { allowEmpty: true }) : 0)
    : await selectAllEligibleStores(ui, savePageState);
  if (!selected) {
    record('registration-skipped', { eligibleSelected: 0 });
    return;
  }
  if ((await ui.one(formRoute, fieldSelector)).value !== String(state.inventory)) throw Error('提交前的库存回读不一致');
  await assertScope();
  await ui.one(formRoute, 'button', { exact: '提交报名' });
  await savePageState('报名提交前');
  record('registration-previewed', { eligibleSelected: selected, registrationSubmitReached: true });
}

export async function runEgoPreflight(options) {
  const { out, brand, profileName, account, taskName } = options;
  const activityId = normalizeActivityId(options.activityId);
  const inventory = normalizeInventory(options.inventory);
  const file = join(out, '结果.json');
  const excludedCount = options.excludedCount ?? 0;
  const registrationIds = options.registrationIds ?? [];
  const hasWorkbook = Boolean(options.exclusionWorkbook || excludedCount || registrationIds.length);
  if (!Number.isSafeInteger(excludedCount) || excludedCount < 0 || !Array.isArray(registrationIds)
    || registrationIds.some(id => typeof id !== 'string' || !/^\d+$/.test(id))
    || new Set(registrationIds).size !== registrationIds.length) {
    throw Error('剔除后的报名清单没有有效门店，或运行参数不一致');
  }
  const state = { brand, profileName, account, activityId, inventory, excludedCount,
    ...(options.exclusionWorkbook && { exclusionWorkbook: options.exclusionWorkbook }),
    requestedCount: registrationIds.length, selectionMode: hasWorkbook ? 'store-id' : 'all-eligible',
    cancelSubmitted: false, registrationSubmitted: false };
  const record = (stage, data) => {
    Object.assign(state, data, { stage, updatedAt: new Date().toISOString() });
    atomicJson(file, state);
  };
  try {
    const matchingProfiles = (await profiles()).filter(profile => profile.name === profileName);
    if (matchingProfiles.length !== 1) throw Error(`请在 Ego Lite 中配置唯一资料「${profileName}」`);
    const profileId = matchingProfiles[0].id;
    const existing = (await listTaskSpaces()).find(space => space.name === taskName && space.profileId === profileId);
    if (existing && existing.ownership !== 'agent' && !options.resume) throw Error('任务空间已交给你，处理完提示后用 -Resume 继续');
    const task = existing
      ? (existing.ownership === 'agent' ? await taskSpace(existing.id) : await takeOverTaskSpace(existing.id))
      : await taskSpace(taskName, { profileId });
    record('connected', { spaceId: task.spaceId });
    const page = task.page('p1');
    const ensureViewport = await prepareEgoViewport(task, page);
    await preflight(page, state, out, record, registrationIds, ensureViewport);
    await task.finish({ keep: [] });
    record('complete');
    console.log(JSON.stringify(state));
  } catch (error) {
    record('stopped', { error: error.message.split('\n')[0] });
    throw error;
  }
}
