// ============================================================
// config.gs  ★ここだけ自分の値に書き換える
// ============================================================

const SPREADSHEET_ID = 'hogehoge';
const LINE_CHANNEL_ACCESS_TOKEN = 'hogehoge';
const LINE_CHANNEL_SECRET = 'hogehoge';

// シート名（変更しないこと）
const SHEET = {
  EVENT:   'イベントマスタ',
  SCHED:   '日程マスタ',
  FAQ:     'FAQシート',
  RESERVE: '予約シート',
  USER:    'ユーザーシート',
  SESSION: 'セッションシート',
};

// セッションState定数
const STATE = {
  IDLE:         'IDLE',
  WAITING_NAME: 'WAITING_NAME',
  WAITING_SCHED:'WAITING_SCHED',
  CONFIRM:      'CONFIRM',
};

// ============================================================
// 共通ユーティリティ
// ============================================================

function getSheet(name) {
  return SpreadsheetApp
    .openById(SPREADSHEET_ID)
    .getSheetByName(name);
}

function getAllRows(sheetName) {
  const sheet = getSheet(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1); // ヘッダーを除く
}

function findRowIndex(sheetName, colIndex, value) {
  const rows = getAllRows(sheetName);
  return rows.findIndex(r => r[colIndex] === value);
}

function generateId(prefix, sheetName) {
  const rows = getAllRows(sheetName);
  const num = rows.length + 1;
  return `${prefix}-${String(num).padStart(4, '0')}`;
}

function now() {
  return new Date();
}

function testAuth() {
  const url = 'https://api.line.me/v2/bot/message/reply';
  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
    },
    payload: JSON.stringify({}),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, options);
  Logger.log(res.getResponseCode());
}
