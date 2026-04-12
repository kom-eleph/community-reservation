// ============================================================
// session.gs  ユーザーの入力状態をシートで管理する
// ============================================================

function getSession(userId) {
  const idx = findRowIndex(SHEET.SESSION, 0, userId);
  if (idx === -1) return null;
  const row = getAllRows(SHEET.SESSION)[idx];
  return {
    userId:  row[0],
    state:   row[1],
    tmpData: row[2] ? JSON.parse(row[2]) : {},
    updated: row[3],
  };
}

function setSession(userId, state, tmpData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet   = getSheet(SHEET.SESSION);
    const rows    = sheet.getDataRange().getValues();
    const idx     = rows.findIndex((r, i) => i > 0 && r[0] === userId);
    const payload = [userId, state, JSON.stringify(tmpData), now()];

    if (idx > 0) {
      sheet.getRange(idx + 1, 1, 1, 4).setValues([payload]);
    } else {
      sheet.appendRow(payload);
    }
  } finally {
    lock.releaseLock();
  }
}

function clearSession(userId) {
  setSession(userId, STATE.IDLE, {});
}
