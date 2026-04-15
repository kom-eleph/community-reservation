// ============================================================
// inquiry_form.gs  お問い合わせ受付・FAQ自動回答・管理者通知
// ============================================================

// ── 動的検索のトリガーキーワード定義 ─────────────────────
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

  // ① FAQシート検索
  const faqAnswer = searchFaq(normalized);
  if (faqAnswer) {
    clearSession(userId);
    replyText(replyToken, faqAnswer);
    recordInquiry(userId, text, INQUIRY_STATUS.CLOSED, null);
    return;
  }

  // ② マスタ動的検索
  const dynamicAnswer = buildDynamicAnswer(normalized);
  if (dynamicAnswer) {
    clearSession(userId);
    replyText(replyToken, dynamicAnswer);
    recordInquiry(userId, text, '動的自動回答', null);
    return;
  }

  // ③ 担当者受付
  const inquiryId = generateUniqueId('IQ', SHEET.INQUIRY);
  recordInquiry(userId, text, INQUIRY_STATUS.OPEN, inquiryId);

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
function searchFaq(normalizedText) {
  const faqs = getAllRows(SHEET.FAQ)
    .filter(r => r[COL_FAQ.IS_ACTIVE] === true)
    .sort((a, b) => Number(a[COL_FAQ.PRIORITY]) - Number(b[COL_FAQ.PRIORITY]));

  const matched = faqs.find(r => {
    const keywords = String(r[COL_FAQ.KEYWORDS]).split(',').map(k => k.trim()).filter(Boolean);
    return keywords.some(kw => normalizedText.includes(kw.toLowerCase()));
  });

  return matched ? matched[COL_FAQ.ANSWER] : null;
}

// ── マスタ動的検索 ────────────────────────────────────────
function buildDynamicAnswer(normalizedText) {
  const category = detectDynamicCategory(normalizedText);
  if (!category) return null;

  const nowDate = new Date();
  const events  = getAllRows(SHEET.EVENT).filter(r => r[COL_EVENT.IS_ACTIVE] === true);
  const scheds  = getAllRows(SHEET.SCHED);

  const activeItems = events.map(ev => {
    const evId    = ev[COL_EVENT.ID];
    const upcoming = scheds
      .filter(s =>
        s[COL_SCHED.EVENT_ID] === evId &&
        nowDate >= new Date(s[COL_SCHED.ACCEPT_START]) &&
        nowDate <= new Date(s[COL_SCHED.ACCEPT_END])
      )
      .sort((a, b) => new Date(a[COL_SCHED.DATETIME]) - new Date(b[COL_SCHED.DATETIME]));

    if (upcoming.length === 0) return null;
    return { ev, sched: upcoming[0] };
  }).filter(Boolean);

  if (activeItems.length === 0) return null;

  const lines = activeItems.map(({ ev, sched }) => {
    const evName = ev[COL_EVENT.NAME];
    const fee    = ev[COL_EVENT.FEE]   || '';
    const stuff  = ev[COL_EVENT.STUFF] || '';
    const dt     = formatDatetime(sched[COL_SCHED.DATETIME]);
    const loc    = sched[COL_SCHED.LOCATION] || '';

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
        return loc ? '【' + evName + '】\n場所: ' + loc : null;
      case 'time':
        return '【' + evName + '】\n時間: ' + dt;
      default:
        return null;
    }
  }).filter(Boolean);

  if (lines.length === 0) return null;
  return lines.join('\n\n') + '\n\n予約はメニューの「予約する」からどうぞ。';
}

// ── 動的検索カテゴリの判定 ────────────────────────────────
function detectDynamicCategory(normalizedText) {
  for (const category in DYNAMIC_KEYWORDS) {
    if (DYNAMIC_KEYWORDS[category].some(kw => normalizedText.includes(kw))) {
      return category;
    }
  }
  return null;
}

// ── お問い合わせ記録 ──────────────────────────────────────
function recordInquiry(userId, question, status, inquiryId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    getSheet(SHEET.INQUIRY).appendRow([
      inquiryId || '',
      userId,
      question,
      status,
      now(),
      '',
    ]);
  } finally {
    lock.releaseLock();
  }
}

// ── 管理者への新規問い合わせ通知 ─────────────────────────
function notifyAdminNewInquiry(userId, question, inquiryId) {
  if (!ADMIN_LINE_USER_ID) return;
  const userInfo = getUserInfo(userId);
  const userName = (userInfo.status === USER_STATUS.FOUND) ? userInfo.name : '未登録ユーザー';
  pushMessage(ADMIN_LINE_USER_ID,
    '【新規お問い合わせ】\n─────────────────\n' +
    userName + 'さんから質問が届きました。\n\n' +
    '「' + question + '」\n' +
    '─────────────────\n' +
    'ID: ' + inquiryId
  );
}

// ── LINEへのpushメッセージ送信 ───────────────────────────
// reservation.gs / spreadsheet_trigger.gs からも呼ばれる共通関数
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
