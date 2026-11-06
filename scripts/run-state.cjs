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

function createRunState({ home, out, brand, account, activityId, phase }) {
  const statePath = path.join(out, 'state.json');
  const pendingPath = path.join(home, 'pending', `${brand}.json`);
  const cyclePath = path.join(home, 'active-run', `${brand}.json`);
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {
    runId: crypto.randomUUID(), brand, account, activityId, createdAt: new Date().toISOString(), steps: [],
  };
  if (state.brand !== brand || state.account !== account || state.activityId !== activityId) throw Error('运行记录与当前账号、品牌或活动不一致');
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
    atomicJson(cyclePath, { runId: state.runId, brand, account, activityId, runDir: out });
    atomicJson(pendingPath, { runId: state.runId, brand, account, activityId, operation, at: intent.at, count: intent.count, runDir: out });
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
