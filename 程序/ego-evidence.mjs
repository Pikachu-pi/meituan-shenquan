import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { storeIds } = require('./data.cjs');

export function matchesNotice(text, { account, activityId, activityTitle }, since, verb) {
  const pattern = /商家账号([^\r\n]+?)于(\d{4})年(\d{2})月(\d{2})日\s*(\d{2}):(\d{2}):(\d{2})(下载|报名|取消)/;
  const stamp = text.match(pattern);
  if (!stamp || stamp[1] !== account || stamp[8] !== verb) return false;
  const [, , y, m, d, hh, mm, ss] = stamp;
  const at = Date.parse(y+'-'+m+'-'+d+'T'+hh+':'+mm+':'+ss+'+08:00');
  if (!(at >= Math.floor(since / 1000) * 1000 && at <= Date.now() + 3000)) return false;
  const ids = [...text.matchAll(/\bID\s*[:：]\s*(\d+)/gi)].map(match => match[1]);
  if (ids.length) return ids.every(id => id === activityId);
  return Boolean(activityTitle && text.includes('【'+activityTitle+'】活动'));
}

export function parseReceipt(text, action, submitted) {
  const label = action === 'register' ? '报名' : '取消';
  const count = text.match(new RegExp(label+'成功门店数\\s*(\\d+)\\s*(?:个|家)?\\s*[，,]'));
  const failure = text.match(/(?:^|[，,])\s*(?:报名|取消)?失败\s*(\d+)\s*(?:个|家)?/);
  if (!count || (!failure && !text.includes('全部'+label+'成功'))) throw Error('平台回执缺少可核对的成功或失败家数');
  const successful = Number(count[1]);
  const failed = failure ? Number(failure[1]) : 0;
  if (successful + failed !== submitted || (failed && text.includes('全部'+label+'成功'))) throw Error('平台回执与本次提交数量不一致');
  return { successful, failed };
}

export const active = row => row?.['状态'] === '生效中';

export function reconcileReadback(action, intent, receipt, rows) {
  const current = new Map(rows.map(row => [row['门店ID'], row]));
  const verifiedIds = intent.ids.filter(id => action === 'cancel'
    ? !current.has(id)
    : active(current.get(id)) && current.get(id)['每日神券库存'] === intent.inventory+'张');
  const verified = new Set(verifiedIds);
  const unverifiedIds = intent.ids.filter(id => !verified.has(id));
  if (receipt && verifiedIds.length !== receipt.successful) throw Error('平台回执与逐店回读结果不一致');
  return { currentCount: rows.length, verifiedIds, unverifiedIds };
}

export function registrationFailures(rows, intent, receipt, verifiedIds) {
  const ids = storeIds(rows);
  const submitted = new Set(intent.ids);
  const verified = new Set(verifiedIds);
  const success = rows.filter(row => row['报名结果'] === '成功');
  const failed = rows.filter(row => row['报名结果'] === '失败');
  if (ids.length !== submitted.size || !ids.every(id => submitted.has(id)) ||
      success.length !== receipt.successful || failed.length !== receipt.failed ||
      !success.every(row => verified.has(row['门店ID']))) {
    throw Error('逐店报名结果与提交、回执或生效回读不一致');
  }
  const reasons = Object.create(null);
  for (const row of failed) {
    const reason = row['失败原因'] || '平台未注明';
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  }
  return { failed, reasons };
}
