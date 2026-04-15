// ============================================================
// inquiry_form.gs  お問い合わせ受付・FAQ自動回答・管理者通知
// ============================================================
//
// 【処理フロー】
//
//   INQUIRY_WAIT 状態でユーザーがテキスト送信
//     │
//     ├─ ① FAQキーワード一致
//     │       → 自動回答 → IDLE（完結）
//     │
//     ├─ ② FAQキーワード不一致 → マスタ動的検索
//     │       → 関連情報あり → 動的回答 → IDLE（完結）
//     │       → 関連情報なし → 受付 → WAITING_REPLY
//     │
//     └─ WAITING_REPLY 中にテキスト送信
//             → 「対応中です」を返す（受け付けない）
//
// 【動的検索の参照先】
//   イベントマスタ: A=ID, B=名前, C=説明, D=定員, E=有効フラグ,
//                   F=参加費, G=持ち物, H=補足   ← F〜H列を新規追加
//   日程マスタ    : A=日程ID, B=イベントID, C=開催日時,
//                   D=受付開始, E=受付終了, F=個別定員, G=場所
//
// 【動的検索トリガーキーワード】（FAQシートに登録不要）
//   料金・費用・いくら → イベントマスタF列
//   持ち物・何が必要  → イベントマスタG列
//   日程・いつ・次回  → 日程マスタC列（受付中の直近1件）
//   場所・会場・どこ  → 日程マスタG列（受付中の直近1件）
//   時間・何時・開始  → 日程マスタC列から整形
//
// ============================================================

// ── 動的検索のトリガーキーワード定義 ─────────────────────
// FAQシートではなくコード側で管理する
// イベントマスタ・日程マスタを参照して動的に回答する質問群
const DYNAMIC_KEYWORDS = {
  fee:      ['料金', '参加費', 'いくら', '費用', '値段', '無料', '有料'],
  stuff:    ['持ち物', '何が必要', '準備', '荷物', '持参', '必要なもの'],
  schedule: ['日程', 'いつ', '次回', 'スケジュール', '予定', '開催'],
  location: ['場所', '会場', 'どこ', 'アクセス', '住所'],
  time:     ['時間', '何時', '開始', '終了', 'タイムライン', '何時から'],
};

// ── リッチメニュー「お問い合わせ」タップ時の案内 ──────────
function handleInquiryTrigger(userId, replyToken) {
  setSession(userId, STATE.INQUIRY_WAIT, {});
  replyText(replyToken,
    'ご質問をこのトークにそのままお送りください💬\n\n' +
    'よくある質問は自動でお答えします。\n' +
    'それ以外は担当者が本日中にご連絡します🙏'
  );
}

// ── メイン処理: FAQ → 動的検索 → 担当者受付 ──────────────
function handleInquiry(userId, text, replyToken) {
  const normalized = text.replace(/　/g, ' ').toLowerCase();

  // ── ① FAQシート検索 ──────────────────────────────────
  const faqAnswer = searchFaq(normalized);
  if (faqAnswer) {
    clearSession(userId);
    replyText(replyToken, faqAnswer);
    recordInquiry(userId, text, 'FAQ自動回答', null);
    return;
  }

  // ── ② マスタ動的検索 ─────────────────────────────────
  const dynamicAnswer = buildDynamicAnswer(normalized);
  if (dynamicAnswer) {
    clearSession(userId);
    replyText(replyToken, dynamicAnswer);
    recordInquiry(userId, text, '動的自動回答', null);
    return;
  }

  // ── ③ 担当者受付 ─────────────────────────────────────
  // recordInquiry を先に呼び、成功後にセッションをセット（順序重要）
  const inquiryId = generateUniqueId('IQ', SHEET.INQUIRY);
  recordInquiry(userId, text, '未対応', inquiryId);

  // 記録成功後にセッションを WAITING_REPLY にセット
  setSession(userId, STATE.WAITING_REPLY, { inquiryId });

  replyText(replyToken,
    'お問い合わせありがとうございます🙏\n\n' +
    '担当者が確認次第、このトークにご返信します。\n' +
    '本日中を目安にご連絡します。\n\n' +
    '受付ID: ' + inquiryId
  );

  notifyAdminNewInquiry(userId, text, inquiryId);
}

// ── FAQシート検索 ─────────────────────────────────────────
// FAQシート: A=キーワード（,区切り）, B=優先度, C=回答文, D=有効フラグ
function searchFaq(normalizedText) {
  const faqs = getAllRows(SHEET.FAQ)
    .filter(r => r[3] === true)
    .sort((a, b) => Number(a[1]) - Number(b[1]));

  const matched = faqs.find(r => {
    const keywords = String(r[0]).split(',').map(k => k.trim()).filter(Boolean);
    return keywords.some(kw => normalizedText.includes(kw.toLowerCase()));
  });

  return matched ? matched[2] : null;
}

