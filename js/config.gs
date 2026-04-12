// ============================================================
// config.gs  ★ここだけ自分の値に書き換える
// ============================================================

const SPREADSHEET_ID            = 'hogehoge';
const LINE_CHANNEL_ACCESS_TOKEN = 'hogehoge';
const LINE_CHANNEL_SECRET       = 'hogehoge';

// 管理者通知用LINEユーザーID（任意。不要なら空文字 '' のまま）
const ADMIN_LINE_USER_ID = '';

// デバッグフラグ（本番運用時は false にしてログ量を削減）
const DEBUG = false;

// シート名（変更しないこと）
const SHEET = {
  EVENT:    'イベントマスタ',
  SCHED:    '日程マスタ',
  FAQ:      'FAQシート',
  RESERVE:  '予約シート',
  USER:     'ユーザーシート',
  SESSION:  'セッションシート',
  WAITLIST: 'キャンセル待ちシート',
};

// セッションState定数
const STATE = {
  IDLE:          'IDLE',
  WAITING_NAME:  'WAITING_NAME',
  WAITING_SCHED: 'WAITING_SCHED',
  CONFIRM:       'CONFIRM',
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
  if (!sheet) {
    debugLog('シートが見つかりません: ' + sheetName);
    return [];
  }
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  return values.slice(1);
}

function findRowIndex(sheetName, colIndex, value) {
  const rows = getAllRows(sheetName);
  return rows.findIndex(r => r[colIndex] === value);
}

// ランダム+日付ベースのユニークID生成（行数ベースは削除・変更後に重複しうるため非推奨）
function generateUniqueId(prefix, sheetName) {
  const dateStr   = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd');
  const randomStr = Math.random().toString(36).substr(2, 5).toUpperCase();
  const candidate = `${prefix}-${dateStr}-${randomStr}`;

  // 万が一衝突した場合はリトライ（事実上発生しない）
  const rows = getAllRows(sheetName);
  if (rows.some(r => r[0] === candidate)) {
    return generateUniqueId(prefix, sheetName);
  }
  return candidate;
}

// 後方互換のためgenerateIdも残す（非推奨）
function generateId(prefix, sheetName) {
  debugLog('[WARN] generateId() is deprecated. Use generateUniqueId()');
  return generateUniqueId(prefix, sheetName);
}

function now() {
  return new Date();
}

// デバッグログ（DEBUG=falseのときは何もしない）
function debugLog(msg) {
  if (DEBUG) Logger.log(msg);
}

// ── 接続確認用 ────────────────────────────────────────────
function testAuth() {
  const url = 'https://api.line.me/v2/bot/info';
  const options = {
    method: 'get',
    headers: { 'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN },
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, options);
  Logger.log('LINE Bot接続確認: ' + res.getResponseCode());
  Logger.log(res.getContentText());
}

function testSpreadsheet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  Logger.log('スプレッドシート: ' + ss.getName());
  Object.values(SHEET).forEach(name => {
    const sheet = ss.getSheetByName(name);
    Logger.log(name + ': ' + (sheet ? '✅ 存在' : '❌ 見つからない'));
  });
}
