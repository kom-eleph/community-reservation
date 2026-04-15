// ============================================================
// session.gs  ユーザーの入力状態をシートで管理する
// ============================================================

function getSession(userId) {
  const idx = findRowIndex(SHEET.SESSION, COL_SESSION.USER_ID, userId);
  if (idx === -1) return null;
  const row = getAllRows(SHEET.SESSION)[idx];
  return {
    userId:  row[COL_SESSION.USER_ID],
    state:   row[COL_SESSION.STATE],
    tmpData: row[COL_SESSION.TMP_DATA] ? JSON.parse(row[COL_SESSION.TMP_DATA]) : {},
    updated: row[COL_SESSION.UPDATED],
  };
}

function setSession(userId, state, tmpData) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const sheet   = getSheet(SHEET.SESSION);
    const rows    = sheet.getDataRange().getValues();
    const idx     = rows.findIndex((r, i) => i > 0 && r[COL_SESSION.USER_ID] === userId);
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