// ── マスタ動的検索 ────────────────────────────────────────
// 質問内容に応じてイベントマスタ・日程マスタを参照して回答文を生成する
// 受付中のイベント×直近日程を対象に整形して返す
// 回答を生成できた場合は文字列を、できなかった場合は null を返す
function buildDynamicAnswer(normalizedText) {
  const category = detectDynamicCategory(normalizedText);
  if (!category) return null;

  const nowDate  = new Date();
  const events   = getAllRows(SHEET.EVENT).filter(r => r[4] === true);
  const scheds   = getAllRows(SHEET.SCHED);

  // 受付中かつ直近の日程をイベントごとに1件ずつ取得
  const activeItems = events.map(ev => {
    const evId = ev[0];
    const upcoming = scheds
      .filter(s =>
        s[1] === evId &&
        nowDate >= new Date(s[3]) &&  // 受付開始以降
        nowDate <= new Date(s[4])     // 受付終了以前
      )
      .sort((a, b) => new Date(a[2]) - new Date(b[2])); // 開催日時昇順

    if (upcoming.length === 0) return null;
    return { ev, sched: upcoming[0] };
  }).filter(Boolean);

  if (activeItems.length === 0) return null;

  // カテゴリに応じて回答文を整形
  const lines = activeItems.map(({ ev, sched }) => {
    const evName = ev[1];
    const fee    = ev[5] || '';   // F列: 参加費
    const stuff  = ev[6] || '';   // G列: 持ち物
    const note   = ev[7] || '';   // H列: 補足
    const dt     = Utilities.formatDate(new Date(sched[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm');
    const loc    = sched[6] || '';

    switch (category) {
      case 'fee':
        return fee
          ? '【' + evName + '】\n参加費: ' + fee
          : '【' + evName + '】\n参加費: 詳細はイベントページをご確認ください';

      case 'stuff':
        return stuff
          ? '【' + evName + '】\n持ち物: ' + stuff
          : '【' + evName + '】\n持ち物: 特に指定はありません';

      case 'schedule':
        return '【' + evName + '】\n次回: ' + dt;

      case 'location':
        return loc
          ? '【' + evName + '】\n場所: ' + loc
          : null;

      case 'time':
        return '【' + evName + '】\n時間: ' + dt;

      default:
        return null;
    }
  }).filter(Boolean);

  if (lines.length === 0) return null;

  // 末尾に予約案内を添える
  const body = lines.join('\n\n');
  return body + '\n\n予約はメニューの「予約する」からどうぞ。';
}

// ── 動的検索カテゴリの判定 ────────────────────────────────
// テキストがどのカテゴリのキーワードに一致するか判定する
// いずれにも一致しない場合は null を返す
function detectDynamicCategory(normalizedText) {
  for (const category in DYNAMIC_KEYWORDS) {
    const keywords = DYNAMIC_KEYWORDS[category];
    if (keywords.some(kw => normalizedText.includes(kw))) {
      return category;
    }
  }
  return null;
}

// ── お問い合わせ記録 ──────────────────────────────────────
// シート列: A=ID, B=userId, C=質問内容, D=ステータス, E=受付日時, F=対応日時
// FAQ自動回答・動的自動回答はIDなし（null → ''）で記録
// 未対応のみ inquiryId を発行してセッションに保存
function recordInquiry(userId, question, status, inquiryId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.INQUIRY);
    sheet.appendRow([
      inquiryId || '',
      userId,
      question,
      status,
      now(),
      '', // F列: 対応日時（onInquiryEdit()が自動記入）
    ]);
  } finally {
    lock.releaseLock();
  }
}

// ── 管理者への新規問い合わせ通知 ─────────────────────────
function notifyAdminNewInquiry(userId, question, inquiryId) {
  if (!ADMIN_LINE_USER_ID) return;

  const userInfo = getUserInfo(userId);
  const userName = (userInfo.status === 'found') ? userInfo.name : '未登録ユーザー';

  const message =
    '【新規お問い合わせ】\n' +
    '─────────────────\n' +
    userName + 'さんから質問が届きました。\n\n' +
    '「' + question + '」\n' +
    '─────────────────\n' +
    'ID: ' + inquiryId;

  pushMessage(ADMIN_LINE_USER_ID, message);
}

// ── LINEへのpushメッセージ送信 ───────────────────────────
function pushMessage(toUserId, text) {
  const url = 'https://api.line.me/v2/bot/message/push';
  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
    },
    payload: JSON.stringify({
      to: toUserId,
      messages: [{ type: 'text', text }],
    }),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() !== 200) {
    Logger.log('push送信エラー: ' + res.getContentText());
  }
}
