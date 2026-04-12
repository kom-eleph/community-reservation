// ============================================================
// inquiry.gs  FAQシートを検索して自動返信する
// ============================================================

function handleInquiry(userId, text, replyToken) {
  const faqs = getAllRows(SHEET.FAQ)
    .filter(r => r[3] === true)
    .sort((a, b) => a[1] - b[1]);

  const matched = faqs.find(r => {
    const keywords = String(r[0]).split(',');
    return keywords.some(kw => text.includes(kw.trim()));
  });

  if (matched) {
    replyText(replyToken, matched[2]);
  } else {
    replyText(replyToken,
      'ご質問ありがとうございます。\n' +
      '担当者が確認してご連絡します。\n\n' +
      'お急ぎの場合はメニューの「お問い合わせ」からご連絡ください。'
    );
    // 管理者へのメール通知（必要に応じてコメントアウト解除）
    // GmailApp.sendEmail('your-email@gmail.com', '未解決の問い合わせ', `UserID: ${userId}\n内容: ${text}`);
  }
}
