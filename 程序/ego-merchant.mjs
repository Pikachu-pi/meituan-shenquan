import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { merchantUi, prepareEgoViewport, waitFor } from './ego-preflight.mjs';
import { matchesNotice } from './ego-evidence.mjs';

const require = createRequire(import.meta.url);
const { parseCsv, storeIds } = require('./data.cjs');
const { activityTitle } = require('./ego-activity.cjs');

export const routes = {
  list: '/marketingEntry/inviteList', details: '/shenquan/detailPc',
  intro: '/merchant/infoNew/pc', form: '/shenquan/createPc',
};
const host = 'https://shangoue.meituan.com';
const listUrl = host + '/#/marketing/shangou/pc/marketingEntry/inviteList?isEntryBackFill=notfill';
const storeHeader = '.poilist-container .current-poi';
const closeNotice = 'i.roo-icon-close[style*="position: fixed"]';
const exportTitle = '请查收神券报名明细';
const titlePrefix = /^【美团神券】\s*\S/;
const escapeRegex = value => value.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');

export async function openMerchant(browser, state, record) {
  const profiles = (await browser.profiles()).filter(profile => state.profileId
    ? String(profile.id) === state.profileId : profile.name === state.profileName);
  if (profiles.length !== 1) throw Error('未找到唯一的 Ego Lite 资料，请核对资料名或重新做只读绑定');
  const profile = profiles[0];
  const existing = (await browser.listTaskSpaces()).find(space => space.name === state.taskName && space.profileId === profile.id);
  if (existing && existing.ownership !== 'agent') throw Error('任务空间已交由用户处理，请完成登录或浏览器提示后再核对');
  const task = existing ? await browser.taskSpace(existing.id) : await browser.taskSpace(state.taskName, { profileId: profile.id });
  record({ spaceId: task.spaceId, profileId: String(profile.id), profileName: profile.name });
  const pages = await task.pages();
  const page = pages.find(item => item.label === 'p1') ?? pages[0];
  if (!page) throw Error('原任务空间没有可用页面');
  const viewport = await prepareEgoViewport(task, page);
  const ui = merchantUi(page, viewport);
  const save = async name => writeFile(join(state.out, name+'.txt'), await page.snapshot());
  const assertScope = async () => {
    if ((await ui.one(null, '.acctinfo-container .txt', {}, '读取已登录商家账号')).text !== state.account) throw Error('商家账号与预期账号不符');
    const scope = await ui.one(null, storeHeader);
    if (scope.text !== '全部门店' || scope.title !== '全部门店') throw Error('未核对到全部门店');
  };

  if (!(await page.url()).startsWith(host+'/')) await page.goto(listUrl, { timeout: 30000 });
  await viewport();
  if ((await ui.one(null, '.acctinfo-container .txt', {}, '读取已登录商家账号')).text !== state.account) throw Error('商家账号与预期账号不符');
  const scope = await ui.one(null, storeHeader);
  if (scope.text !== scope.title) throw Error('门店范围的可见文字与标题不一致');
  if (scope.title !== '全部门店') {
    const option = '.poi-list .content[title="全部门店"]';
    if (!(await ui.read(null, option)).length) await page.click(storeHeader, { label: '打开门店范围选择' });
    await page.waitForSelector(option, { timeout: 10000 });
    await page.click(option, { label: '切换为全部门店' });
    await waitFor(async () => (await ui.read(null, storeHeader))[0]?.title === '全部门店', '切换为全部门店');
  }
  await assertScope();
  record({ scope: '全部门店' });

  const idLabel = new RegExp('活动\\s*ID\\s*[:：]\\s*'+state.activityId+'(?!\\d)');
  const card = { ancestor: '.sgyx-shop-invite-card', ancestorPattern: idLabel.source };
  const hasTitle = text => text.split(/\r?\n/).some(line => line.trim() === state.activityTitle);

  const closeMessages = async () => {
    if (!(await ui.read(null, closeNotice)).length) return;
    await ui.click(null, closeNotice, {}, '关闭平台消息');
    await waitFor(async () => !(await ui.read(null, closeNotice)).length, '关闭平台消息');
  };

  const find = async tab => {
    await closeMessages();
    if (!(await page.url()).includes(routes.list)) await page.goto(listUrl, { timeout: 30000 });
    else if (!(await ui.read(routes.list, 'li.tab-item')).length) await page.reload({ timeout: 30000 });
    await viewport();
    await assertScope();
    await ui.selectTab(routes.list, tab);
    const search = 'input[label="活动ID"]';
    await ui.fill(routes.list, search, state.activityId);
    if ((await ui.one(routes.list, search)).value !== state.activityId) throw Error('活动 ID 搜索回读不符');
    await ui.button(routes.list, '查询', '查询指定神券活动');
    await delay(450);
    return waitFor(async () => {
      const text = await ui.body(routes.list);
      if (text.includes('正在加载')) return;
      const cards = await ui.read(routes.list, card.ancestor, { pattern: idLabel.source });
      if (cards.length > 1) throw Error('找到多张匹配活动 ID 的卡片');
      if (cards.length) {
        const lines = cards[0].text.split(/\r?\n/).map(line => line.trim());
        const titles = lines.filter(line => titlePrefix.test(line));
        const observed = titles.length === 1 ? titles[0] : activityTitle(cards[0].text, idLabel);
        if (!observed || !titlePrefix.test(observed) || (state.activityTitle && observed !== state.activityTitle)) {
          throw Error('活动 ID 对应的神券名称与预期不符');
        }
        record({ activityTitle: observed });
        return { found: true };
      }
      if (text.includes('暂无报名活动')) return { found: false };
    }, '查询'+tab+'的指定活动');
  };

  const notice = (title, since, verb, timeout = 95000) => waitFor(async () => {
    await assertScope();
    await closeMessages();
    await ui.click(null, '.notice-box[role="button"]', {}, '打开平台消息');
    await ui.selectTab(null, '店铺运营', '.notice-box__tab ');
    const cards = await ui.read(null, '.normal-msg-card');
    const matches = [...new Set(cards.map(item => item.text).filter(text =>
      text.includes(title) && matchesNotice(text, state, since, verb)))];
    if (matches.length > 1) throw Error('找到多条符合本次时间和活动的消息');
    if (!matches.length) await delay(1500);
    return matches[0];
  }, '接收'+title, timeout);

  const downloadNotice = async (title, message, since, verb, fileName) => {
    const [popup] = await Promise.all([
      page.waitForEvent('popup', { timeout: 20000 }),
      ui.clickPopup(null, '.normal-msg-card__head-title', {
        exact: title, ancestor: '.normal-msg-card', ancestorPattern: '^'+escapeRegex(message)+'$',
      }, '打开本次平台明细消息'),
    ]);
    try {
      const url = await waitFor(async () => {
        const candidate = new URL(await popup.url());
        return candidate.searchParams.has('downloadUrl') && candidate;
      }, '读取平台下载页');
      if (!matchesNotice(url.searchParams.get('content1') || '', state, since, verb)) throw Error('下载页与本次账号、活动或时间不匹配');
      const link = new URL(url.searchParams.get('downloadUrl'));
      if (link.protocol !== 'https:' || link.hostname !== 'dpurl.cn') throw Error('平台 CSV 下载域名不匹配');
      const response = await fetch(link, { signal: AbortSignal.timeout(30000) });
      if (response.status !== 200 || !/^text\/csv\b/i.test(response.headers.get('content-type') || '')) throw Error('平台未返回有效 CSV');
      const bytes = Buffer.from(await response.arrayBuffer());
      const rows = parseCsv(bytes.toString('utf8'));
      storeIds(rows);
      await writeFile(join(state.out, fileName), bytes);
      return rows;
    } finally {
      await popup.close();
      await closeMessages();
    }
  };

  const enrollment = async (label, download = true) => {
    if (!(await find('已报名')).found) {
      await save(label+'-无报名');
      return { found: false, total: 0, rows: [] };
    }
    await ui.button(routes.list, '报名详情', '打开目标活动报名详情', card);
    await ui.selectTab(routes.details, '报名信息');
    const { total } = await waitFor(async () => {
      const text = await ui.body(routes.details);
      if (!hasTitle(text)) return;
      const count = text.match(/共\s*(\d+)\s*条数据/);
      if (count) return { total: Number(count[1]) };
      if (/暂无数据|暂无报名信息|暂无报名门店/.test(text) && text.includes('下载报名信息')) return { total: 0 };
    }, '核对报名详情活动及门店总数');
    await save(label+'-页面');
    if (!download || !total) return { found: true, total, rows: [] };
    await assertScope();
    const since = Date.now();
    await ui.button(routes.details, '下载报名信息', '导出当前活动报名明细');
    const message = await notice(exportTitle, since, '下载');
    const exportedTitle = message.match(/下载的神券活动(.+?)[（(]\s*id\s*[:：]\s*\d+\s*[）)]/i)?.[1].trim();
    if (exportedTitle !== state.activityTitle) throw Error('报名明细导出活动名称不匹配');
    await writeFile(join(state.out, label+'-导出通知.txt'), message);
    const rows = await downloadNotice(exportTitle, message, since, '下载', label+'.csv');
    if (rows.length !== total || rows.some(row => !row['状态'])) throw Error('报名明细数量或状态列与页面不一致');
    return { found: true, total, rows };
  };

  return { task, page, ui, save, assertScope, closeMessages, find, enrollment, notice, downloadNotice, hasTitle, idLabel, card };
}
