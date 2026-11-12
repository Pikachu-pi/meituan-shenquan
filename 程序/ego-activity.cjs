'use strict';

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
  return Boolean(title && text.includes('【'+title+'】活动'));
}

module.exports = { activityTitle, messageMatchesActivity };
