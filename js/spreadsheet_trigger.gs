// ============================================================
// spreadsheet_trigger.gs  スプレッドシートの編集トリガー
// ============================================================
//
// 【設定手順】（一度だけ手動で行う）
//   GASエディタ → トリガー → トリガーを追加
//     実行する関数: onInquiryEdit
//     イベントのソース: スプレッドシートから
//     イベントの種類: 編集時
//
//   または setupInquiryTrigger() を一度だけ手動実行する。
//
// 【管理者の操作ルール】
//   ★ スプレッドシートで管理者が触る列は D列のみ ★
//   1. LINE管理画面のチャット画面でユーザーに返信する
//   2. 該当行 D列を「対応済」に変更 → 自動でpush通知 + セッションがIDLEに戻る
//
// ============================================================

function onInquiryEdit(e) {
  const range = e.range;
  const col   = range.getColumn();
  const row   = range.getRow();

  // ガード①: 対象シート以外は即return
  if (e.source.getActiveSheet().getName() !== SHEET.INQUIRY) return;

  // ガード②: ステータス列（D列 = COL_INQUIRY.STATUS + 1）以外は即return
  if (col !== COL_INQUIRY.STATUS + 1) return;

  // ガード③: ヘッダー行はスキップ
  if (row <= 1) return;

  // ガード④: 「対応済」以外の値への変更は無視
  const newValue = String(range.getValue()).trim();
  if (newValue !== INQUIRY_STATUS.CLOSED) return;

  const sheet   = e.source.getActiveSheet();
  const rowData = sheet.getRange(row, 1, 1, COL_INQUIRY.HANDLED_AT + 1).getValues()[0];

  const inquiryId = rowData[COL_INQUIRY.ID];
  const userId    = rowData[COL_INQUIRY.USER_ID];

  if (!userId) {
    Logger.log('[onInquiryEdit] userIdが空です row=' + row);
    return;
  }

  debugLog('[onInquiryEdit] 対応済検知 inquiryId=' + inquiryId + ' userId=' + userId);

  // F列（対応日時）を自動記入
  sheet.getRange(row, COL_INQUIRY.HANDLED_AT + 1).setValue(now());

  pushMessage(userId,
    '担当者が対応を完了しました。\n' +
    'その他ご不明な点はメニューの「お問い合わせ」からどうぞ。'
  );

  clearSession(userId);

  debugLog('[onInquiryEdit] セッションをIDLEに戻しました userId=' + userId);
}

// ── トリガー登録ヘルパー（一度だけ手動実行） ────────────
function setupInquiryTrigger() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onInquiryEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('onInquiryEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log('onInquiryEdit トリガーを登録しました');
}
