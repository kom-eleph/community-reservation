// ============================================================
// config.gs  ★ここだけ自分の値に書き換える
// ============================================================

const SPREADSHEET_ID = 'hoge';
const LINE_CHANNEL_ACCESS_TOKEN = 'hoge';
const LINE_CHANNEL_SECRET = 'hoge';

// [S-2追加] LIFFアプリのチャネルID（LINE Developersコンソールで確認）
// トークン検証時に client_id との照合に使用する
const LIFF_CHANNEL_ID = 'hoge';

// 管理者通知用LINEユーザーID（任意。不要なら空文字 '' のまま）
const ADMIN_LINE_USER_ID = 'hoge';

// デバッグフラグ（本番運用時は false にしてログ量を削減）
const DEBUG = false;

// ============================================================
// シート名
// ============================================================

const SHEET = {
  EVENT:    'イベントマスタ',
  SCHED:    '日程マスタ',
  FAQ:      'FAQシート',
  RESERVE:  '予約シート',
  USER:     'ユーザーシート',
  SESSION:  'セッションシート',
  WAITLIST: 'キャンセル待ちシート',
  INQUIRY:  'お問い合わせシート',
};

// ============================================================
// セッション State 定数
// ============================================================

const STATE = {
  IDLE:          'IDLE',
  WAITING_NAME:  'WAITING_NAME',
  WAITING_SCHED: 'WAITING_SCHED',
  CONFIRM:       'CONFIRM',
  INQUIRY_WAIT:  'INQUIRY_WAIT',
  WAITING_REPLY: 'WAITING_REPLY',
};

// ============================================================
// ステータス値定数
// ============================================================

const RESERVE_STATUS = {
  ACTIVE:    '予約中',
  CANCELLED: 'キャンセル',
  CHANGED:   '変更済',
};

const WAITLIST_STATUS = {
  WAITING:  '待機中',
  NOTIFIED: '通知済',
};

const INQUIRY_STATUS = {
  OPEN:   '未対応',
  CLOSED: '対応済',
};

const USER_STATUS = {
  FOUND: 'found',
  NONE:  'none',
};

const API_STATUS = {
  OK:    'ok',
  ERROR: 'error',
  FULL:  'full',
};

// ============================================================
// 各シートの列インデックス定数（0始まり）
// ============================================================

const COL_EVENT = {
  ID:          0,
  NAME:        1,
  DESCRIPTION: 2,
  CAPACITY:    3,
  IS_ACTIVE:   4,
  FEE:         5,
  STUFF:       6,
  NOTE:        7,
};

const COL_SCHED = {
  ID:           0,
  EVENT_ID:     1,
  DATETIME:     2,
  ACCEPT_START: 3,
  ACCEPT_END:   4,
  CAPACITY:     5,
  LOCATION:     6,
};

const COL_RESERVE = {
  ID:           0,
  USER_ID:      1,
  SCHED_ID:     2,
  STATUS:       3,
  RESERVED_AT:  4,
  CANCELLED_AT: 5,
};

// ユーザーシート: A=userId B=名前 C=生年月日 D=性別 E=登録日時
const COL_USER = {
  ID:         0,
  NAME:       1,
  BIRTHDATE:  2,   // 旧: AGE → 生年月日(YYYY-MM-DD文字列)に変更
  GENDER:     3,
  CREATED_AT: 4,
};

const COL_SESSION = {
  USER_ID:  0,
  STATE:    1,
  TMP_DATA: 2,
  UPDATED:  3,
};

const COL_WAITLIST = {
  USER_ID:     0,
  SCHED_ID:    1,
  STATUS:      2,
  CREATED_AT:  3,
  NOTIFIED_AT: 4,
};

const COL_INQUIRY = {
  ID:          0,
  USER_ID:     1,
  QUESTION:    2,
  STATUS:      3,
  RECEIVED_AT: 4,
  HANDLED_AT:  5,
};

const COL_FAQ = {
  KEYWORDS:  0,
  PRIORITY:  1,
  ANSWER:    2,
  IS_ACTIVE: 3,
};

// ============================================================
// 数値・閾値定数
// ============================================================

const LOCK_TIMEOUT_MS       = 10000;
// 生年月日の受付可能範囲（現在日から何年前まで）
const BIRTHDATE_MIN_YEARS   = 1;    // 最小: 1歳以上
const BIRTHDATE_MAX_YEARS   = 120;  // 最大: 120歳以下
const SHEET_VALIDATION_ROWS = 1000;
const DATETIME_FORMAT       = 'M月d日(E) HH:mm';
const DATETIME_TIMEZONE     = 'Asia/Tokyo';

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

// [B-1修正] ID列インデックスを呼び出し元から渡すことで、シートごとに正しい列を参照する
// 使用例:
//   予約シート: generateUniqueId('RSV', SHEET.RESERVE, COL_RESERVE.ID)
//   問い合わせ: generateUniqueId('IQ',  SHEET.INQUIRY, COL_INQUIRY.ID)
function generateUniqueId(prefix, sheetName, idColIndex) {
  // idColIndex 未指定時は後方互換のため COL_RESERVE.ID (=0) を使用
  const colIdx    = (idColIndex !== undefined) ? idColIndex : COL_RESERVE.ID;
  const dateStr   = Utilities.formatDate(new Date(), DATETIME_TIMEZONE, 'yyyyMMdd');
  const randomStr = Math.random().toString(36).substr(2, 5).toUpperCase();
  const candidate = `${prefix}-${dateStr}-${randomStr}`;

  const rows = getAllRows(sheetName);
  if (rows.some(r => r[colIdx] === candidate)) {
    return generateUniqueId(prefix, sheetName, idColIndex);
  }
  return candidate;
}

