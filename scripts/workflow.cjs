'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { assertAllStores } = require('./store-scope.cjs');
const { parseCsv, storeIds, originalStoreDiff } = require('./data.cjs');

const INVENTORY_PROMPT = /^请输入\s*(\d+)\s*[-–—~～至到]\s*(\d+)\s*间的正整数$/;

function activityTitle(text, idLabel) {
  const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (idLabel) {
    const idLine = lines.findIndex(line => idLabel.test(line));
    return idLine > 0 ? lines[idLine - 1] : undefined;
  }
  return lines.find(line => /^【美团神券】.+/.test(line));
}

function messageMatchesActivity(text, id, title) {
  const ids = [...text.matchAll(/\bID\s*[:：]\s*(\d+)/gi)];
  if (ids.length) return ids.some(match => match[1] === id);
  return Boolean(title && text.includes(`【${title}】活动`));
}

function createWorkflow({ page, settings, brand, state, out, save, step, beginIntent, resolveIntent, completeCycle }) {
const account = settings.brands[brand].expectedAccount;
const { activityId, inventory } = state;
const activityLabel = new RegExp(`活动\\s*ID\\s*[:：]\\s*${activityId}(?!\\d)`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 30000) { const end = Date.now() + timeout; let last; do { try { const result = await fn(); if (result) return result; } catch (e) { last = e; } await sleep(250); } while (Date.now() < end); throw Error(`State wait timed out${last ? ': ' + last.message : ''}`); }
async function frame(part) { return until(() => page.frames().find(f => f !== page.mainFrame() && f.url().includes(part))); }
async function identity() { await until(async () => { const label = page.locator('.acctinfo-container .txt'); return await label.count() === 1 && (await label.innerText()).trim() === account; }, 20000); }
async function shot(name) { await page.screenshot({ path: path.join(out, name + '.png'), timeout: 10000 }); }
async function closeMessages() { const close = page.locator('i.roo-icon-close[style*="position: fixed"]'); if (await close.isVisible().catch(() => false)) { await close.click(); await close.waitFor({ state: 'hidden' }); } }
async function messages() {
  await assertAllStores(page);
  await closeMessages(); await page.locator('.notice-box[role="button"]').click();
  await page.getByText('店铺运营', { exact: false }).click();
  await page.locator('.normal-msg-card').filter({ hasText: '商家账号' }).first().waitFor({ state: 'visible' });
}
function messageTime(text) { const m = text.match(/于(\d{4})年(\d{2})月(\d{2})日(\d{2}):(\d{2}):(\d{2})/); return m ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) : NaN; }
function rememberActivityTitle(title) {
  if (!title) throw Error(`活动 ${activityId} 的名称或神券页面格式无法识别`);
  if (state.activityTitle && state.activityTitle !== title) throw Error(`活动 ${activityId} 的名称与原记录不一致`);
  if (!state.activityTitle) { state.activityTitle = title; save(); }
}
function exportedActivityTitle(text) {
  return text.match(/下载的神券活动(.+?)[（(]\s*id\s*[:：]\s*\d+\s*[）)]/i)?.[1].trim();
}
function savedActivityTitle() {
  if (state.activityTitle) return state.activityTitle;
  const exportNote = path.join(out, 'before-cancel-export-message.txt');
  if (fs.existsSync(exportNote)) {
    const text = fs.readFileSync(exportNote, 'utf8');
    const title = exportedActivityTitle(text);
    if (title && matchesMessage(text, 0)) return title;
  }
  const registerNote = path.join(out, 'register-after-submit.txt');
  if (fs.existsSync(registerNote)) return activityTitle(fs.readFileSync(registerNote, 'utf8'));
}
function matchesMessage(text, since, title) {
  return text.includes(`商家账号${account}于`) && messageTime(text) >= since - 2000 && messageMatchesActivity(text, activityId, title);
}
async function currentMessage(title, since, timeout = 120000) {
  const end = Date.now() + timeout;
  const name = title === '请查收神券报名明细' ? undefined : savedActivityTitle();
  do {
    await messages();
    const cards = page.locator('.normal-msg-card').filter({ hasText: title });
    for (let i = 0; i < await cards.count(); i++) {
      const card = cards.nth(i); const text = await card.innerText();
      if (matchesMessage(text, since, name)) return { card, text };
    }
    await closeMessages(); await sleep(1500);
  } while (Date.now() < end);
  throw Error(`No current ${title} receipt; do not resubmit`);
}
async function list(tab) {
  await assertAllStores(page);
  await closeMessages(); await identity();
  const route = '#/marketing/shangou/pc/marketingEntry/inviteList';
  if (page.url().includes(route)) await page.reload({ waitUntil: 'domcontentloaded' });
  else await page.goto(`https://shangoue.meituan.com/${route}?isEntryBackFill=notfill`, { waitUntil: 'domcontentloaded' });
  const f = await frame('/marketingEntry/inviteList');
  await assertAllStores(page); await identity();
  await f.locator('li.tab-item').filter({ hasText: tab }).click();
  await f.locator('input[label="活动ID"]').fill(activityId);
  await f.getByRole('button', { name: '查询', exact: true }).click();
  await until(async () => {
    const text = await f.locator('body').innerText();
    return !text.includes('正在加载') && (activityLabel.test(text) || text.includes('暂无报名活动'));
  }).catch(error => { throw Error(`查询活动 ${activityId} 超时，请核对活动 ID 和页面`, { cause: error }); });
  return f;
}
async function details({ allowEmpty = false } = {}) {
  const f = await list('已报名');
  const card = f.locator('.sgyx-shop-invite-card').filter({ hasText: activityLabel });
  if (await card.count() === 0 && allowEmpty) return null;
  if (await card.count() !== 1) throw Error('Expected exactly one registered activity card');
  await card.getByRole('button', { name: '报名详情', exact: true }).click();
  const d = await frame('/shenquan/detailPc');
  await d.getByText('报名信息', { exact: true }).click();
  await d.getByRole('button', { name: '下载报名信息', exact: true }).waitFor();
  return d;
}
async function exportCsv(label, d) {
  await assertAllStores(page);
  await identity(); const since = Date.now();
  const [r] = await Promise.all([
    page.waitForResponse(r => new URL(r.url()).pathname.endsWith('/sg/downPoiApply')),
    d.getByRole('button', { name: '下载报名信息', exact: true }).click(),
  ]);
  const ack = await r.json();
  if (r.status() !== 200 || ack.code !== 0 || ack.success === false) throw Error('Export creation rejected');
  step(label + '-export-requested', { since, acknowledgment: ack });
  const msg = await currentMessage('请查收神券报名明细', since);
  fs.writeFileSync(path.join(out, label + '-export-message.txt'), msg.text);
  const [popup] = await Promise.all([page.waitForEvent('popup'), msg.card.locator('.normal-msg-card__head-title').click()]);
  await popup.waitForLoadState('domcontentloaded');
  const u = new URL(popup.url()); const content = u.searchParams.get('content1') || '';
  if (!matchesMessage(content, since)) throw Error('Download page does not belong to this export');
  const title = exportedActivityTitle(msg.text);
  if (title) rememberActivityTitle(title);
  const link = u.searchParams.get('downloadUrl'); if (!link || new URL(link).hostname !== 'dpurl.cn') throw Error('Unexpected download host');
  const file = await page.request.get(link, { timeout: 45000, maxRetries: 2 }); const bytes = await file.body();
  if (file.status() !== 200 || !(file.headers()['content-type'] || '').includes('csv')) throw Error('Download is not a successful CSV');
  const rows = parseCsv(bytes.toString('utf8')); const ids = storeIds(rows);
  fs.writeFileSync(path.join(out, label + '.csv'), bytes); fs.writeFileSync(path.join(out, label + '-rows.json'), JSON.stringify(rows, null, 2));
  fs.writeFileSync(path.join(out, label + '-ids.txt'), ids.join('\n'));
  step(label + '-csv-downloaded', { count: ids.length, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
  await popup.close(); await closeMessages(); return { rows, ids };
}
async function prepareCancel({ checkRegistration = false } = {}) {
  if (state.cancelIntent) throw Error('Existing cancellation intent; inspect its receipt before another operation');
  if (checkRegistration) {
    await openRegistrationForm();
    state.registrationChecked = true;
    save();
  }
  const d = await details({ allowEmpty: true });
  if (!d) {
    state.cancelIds = []; state.cancelCount = 0;
    state.cancelIntent = { outcome: 'confirmed', skipped: true, count: 0 };
    save(); step('cancel-not-needed', { count: 0 }); return false;
  }
  await until(async () => /共\s*\d+\s*条数据/.test(await d.locator('body').innerText()));
  const total = Number((await d.locator('body').innerText()).match(/共\s*(\d+)\s*条数据/)[1]);
  const { rows, ids } = await exportCsv('before-cancel', d);
  if (!ids.length || ids.length !== total || rows.some(r => r['状态'] !== '生效中')) throw Error('CSV does not reconcile with active registration list');
  state.cancelIds = ids; state.cancelCount = ids.length; save();
  await assertAllStores(page);
  await d.getByRole('button', { name: '批量取消报名', exact: true }).click();
  await d.locator('textarea').fill(ids.join(','));
  await d.getByRole('button', { name: '确定', exact: true }).click();
  await d.getByRole('button', { name: '确认取消', exact: true }).waitFor();
  await shot('cancel-ready'); step('cancel-ready', { count: ids.length });
  return true;
}
async function cancel() {
  if (state.cancelIntent?.skipped) { step('cancel-not-needed', { count: 0 }); return; }
  if (state.cancelIntent || !state.cancelIds?.length) throw Error('Cancellation is not a fresh prepared operation');
  if (!state.registrationChecked) throw Error('请先重新准备取消，校验本次报名表单和库存');
  await assertAllStores(page); await identity(); const d = await frame('/shenquan/detailPc');
  if ((await d.locator('textarea').inputValue()) !== state.cancelIds.join(',')) throw Error('Cancellation input changed');
  await d.getByRole('button', { name: '确认取消', exact: true }).waitFor();
  await assertAllStores(page);
  state.cancelIntent = { at: Date.now(), count: state.cancelCount, outcome: 'unknown' }; save(); beginIntent('cancel', state.cancelIntent);
  await d.getByRole('button', { name: '确认取消', exact: true }).click();
  await verifyCancel();
}
async function verifyCancel() {
  if (!state.cancelIntent) throw Error('No cancellation submission to reconcile');
  const msg = await currentMessage('取消结果通知', state.cancelIntent.at);
  fs.writeFileSync(path.join(out, 'cancel-receipt.txt'), msg.text);
  const m = msg.text.match(/取消成功门店数\s*(\d+)个[，,]\s*失败\s*(\d+)个/);
  if (!m || Number(m[1]) !== state.cancelCount || Number(m[2]) !== 0) throw Error('Cancellation receipt is incomplete or reports failures');
  state.cancelIntent.outcome = 'confirmed'; state.cancelReceipt = msg.text; save(); resolveIntent('cancel');
  await shot('cancel-receipt'); step('cancel-confirmed', { successful: Number(m[1]), failed: Number(m[2]) }); await closeMessages();
}
async function assertRegistrationActivity(create) {
  const title = savedActivityTitle();
  if (!title) throw Error(`无法确认当前报名表单对应活动 ${activityId}，请重新准备报名`);
  await create.getByText(title, { exact: true }).waitFor({ state: 'visible' });
}
async function assertInventory(field) {
  if (await field.inputValue() !== String(inventory)) throw Error(`库存未保留为本次指定的 ${inventory} 张`);
}
async function openRegistrationForm() {
  let f = await list('待报名');
  let card = f.locator('.sgyx-shop-invite-card').filter({ hasText: activityLabel });
  let action = '立即报名';
  if (await card.count() === 0) {
    f = await list('已报名');
    card = f.locator('.sgyx-shop-invite-card').filter({ hasText: activityLabel });
    action = '继续报名';
  }
  if (await card.count() !== 1) throw Error(`找不到活动 ${activityId} 的报名入口`);
  await card.getByRole('button', { name: action, exact: true }).click();
  const intro = await frame('/merchant/infoNew/pc');
  await intro.locator('body').filter({ hasText: activityLabel }).waitFor({ state: 'visible' });
  rememberActivityTitle(activityTitle(await intro.locator('body').innerText(), activityLabel));
  const agreement = intro.locator('input[type="checkbox"]');
  if (!await agreement.isChecked()) await intro.locator('label.roo-checkbox').click();
  if (!await agreement.isChecked()) throw Error('Agreement checkbox did not become checked');
  await intro.getByRole('button', { name: '立即报名', exact: true }).click();
  const create = await frame('/shenquan/createPc');
  await assertRegistrationActivity(create);
  const field = create.getByPlaceholder(INVENTORY_PROMPT);
  await field.waitFor({ state: 'visible' }).catch(error => { throw Error(`活动 ${activityId} 的库存输入框不符合当前支持的神券表单`, { cause: error }); });
  const range = (await field.getAttribute('placeholder'))?.match(INVENTORY_PROMPT);
  if (!range) throw Error(`无法读取活动 ${activityId} 的库存范围`);
  const [, min, max] = range;
  if (inventory < Number(min) || inventory > Number(max)) throw Error(`活动 ${activityId} 的库存范围为 ${min}–${max} 张，本次填写 ${inventory} 张`);
  await field.fill(String(inventory));
  await field.blur();
  await assertInventory(field);
  await create.getByText('按门店名称', { exact: true }).waitFor({ state: 'visible' });
  await create.getByRole('button', { name: '提交报名', exact: true }).waitFor({ state: 'visible' });
  return { create, field };
}
async function prepareRegister() {
  await assertAllStores(page);
  if (state.cancelIntent && state.cancelIntent.outcome !== 'confirmed') throw Error('Cancellation outcome is unknown');
  if (state.registerIntent) throw Error('Registration was already submitted or has unknown outcome');
  const existingCreate = page.frames().find(f => f.url().includes('/shenquan/createPc'));
  if (existingCreate && state.registerCount && await existingCreate.getByRole('button', { name: /^确\s*定$/ }).isVisible().catch(() => false)) {
    await assertRegistrationActivity(existingCreate);
    const selected = (await existingCreate.locator('body').innerText()).match(/已选门店\s*[（(](\d+)[)）]/);
    if (!selected || Number(selected[1]) !== state.registerCount) throw Error('Prepared selection changed');
    await existingCreate.getByRole('button', { name: /^确\s*定$/ }).click();
    await existingCreate.getByRole('button', { name: /^确\s*定$/ }).waitFor({ state: 'hidden' });
    await assertInventory(existingCreate.getByPlaceholder(INVENTORY_PROMPT));
    await shot('register-ready'); step('register-ready', { count: state.registerCount, inventory }); return;
  }
  const { create, field } = await openRegistrationForm();
  await assertAllStores(page);
  await create.getByText('按门店名称', { exact: true }).click();
  await create.getByText('全选所有页', { exact: true }).click();
  const selected = await until(async () => (await create.locator('body').innerText()).match(/已选门店\s*[（(](\d+)[)）]/));
  state.registerCount = Number(selected[1]); if (!state.registerCount) throw Error('No eligible stores selected');
  await shot('register-selected');
  await create.getByRole('button', { name: /^确\s*定$/ }).click();
  await create.getByRole('button', { name: /^确\s*定$/ }).waitFor({ state: 'hidden' });
  await assertInventory(field);
  await create.getByRole('button', { name: '提交报名', exact: true }).waitFor();
  save(); await shot('register-ready'); step('register-ready', { count: state.registerCount, inventory });
}
async function register() {
  await assertAllStores(page);
  if (state.registerIntent || !state.registerCount) throw Error('Registration is not a fresh prepared operation');
  if (state.cancelIntent?.outcome !== 'confirmed') throw Error('Execution requires confirmed cancellation');
  await closeMessages(); await identity(); const create = await frame('/shenquan/createPc');
  await assertRegistrationActivity(create);
  await assertInventory(create.getByPlaceholder(INVENTORY_PROMPT));
  if (!(await create.locator('body').innerText()).includes(`${state.registerCount}家按门店名称`)) throw Error('Selected store count changed');
  state.registerIntent = { at: Date.now(), count: state.registerCount, outcome: 'prepared', finalClicked: false }; save();
  await create.getByRole('button', { name: '提交报名', exact: true }).click();
  step('register-submit-clicked');
  await shot('register-after-submit');
  const text = await create.locator('body').innerText().catch(() => '');
  fs.writeFileSync(path.join(out, 'register-after-submit.txt'), text);
  await create.getByRole('button', { name: '确认提交', exact: true }).waitFor();
  await confirmRegister();
}
async function confirmRegister() {
  await assertAllStores(page);
  if (!state.registerIntent || state.registerIntent.finalClicked || state.registerIntent.outcome === 'confirmed') throw Error('No fresh final registration confirmation');
  if (state.cancelIntent?.outcome !== 'confirmed') throw Error('Cancellation is not confirmed');
  await closeMessages(); await identity(); const create = await frame('/shenquan/createPc');
  await assertRegistrationActivity(create);
  const text = await create.locator('body').innerText();
  if (!text.includes('信息确认') || !new RegExp(`(?:^|\\D)${inventory}\\s*张\\s*${state.registerCount}\\s*家`).test(text)) throw Error('Final registration count/inventory confirmation mismatch');
  await create.getByRole('button', { name: '确认提交', exact: true }).waitFor();
  await create.getByRole('button', { name: '确认提交', exact: true }).click({ trial: true });
  await shot('register-final-confirmation');
  await assertAllStores(page);
  state.registerIntent.at = Date.now(); state.registerIntent.finalClicked = true; state.registerIntent.outcome = 'unknown'; save(); beginIntent('register', state.registerIntent);
  await create.getByRole('button', { name: '确认提交', exact: true }).click();
  step('register-final-clicked', { count: state.registerCount, inventory });
  await verifyRegister();
}
async function verifyRegister() {
  if (!state.registerIntent?.finalClicked) throw Error('No final registration submission to reconcile');
  const msg = await currentMessage('报名结果通知', state.registerIntent.at, 90000);
  fs.writeFileSync(path.join(out, 'register-receipt.txt'), msg.text);
  const m = msg.text.match(/报名成功门店数\s*(\d+)个?[，,]\s*(?:报名)?失败\s*(\d+)(?:个|家)?/);
  if (!m) throw Error('Registration receipt could not be parsed; inspect saved receipt');
  if (Number(m[1]) + Number(m[2]) !== state.registerCount) throw Error('Registration receipt count mismatch');
  state.registerIntent.outcome = 'confirmed'; state.registerReceipt = { successful: Number(m[1]), failed: Number(m[2]), text: msg.text }; save(); resolveIntent('register');
  await shot('register-receipt'); step('register-confirmed', state.registerReceipt); await closeMessages();
}
async function verify() {
  const d = await details(); const result = await exportCsv('after-register', d);
  const missing = originalStoreDiff(state.cancelIds || [], result.rows);
  const invalid = result.rows.filter(r => r['状态'] !== '生效中' || r['每日神券库存'] !== `${inventory}张`);
  state.verification = { activeCount: result.ids.length, missingOriginalIds: missing, invalidRows: invalid }; save();
  step('readback-verified', state.verification);
  if (missing.length || invalid.length) throw Error('Registration readback has missing stores or invalid inventory/status');
  if (state.registerIntent?.outcome === 'confirmed' && completeCycle) completeCycle();
}
async function resultDetails() {
  if (state.registerIntent?.outcome !== 'confirmed') throw Error('No confirmed registration receipt');
  const cached = path.join(out, 'register-result-details.csv');
  const sourceFile = path.join(out, 'register-result-source.json');
  let bytes;
  if (fs.existsSync(cached) && fs.existsSync(sourceFile)) {
    const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    bytes = fs.readFileSync(cached);
    if (source.account !== account || source.activityId !== activityId || source.submittedAt !== state.registerIntent.at || source.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) throw Error('Cached result provenance mismatch');
  }
  else {
  const msg = await currentMessage('报名结果通知', state.registerIntent.at);
  const [popup] = await Promise.all([page.waitForEvent('popup'), msg.card.locator('.normal-msg-card__head-title').click()]);
  await popup.waitForLoadState('domcontentloaded'); const u = new URL(popup.url()); const content = u.searchParams.get('content1') || '';
  if (!matchesMessage(content, state.registerIntent.at, savedActivityTitle())) throw Error('Registration detail identity mismatch');
  const link = u.searchParams.get('downloadUrl'); if (!link || new URL(link).hostname !== 'dpurl.cn') throw Error('Unexpected result download host');
  const r = await page.request.get(link, { timeout: 45000, maxRetries: 2 }); bytes = await r.body();
  if (r.status() !== 200 || !(r.headers()['content-type'] || '').includes('csv')) throw Error('Registration detail is not CSV');
  fs.writeFileSync(cached, bytes);
  fs.writeFileSync(sourceFile, JSON.stringify({ account, activityId, submittedAt: state.registerIntent.at, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, null, 2));
  await popup.close(); await closeMessages();
  }
  const rows = parseCsv(bytes.toString('utf8')); const successful = rows.filter(r => r['报名结果'] === '成功'); const failed = rows.filter(r => r['报名结果'] === '失败');
  if (rows.length !== state.registerCount || successful.length !== state.registerReceipt.successful || failed.length !== state.registerReceipt.failed || new Set(rows.map(r => r['门店ID'])).size !== rows.length) throw Error('Registration detail totals/IDs mismatch');
  if (state.cancelIds.some(id => !successful.some(r => r['门店ID'] === id))) throw Error('An original store is absent from successful registration detail');
  fs.writeFileSync(path.join(out, 'failed-stores.json'), JSON.stringify(failed, null, 2));
  state.failedStores = failed; save(); step('registration-details-verified', { successful: successful.length, failed: failed.length, reasons: [...new Set(failed.map(r => r['失败原因']))] });
  await closeMessages();
}
return { identity, frame, shot, closeMessages, prepareCancel, cancel, verifyCancel, prepareRegister, register, confirmRegister, verifyRegister, resultDetails, verify };
}
module.exports = { createWorkflow, activityTitle, messageMatchesActivity };
