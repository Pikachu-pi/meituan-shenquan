'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCsv, storeIds, originalStoreDiff } = require('../data.cjs');
const { atomicJson, acquireLock, createRunState } = require('../run-state.cjs');
const { createWorkflow, activityTitle, messageMatchesActivity } = require('../workflow.cjs');
const { parseArgs } = require('../run.cjs');
const crypto = require('node:crypto');

function sandbox(t) {
  const parent = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'shenquan-test-'));
  t.after(() => {
    const target = path.resolve(dir);
    assert.equal(path.dirname(target), parent);
    assert.ok(path.basename(target).startsWith('shenquan-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return dir;
}

test('CSV supports BOM, multiline quoted cells and Excel text names without evaluating them', () => {
  const rows = parseCsv('\uFEFF门店ID,门店名称,说明\r\n123,="演示门店","第一行\n第二行，含""引号"""\r\n');
  assert.deepEqual(rows, [{ 门店ID: '123', 门店名称: '="演示门店"', 说明: '第一行\n第二行，含"引号"' }]);
  assert.deepEqual(storeIds(rows), ['123']);
});

test('truncated CSV, duplicate headers and non-CSV responses are rejected', () => {
  assert.throws(() => parseCsv('门店ID,门店名称\n123,"未结束'), /引号未闭合/);
  assert.throws(() => parseCsv('门店ID,门店ID\n123,123'), /重复表头/);
  assert.throws(() => parseCsv('<html>请登录</html>'), /表头/);
  assert.throws(() => parseCsv('门店ID,门店名称\n123'), /列数/);
});

test('invalid and duplicated IDs cannot become cancellation input', () => {
  for (const value of ['', '1e5', '123.0', ' 123']) assert.throws(() => storeIds([{ 门店ID: value }]), /非数字/);
  assert.throws(() => storeIds([{ 门店ID: '123' }, { 门店ID: '123' }]), /重复/);
});

test('original-store recovery compares identities rather than just row count', () => {
  assert.deepEqual(originalStoreDiff(['123', '456'], [{ 门店ID: '123' }, { 门店ID: '789' }]), ['456']);
});

test('one brand cannot run concurrently, independent brands have separate locks', t => {
  const home = sandbox(t); const release = acquireLock(home, 'lexinyi', 'first');
  assert.throws(() => acquireLock(home, 'lexinyi', 'second'), /已有运行锁/);
  const other = acquireLock(home, 'xiaocang', 'separate'); other(); release();
  acquireLock(home, 'lexinyi', 'next')();
});

test('an unknown submission blocks a fresh run and permits only the original receipt query', t => {
  const home = sandbox(t); const out = path.join(home, 'runs', 'first');
  const args = { home, out, brand: 'lexinyi', account: 'demo-owner', activityId: '91000123', inventory: 260 };
  const first = createRunState({ ...args, phase: 'execute' }); first.save();
  first.beginIntent('cancel', { at: Date.now(), count: 2 });
  const fresh = createRunState({ ...args, out: path.join(home, 'runs', 'second'), phase: 'execute' });
  assert.throws(() => fresh.checkPending(), /原流程尚未核实/);
  const original = createRunState({ ...args, phase: 'verify-cancel' }); original.checkPending();
  assert.throws(() => original.beginIntent('cancel', {}), /未决提交/);
  assert.throws(() => original.resolveIntent('register'), /归属不符/);
  original.resolveIntent('cancel');
  assert.throws(() => fresh.checkPending(), /原流程尚未核实/);
  assert.throws(() => original.completeCycle(), /尚未核实恢复/);
  original.state.registerIntent = { outcome: 'confirmed' };
  original.state.verification = { missingOriginalIds: [], invalidRows: [] };
  original.completeCycle(); fresh.checkPending();
});

test('a saved run cannot be rebound to a different account', t => {
  const home = sandbox(t); const args = { home, out: path.join(home, 'run'), brand: 'lexinyi', account: 'demo-owner', activityId: '91000123', inventory: 260, phase: 'preflight' };
  createRunState(args).save();
  assert.throws(() => createRunState({ ...args, account: 'different-owner' }), /不一致/);
});

test('argument parsing defaults to preflight and rejects ambiguous or repeated submit flags', () => {
  assert.equal(parseArgs(['--brand', 'lexinyi']).phase, 'preflight');
  assert.deepEqual(parseArgs(['--brand', 'lexinyi', '--activity-id', '91000123', '--inventory', '260']), {
    brand: 'lexinyi', phase: 'preflight', 'activity-id': '91000123', inventory: '260',
  });
  assert.throws(() => parseArgs([]), /必须指定/);
  assert.throws(() => parseArgs(['--brand', 'lexinyi', '--phase', 'preflight', '--phase', 'execute']), /重复参数/);
  assert.throws(() => parseArgs(['--brand', 'lexinyi', '--unknown', 'execute']), /参数格式/);
});

test('activity and inventory can change for a new run while recovery keeps the original values', t => {
  const home = sandbox(t);
  const args = { home, out: path.join(home, 'runs', 'original'), brand: 'lexinyi', account: 'demo-owner', phase: 'preflight' };
  const defaults = { activityId: '91000123', inventory: 260 };
  const first = createRunState({ ...args, defaults });
  assert.equal(first.state.activityId, '91000123');
  assert.equal(first.state.inventory, 260);
  first.save();
  const changed = { activityId: '91000999', inventory: 320 };
  const restored = createRunState({ ...args, defaults: changed, phase: 'verify-cancel' });
  assert.equal(restored.state.activityId, '91000123');
  assert.equal(restored.state.inventory, 260);
  assert.throws(() => createRunState({ ...args, ...changed }), /活动 ID 与原运行不一致/);
  assert.throws(() => createRunState({ ...args, inventory: 320 }), /库存与原运行不一致/);
  const fresh = { ...args, out: path.join(home, 'runs', 'fresh'), defaults };
  assert.throws(() => createRunState({ ...fresh, activityId: changed.activityId }), /同时填写 -Inventory/);
  const override = createRunState({ ...fresh, ...changed });
  assert.equal(override.state.activityId, '91000999');
  assert.equal(override.state.inventory, 320);
  assert.throws(() => createRunState({ ...fresh, inventory: '2e2' }), /正整数/);
  assert.throws(() => createRunState({ ...fresh, activityId: 'not-an-id', inventory: 260 }), /数字活动 ID/);
});

test('old run records recover recorded inventory and require confirmation when it was never recorded', t => {
  const home = sandbox(t);
  const out = path.join(home, 'runs', 'legacy');
  const legacy = { runId: 'legacy', brand: 'lexinyi', account: 'demo-owner', activityId: '91000123', steps: [{ name: 'register-ready', inventory: 260 }] };
  const args = { home, out, brand: legacy.brand, account: legacy.account, defaults: { activityId: '91000999', inventory: 320 }, phase: 'prepare-register' };
  atomicJson(path.join(out, 'state.json'), legacy);
  assert.equal(createRunState(args).state.inventory, 260);
  legacy.steps = [];
  atomicJson(path.join(out, 'state.json'), legacy);
  assert.equal(createRunState({ ...args, phase: 'verify-cancel' }).state.activityId, '91000123');
  assert.throws(() => createRunState(args), /旧记录缺少库存/);
  assert.equal(createRunState({ ...args, inventory: 260 }).state.inventory, 260);
});

test('receipt identity uses an exact tagged ID or the complete activity title', () => {
  const id = '91000123';
  const title = activityTitle('报名活动活动介绍\n便利店周末活动\n活动ID：91000123', /活动ID：91000123/);
  assert.equal(title, '便利店周末活动');
  assert.equal(messageMatchesActivity(`下载的神券活动${title}（id:${id}）`, id), true);
  assert.equal(messageMatchesActivity(`报名【${title}】活动中的门店`, id, title), true);
  assert.equal(messageMatchesActivity(`报名【${title}】活动（id:${id}4）`, id, title), false);
  assert.equal(messageMatchesActivity(`报名【${title}第二期】活动中的门店`, id, title), false);
});

test('downloaded result cache must belong to the same account, submission and original stores', async t => {
  const out = sandbox(t);
  const csv = '门店ID,门店名称,报名结果,失败原因\n123,演示甲店,成功,\n456,演示乙店,失败,门店类型不符合活动要求\n';
  fs.writeFileSync(path.join(out, 'register-result-details.csv'), csv);
  const source = { account: 'wrong-owner', activityId: '91000123', submittedAt: 1000, sha256: crypto.createHash('sha256').update(csv).digest('hex') };
  const meta = path.join(out, 'register-result-source.json'); fs.writeFileSync(meta, JSON.stringify(source));
  const state = { activityId: source.activityId, inventory: 260, registerIntent: { outcome: 'confirmed', at: 1000 }, registerCount: 2, registerReceipt: { successful: 1, failed: 1 }, cancelIds: ['123'] };
  const settings = { brands: { lexinyi: { expectedAccount: 'demo-owner' } } };
  const page = { locator: () => ({ isVisible: async () => false }) };
  const workflow = createWorkflow({ page, settings, brand: 'lexinyi', state, out, save() {}, step() {} });
  await assert.rejects(workflow.resultDetails(), /provenance mismatch/);
  source.account = 'demo-owner'; source.submittedAt = 900; fs.writeFileSync(meta, JSON.stringify(source));
  await assert.rejects(workflow.resultDetails(), /provenance mismatch/);
  source.submittedAt = 1000; fs.writeFileSync(meta, JSON.stringify(source));
  await workflow.resultDetails();
  assert.equal(state.failedStores.length, 1);
  state.cancelIds = ['789'];
  await assert.rejects(workflow.resultDetails(), /original store is absent/);
});