function now() {
  return new Date();
}

function formatDatetime(date) {
  return Utilities.formatDate(new Date(date), DATETIME_TIMEZONE, DATETIME_FORMAT);
}

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

// ── お問い合わせシートの初期セットアップ ─────────────────
function setupInquirySheet() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET.INQUIRY);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET.INQUIRY);
    Logger.log('シートを作成しました: ' + SHEET.INQUIRY);
  }

  const firstRow = sheet.getRange(1, 1).getValue();
  if (!firstRow) {
    sheet.getRange(1, 1, 1, 6).setValues([[
      'お問い合わせID', 'userId', '質問内容', 'ステータス', '受付日時', '対応日時',
    ]]);
    sheet.getRange(1, 1, 1, 6)
      .setBackground('#4a90d9').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL_INQUIRY.ID          + 1, 180);
    sheet.setColumnWidth(COL_INQUIRY.USER_ID      + 1, 160);
    sheet.setColumnWidth(COL_INQUIRY.QUESTION     + 1, 300);
    sheet.setColumnWidth(COL_INQUIRY.STATUS       + 1,  80);
    sheet.setColumnWidth(COL_INQUIRY.RECEIVED_AT  + 1, 140);
    sheet.setColumnWidth(COL_INQUIRY.HANDLED_AT   + 1, 140);

    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList([INQUIRY_STATUS.OPEN, INQUIRY_STATUS.CLOSED], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, COL_INQUIRY.STATUS + 1, SHEET_VALIDATION_ROWS, 1)
      .setDataValidation(statusRule);
    Logger.log('ヘッダーを設定しました');
  }
  Logger.log('=== setupInquirySheet 完了 ===');
}

// ── キャンセル待ちシートのセットアップ ───────────────────
function setupWaitlistSheet() {
  const ss    = SpreadsheetApp.openById(SPREADSHEET_ID);
  let   sheet = ss.getSheetByName(SHEET.WAITLIST);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET.WAITLIST);
    Logger.log('シートを作成しました: ' + SHEET.WAITLIST);
  }

  const firstRow = sheet.getRange(1, 1).getValue();
  if (!firstRow) {
    sheet.getRange(1, 1, 1, 5).setValues([[
      'userId', '日程ID', 'ステータス', '登録日時', '通知日時',
    ]]);
    sheet.getRange(1, 1, 1, 5)
      .setBackground('#f97316').setFontColor('#ffffff').setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(COL_WAITLIST.USER_ID     + 1, 200);
    sheet.setColumnWidth(COL_WAITLIST.SCHED_ID    + 1, 180);
    sheet.setColumnWidth(COL_WAITLIST.STATUS      + 1, 100);
    sheet.setColumnWidth(COL_WAITLIST.CREATED_AT  + 1, 140);
    sheet.setColumnWidth(COL_WAITLIST.NOTIFIED_AT + 1, 140);

    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList([WAITLIST_STATUS.WAITING, WAITLIST_STATUS.NOTIFIED], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, COL_WAITLIST.STATUS + 1, SHEET_VALIDATION_ROWS, 1)
      .setDataValidation(statusRule);
    Logger.log('キャンセル待ちシートのヘッダーを設定しました');
  } else {
    const eHeader = sheet.getRange(1, COL_WAITLIST.NOTIFIED_AT + 1).getValue();
    if (!eHeader) {
      sheet.getRange(1, COL_WAITLIST.NOTIFIED_AT + 1).setValue('通知日時')
        .setBackground('#f97316').setFontColor('#ffffff').setFontWeight('bold');
      sheet.setColumnWidth(COL_WAITLIST.NOTIFIED_AT + 1, 140);
      Logger.log('キャンセル待ちシートにE列（通知日時）を追加しました');
    } else {
      Logger.log('E列はすでに設定済みです: ' + eHeader);
    }
  }
  Logger.log('=== setupWaitlistSheet 完了 ===');
}

// ── イベントマスタへのFAQ用列追加セットアップ ────────────
function setupEventMasterFaqColumns() {
  const sheet = getSheet(SHEET.EVENT);
  if (!sheet) {
    Logger.log('イベントマスタが見つかりません');
    return;
  }

  const fHeader = sheet.getRange(1, COL_EVENT.FEE + 1).getValue();
  if (!fHeader) {
    sheet.getRange(1, COL_EVENT.FEE   + 1).setValue('参加費');
    sheet.getRange(1, COL_EVENT.STUFF + 1).setValue('持ち物');
    sheet.getRange(1, COL_EVENT.NOTE  + 1).setValue('補足');
    sheet.setColumnWidth(COL_EVENT.FEE   + 1, 120);
    sheet.setColumnWidth(COL_EVENT.STUFF + 1, 300);
    sheet.setColumnWidth(COL_EVENT.NOTE  + 1, 300);
    Logger.log('イベントマスタにFAQ列を追加しました');
  } else {
    Logger.log('FAQ列はすでに設定済みです: ' + fHeader);
  }
  Logger.log('=== setupEventMasterFaqColumns 完了 ===');
}
