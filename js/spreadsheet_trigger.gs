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
//   2. スプレッドシートの該当行 D列を「対応済」に変更する
//      → 自動でユーザーにpush通知 + セッションがIDLEに戻る
//
// 【スプレッドシートの列構成】
//   A=お問い合わせID  ← GAS自動記入（編集不要）
//   B=userId          ← GAS自動記入（編集不要）
//   C=質問内容        ← GAS自動記入（編集不要）
//   D=ステータス      ← 管理者が「対応済」に変更する唯一の列
//   E=受付日時        ← GAS自動記入（編集不要）
//   F=対応日時        ← GAS自動記入（対応済変更時に自動記入）
//
// ============================================================

function onInquiryEdit(e) {
  const range = e.range;
  const col   = range.getColumn();
  const row   = range.getRow();

  // ── ガード①: 対象シート以外は即return ──────────────────
  // 予約シートなど他シートの編集では何もしない
  if (e.source.getActiveSheet().getName() !== SHEET.INQUIRY) return;

  // ── ガード②: D列（4列目）以外の編集は即return ──────────
  // A〜C・E列はGAS自動記入のため管理者は触らない想定だが念のため
  if (col !== 4) return;

  // ── ガード③: ヘッダー行はスキップ ──────────────────────
  if (row <= 1) return;

  // ── ガード④: 「対応済」以外の値への変更は無視 ───────────
  // 「未対応」への差し戻しや誤入力では発火しない
  const newValue = String(range.getValue()).trim();
  if (newValue !== '対応済') return;

  // ── ここまで到達するのは「D列を対応済に変更した時だけ」──
  const sheet   = e.source.getActiveSheet();
  const rowData = sheet.getRange(row, 1, 1, 5).getValues()[0];

  const inquiryId = rowData[0]; // A列: ID
  const userId    = rowData[1]; // B列: userId

  if (!userId) {
    Logger.log('[onInquiryEdit] userIdが空です row=' + row);
    return;
  }

  debugLog('[onInquiryEdit] 対応済検知 inquiryId=' + inquiryId + ' userId=' + userId);

  // F列（対応日時）を自動記入
  sheet.getRange(row, 6).setValue(now());

  // ユーザーへpush通知
  // ※ 返信内容はLINE管理画面のチャットで送信済みの前提
  pushMessage(userId,
    '担当者が対応を完了しました。\n' +
    'その他ご不明な点はメニューの「お問い合わせ」からどうぞ。'
  );

  // ユーザーのセッションを IDLE に戻す
  clearSession(userId);

  debugLog('[onInquiryEdit] セッションをIDLEに戻しました userId=' + userId);
}

// ── トリガー登録ヘルパー（一度だけ手動実行） ────────────
function setupInquiryTrigger() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);

  // 既存の同名トリガーを削除（重複防止）
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'onInquiryEdit')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('onInquiryEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log('onInquiryEdit トリガーを登録しました');
}
