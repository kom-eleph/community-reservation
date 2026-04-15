// ============================================================
// config.gs  ★ここだけ自分の値に書き換える
// ============================================================

const SPREADSHEET_ID = 'hogehoge';
const LINE_CHANNEL_ACCESS_TOKEN = 'hogehoge';
const LINE_CHANNEL_SECRET = 'hogehoge';

// 管理者通知用LINEユーザーID（任意。不要なら空文字 '' のまま）
const ADMIN_LINE_USER_ID = 'hogehoge';
 
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
  INQUIRY:  'お問い合わせシート',  // ← 追加
};
 
// セッションState定数
const STATE = {
  IDLE:           'IDLE',
  WAITING_NAME:   'WAITING_NAME',
  WAITING_SCHED:  'WAITING_SCHED',
  CONFIRM:        'CONFIRM',
  INQUIRY_WAIT:   'INQUIRY_WAIT',   // お問い合わせ内容の入力待ち
  WAITING_REPLY:  'WAITING_REPLY',  // 担当者の返信待ち（テキスト受付停止）
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
 
// ── お問い合わせシートの初期セットアップ ─────────────────
// GASエディタから一度だけ手動実行する
function setupInquirySheet() {
  const ss  = SpreadsheetApp.openById(SPREADSHEET_ID);
  let sheet = ss.getSheetByName(SHEET.INQUIRY);
 
  if (!sheet) {
    sheet = ss.insertSheet(SHEET.INQUIRY);
    Logger.log('シートを作成しました: ' + SHEET.INQUIRY);
  }
 
  // ヘッダー行が未設定の場合のみ書き込む
  const firstRow = sheet.getRange(1, 1).getValue();
  if (!firstRow) {
    // 列構成: A〜E・F列のみ（管理者が触るのはD列のみ）
    sheet.getRange(1, 1, 1, 6).setValues([[
      'お問い合わせID', 'userId', '質問内容', 'ステータス',
      '受付日時', '対応日時'
    ]]);
    sheet.getRange(1, 1, 1, 6)
      .setBackground('#4a90d9')
      .setFontColor('#ffffff')
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.setColumnWidth(1, 180); // A: ID
    sheet.setColumnWidth(2, 160); // B: userId
    sheet.setColumnWidth(3, 300); // C: 質問内容
    sheet.setColumnWidth(4, 80);  // D: ステータス ← 管理者が触る唯一の列
    sheet.setColumnWidth(5, 140); // E: 受付日時
    sheet.setColumnWidth(6, 140); // F: 対応日時（GAS自動記入）
    // D列に入力規則（対応済のみ選択可）を設定
    const statusRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(['未対応', '対応済'], true)
      .setAllowInvalid(false)
      .build();
    sheet.getRange(2, 4, 1000, 1).setDataValidation(statusRule);
    Logger.log('ヘッダーを設定しました');
  }
  Logger.log('=== setupInquirySheet 完了 ===');
}
 
// ── イベントマスタへのFAQ用列追加セットアップ ────────────
// GASエディタから一度だけ手動実行する
// 既存のA〜E列はそのまま。F〜H列のヘッダーを追加するだけ。
function setupEventMasterFaqColumns() {
  const sheet = getSheet(SHEET.EVENT);
  if (!sheet) {
    Logger.log('イベントマスタが見つかりません');
    return;
  }
 
  // F〜H列のヘッダーが未設定の場合のみ書き込む
  const fHeader = sheet.getRange(1, 6).getValue();
  if (!fHeader) {
    sheet.getRange(1, 6).setValue('参加費');
    sheet.getRange(1, 7).setValue('持ち物');
    sheet.getRange(1, 8).setValue('補足');
    sheet.setColumnWidth(6, 120); // F列
    sheet.setColumnWidth(7, 300); // G列
    sheet.setColumnWidth(8, 300); // H列
    Logger.log('イベントマスタにF〜H列を追加しました');
  } else {
    Logger.log('F列はすでに設定済みです: ' + fHeader);
  }
  Logger.log('=== setupEventMasterFaqColumns 完了 ===');
}
