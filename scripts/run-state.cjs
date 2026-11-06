'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function acquireLock(home, brand, runDir) {
  const file = path.join(home, 'locks', `${brand}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error(`该中台已有运行锁，请核对原任务后再运行：${file}`); throw error; }
  const owner = { pid: process.pid, nonce: crypto.randomUUID(), at: new Date().toISOString(), runDir };
  fs.writeFileSync(fd, JSON.stringify(owner)); fs.closeSync(fd);
  return () => {
    if (!fs.existsSync(file)) return;
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (current.nonce !== owner.nonce) throw Error('运行锁归属改变，保留现场');
    fs.unlinkSync(file);
  };
}

function normalizeActivityId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') throw Error('请用 -ActivityId 或本机配置填写有效的数字活动 ID');
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw Error('活动 ID 过长，请用数字字符串填写');
  const id = String(value);
  if (!/^\d+$/.test(id) || !/[1-9]/.test(id)) throw Error('请用 -ActivityId 或本机配置填写有效的数字活动 ID');
  return id;
}

function normalizeInventory(value) {
  const inventory = Number(value);
  if ((typeof value !== 'string' && typeof value !== 'number') || !/^\d+$/.test(String(value)) || !Number.isSafeInteger(inventory) || inventory < 1) {
    throw Error('请用 -Inventory 或本机配置填写每日库存，必须是正整数');
  }
  return inventory;
}

function createRunState({ home, out, brand, account, activityId, inventory, defaults = {}, phase }) {
  const statePath = path.join(out, 'state.json');
  const pendingPath = path.join(home, 'pending', `${brand}.json`);
  const cyclePath = path.join(home, 'active-run', `${brand}.json`);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
    runId: crypto.randomUUID(), brand, account, createdAt: new Date().toISOString(), steps: [],
  };
  if (state.brand !== brand || state.account !== account) throw Error('运行记录与当前账号或中台不一致');
  const receiptOnly = ['verify-cancel', 'verify-register', 'result-details'].includes(phase);
  if (phase !== 'check-scope') {
    const requestedId = activityId === undefined ? undefined : normalizeActivityId(activityId);
    const requestedInventory = inventory === undefined ? undefined : normalizeInventory(inventory);
    if (state.activityId) {
      state.activityId = normalizeActivityId(state.activityId);
      const savedInventory = state.inventory ?? state.steps.findLast(item => ['register-ready', 'register-final-clicked'].includes(item.name))?.inventory;
      const originalInventory = savedInventory == null ? undefined : normalizeInventory(savedInventory);
      if (requestedId !== undefined && requestedId !== state.activityId) throw Error('活动 ID 与原运行不一致');
      if (requestedInventory !== undefined && originalInventory !== undefined && requestedInventory !== originalInventory) throw Error('库存与原运行不一致');
      if (originalInventory === undefined && requestedInventory === undefined && !receiptOnly) throw Error('旧记录缺少库存，请核对原值后用 -Inventory 指定');
      state.inventory = originalInventory ?? requestedInventory;
    } else {
      if (receiptOnly) throw Error('请用 -RunDir 指定原运行目录以核对回执');
      if (requestedId !== undefined && requestedId !== String(defaults.activityId ?? '') && requestedInventory === undefined) {
        throw Error('使用新的活动 ID 时，请同时填写 -Inventory');
      }
      state.activityId = requestedId ?? normalizeActivityId(defaults.activityId);
      state.inventory = requestedInventory ?? normalizeInventory(defaults.inventory);
    }
  }
  const save = () => atomicJson(statePath, state);
  function step(name, data = {}) {
    const item = { name, at: new Date().toISOString(), ...data }; state.steps.push(item);
    if (name === 'phase-complete') delete state.error;
    save(); console.log(JSON.stringify(item));
  }
  function checkPending() {
    if (fs.existsSync(cyclePath)) {
      const cycle = JSON.parse(fs.readFileSync(cyclePath, 'utf8'));
      if (cycle.runId !== state.runId && phase !== 'check-scope') throw Error(`原流程尚未核实门店恢复，不能换新任务。原目录：${cycle.runDir}`);
    }
    if (!fs.existsSync(pendingPath)) return;
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    const allowed = ['verify-cancel', 'verify-register', 'check-scope'];
    if (pending.runId !== state.runId || !allowed.includes(phase)) {
      throw Error(`存在结果未知的 ${pending.operation} 提交；只核对原任务回执，不得重跑。原目录：${pending.runDir}`);
    }
  }
  function beginIntent(operation, intent) {
    if (fs.existsSync(pendingPath)) throw Error('已有未决提交，拒绝重复派发');
    if (fs.existsSync(cyclePath) && JSON.parse(fs.readFileSync(cyclePath, 'utf8')).runId !== state.runId) throw Error('其他流程尚未恢复，拒绝提交');
    const identity = { runId: state.runId, brand, account, activityId: state.activityId, inventory: state.inventory, runDir: out };
    atomicJson(cyclePath, identity);
    atomicJson(pendingPath, { ...identity, operation, at: intent.at, count: intent.count });
  }
  function resolveIntent(operation) {
    if (!fs.existsSync(pendingPath)) return;
    const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
    if (pending.runId !== state.runId || pending.operation !== operation) throw Error('未决提交记录归属不符，保留现场');
    fs.unlinkSync(pendingPath);
  }
  function completeCycle() {
    if (state.registerIntent?.outcome !== 'confirmed' || !state.verification || state.verification.missingOriginalIds.length || state.verification.invalidRows.length) throw Error('原门店尚未核实恢复，保留原流程');
    if (fs.existsSync(pendingPath)) throw Error('仍有未决提交，不结束原流程');
    if (!fs.existsSync(cyclePath)) return;
    if (JSON.parse(fs.readFileSync(cyclePath, 'utf8')).runId !== state.runId) throw Error('原流程归属不符');
    fs.unlinkSync(cyclePath);
  }
  return { state, save, step, checkPending, beginIntent, resolveIntent, completeCycle };
}

module.exports = { atomicJson, acquireLock, createRunState };
