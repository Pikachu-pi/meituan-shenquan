'use strict';

function parseCsv(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else if (quoted) quoted = false;
      else if (!cell) quoted = true;
      else cell += c;
    } else if (c === ',' && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); if (row.some(Boolean)) rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (quoted) throw Error('CSV 引号未闭合，文件可能不完整');
  if (cell || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length || !rows[0].includes('门店ID')) throw Error('CSV 缺少门店ID表头');
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw Error('CSV 包含重复表头');
  return rows.map(values => {
    if (values.length !== headers.length) throw Error('CSV 列数不完整，停止使用该文件');
    return Object.fromEntries(headers.map((h, i) => [h, values[i]]));
  });
}

function storeIds(rows) {
  const ids = rows.map(row => row['门店ID']);
  if (ids.some(id => typeof id !== 'string' || !/^\d+$/.test(id))) throw Error('门店ID存在空值或非数字');
  if (new Set(ids).size !== ids.length) throw Error('门店ID重复');
  return ids;
}

function originalStoreDiff(originalIds, rows) {
  const current = new Set(storeIds(rows));
  return originalIds.filter(id => !current.has(id));
}

module.exports = { parseCsv, storeIds, originalStoreDiff };
