'use strict';

const HEADER = '.poilist-container .current-poi';
const ALL = '全部门店';

async function readStoreScope(page) {
  const header = page.locator(HEADER);
  await header.waitFor({ state: 'visible' });
  if (await header.count() !== 1) throw Error('Cannot uniquely identify the store scope selector');
  const title = (await header.getAttribute('title') || '').trim();
  const text = (await header.locator('.txt').innerText()).trim();
  if (!title || title !== text) throw Error('Store scope title and visible label do not agree');
  return text;
}

async function assertAllStores(page) {
  const scope = await readStoreScope(page);
  if (scope !== ALL) throw Error(`Store scope changed to ${scope}; stop and rerun preparation in 全部门店`);
}

async function ensureAllStores(page) {
  const before = await readStoreScope(page);
  if (before === ALL) return { before, after: ALL, switched: false };
  await page.locator(HEADER).click();
  const option = page.locator('.poi-list .content[title="全部门店"]');
  await option.waitFor({ state: 'visible' });
  if (await option.count() !== 1) throw Error('Cannot uniquely identify 全部门店 in the store menu');
  await option.click();
  await page.waitForFunction(selector => {
    const header = document.querySelector(selector);
    return header && header.title.trim() === '全部门店' && header.querySelector('.txt')?.textContent.trim() === '全部门店';
  }, HEADER, { timeout: 20000 });
  await assertAllStores(page);
  return { before, after: ALL, switched: true };
}

module.exports = { readStoreScope, assertAllStores, ensureAllStores };
