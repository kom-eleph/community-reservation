// ============================================================
// webhook.gs  LINEからのWebhookを受け取るエントリーポイント
// ============================================================

// ── LIFFトークン検証（フロントからの書き込み系リクエスト用） ──
// 検証に失敗した場合は null を返す
function verifyLiffToken(token) {
  if (!token) return null;
  const url = 'https://api.line.me/oauth2/v2.1/verify?access_token=' + encodeURIComponent(token);
  try {
    const res  = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    const code = res.getResponseCode();
    if (code !== 200) {
      debugLog('[verifyLiffToken] 検証失敗 code=' + code);
      return null;
    }
    const body = JSON.parse(res.getContentText());
    if (body.client_id !== LIFF_CHANNEL_ID) {
      debugLog('[verifyLiffToken] client_id不一致 ' + body.client_id);
      return null;
    }
    return body;
  } catch (err) {
    Logger.log('[verifyLiffToken] エラー: ' + err.message);
    return null;
  }
}

// ── 認証エラーレスポンス生成ヘルパー ─────────────────────
function authErrorResponse(callback) {
  const json = JSON.stringify({ status: 'error', message: '認証エラーです。再度お試しください。' });
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// 書き込み系アクション（副作用あり）— LIFFトークン検証必須
const WRITE_ACTIONS = new Set([
  'reserve', 'cancel', 'change', 'registerUser', 'joinWaitlist',
  'reserveWithAttendee',
  'changeWithAttendee',
]);

// 個人データを返す読み取り系 — LIFFトークン検証必須
const AUTH_REQUIRED_ACTIONS = new Set([
  'getMyReservations', 'getInitialData', 'getUserInfo', 'getBootData',
]);

// ── GET リクエスト（フロントからの JSONP）────────────────
function doGet(e) {
  const action   = e.parameter.action;
  const callback = e.parameter.callback;
  let result     = { status: 'error', message: 'unknown action' };

  debugLog(`doGet action=${action} userId=${e.parameter.userId || '(none)'}`);

  // 書き込み系・個人データ取得系はLIFFトークン検証必須
  if (WRITE_ACTIONS.has(action) || AUTH_REQUIRED_ACTIONS.has(action)) {
    const verified = verifyLiffToken(e.parameter.liffToken);
    if (!verified) return authErrorResponse(callback);
  }

  try {
    switch (action) {
      case 'getEvents':
        result = getAvailableEvents(e.parameter.userId);
        break;
      case 'getSchedules':
      case 'getSchedulesByEvent':
        result = getSchedulesByEvent(e.parameter.eventId, e.parameter.userId);
        break;
      case 'reserve':
        result = processReservation(e.parameter.userId, e.parameter.schedId, e.parameter.name);
        break;
      case 'getMyReservations':
        result = getMyReservations(e.parameter.userId);
        break;
      case 'cancel':
        result = cancelReservationById(e.parameter.userId, e.parameter.reservationId);
        break;
      case 'registerUser':
        result = registerUser(
          e.parameter.userId,
          e.parameter.name,
          e.parameter.birthdate,
          e.parameter.gender
        );
        break;
      case 'getUserInfo':
        result = getUserInfo(e.parameter.userId);
        break;
      case 'change':
        result = changeReservation(
          e.parameter.userId,
          e.parameter.oldReservationId,
          e.parameter.newSchedId,
          e.parameter.name
        );
        break;
      case 'getInitialData':
        result = getInitialData(e.parameter.userId);
        break;
      case 'getBootData':
        result = getBootData(e.parameter.userId, e.parameter.mode);
        break;
      case 'getEventStats':
        result = getEventStats(e.parameter.eventId);
        break;
      case 'joinWaitlist':
        result = joinWaitlist(e.parameter.userId, e.parameter.schedId);
        break;
      case 'reserveWithAttendee':
        result = reserveWithAttendee(
          e.parameter.userId,
          e.parameter.schedId,
          e.parameter.name,
          e.parameter.birthdate,
          e.parameter.gender
        );
        break;
      case 'changeWithAttendee':
        result = changeWithAttendee(
          e.parameter.userId,
          e.parameter.oldReservationId,
          e.parameter.newSchedId,
          e.parameter.name,
          e.parameter.birthdate,
          e.parameter.gender
        );
        break;
      default:
        result = { status: 'error', message: 'unknown action: ' + action };
    }
  } catch (err) {
    Logger.log(`[ERROR] action=${action} message=${err.message}\n${err.stack}`);
    result = { status: 'error', message: 'サーバーエラーが発生しました。しばらく時間をおいて再度お試しください。' };
  }

  const json = JSON.stringify(result);
  if (callback) {
    return ContentService
      .createTextOutput(callback + '(' + json + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService
    .createTextOutput(json)
    .setMimeType(ContentService.MimeType.JSON);
}

// ── POST リクエスト（LINE Webhook 専用）──────────────────
//
// 【重要】GAS の doPost では X-Line-Signature リクエストヘッダーを
// 直接取得する手段がありません。そのため署名検証は GAS 側では実施せず、
// LINE プラットフォームのセキュリティ（Webhook URL の秘匿、HTTPS強制）
// に委ねます。
// Webhook URL は外部に公開しないよう運用で管理してください。
//
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // LINE の ping（空イベント）への応答
    const events = body.events || [];
    if (events.length === 0) return HtmlService.createHtmlOutput('ok');

    events.forEach(event => handleEvent(event));

  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
  }
  return HtmlService.createHtmlOutput('ok');
}

// ── LINEイベントハンドラ ──────────────────────────────────
function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text') return;

  const userId     = event.source.userId;
  const text       = event.message.text.trim();
  const replyToken = event.replyToken;

  debugLog(`handleEvent userId=${userId} text=${text}`);

  const session   = getSession(userId);
  const userState = session ? session.state : STATE.IDLE;

  // ── リッチメニュー固定テキスト ─────────────────────────
  if (text === '予約する')     return startReservation(userId, replyToken);
  if (text === '予約確認')     return showMyReservation(userId, replyToken);
  if (text === '予約変更')     return startChange(userId, replyToken);
  if (text === 'キャンセル')   return startCancel(userId, replyToken);
  if (text === 'お問い合わせ') return handleInquiryTrigger(userId, replyToken);

  // リッチメニューの「情報表示のみ」項目は無視
  const RICH_MENU_IGNORE = ['1 day Xとは？'];
  const normalizedText = text.replace(/　/g, ' ').toLowerCase();
  if (RICH_MENU_IGNORE.some(t => normalizedText === t.replace(/　/g, ' ').toLowerCase())) {
    return;
  }

  // ── セッション状態に応じた処理 ────────────────────────
  if (userState === STATE.WAITING_NAME)  return handleNameInput(userId, text, replyToken, session);
  if (userState === STATE.WAITING_SCHED) return handleSchedSelect(userId, text, replyToken, session);
  if (userState === STATE.CONFIRM)       return handleConfirm(userId, text, replyToken, session);

  // お問い合わせ入力待ち
  if (userState === STATE.INQUIRY_WAIT)  return handleInquiry(userId, text, replyToken);

  // 担当者返信待ち中
  if (userState === STATE.WAITING_REPLY) {
    replyText(replyToken,
      '現在担当者が確認中です。\n返信までしばらくお待ちください🙏\n\n別の操作はメニューからどうぞ。'
    );
    return;
  }

  // その他
  replyText(replyToken, 'メニューの「お問い合わせ」ボタンからご質問をお送りください💬');
}

// ── LINE返信ヘルパー ──────────────────────────────────────
function replyMessage(replyToken, messages) {
  if (!Array.isArray(messages)) messages = [{ type: 'text', text: messages }];
  const url = 'https://api.line.me/v2/bot/message/reply';
  const options = {
    method:  'post',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
    },
    payload: JSON.stringify({ replyToken, messages }),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(url, options);
  if (res.getResponseCode() !== 200) {
    Logger.log('LINE reply error: ' + res.getContentText());
  }
}

function replyText(replyToken, text) {
  replyMessage(replyToken, [{ type: 'text', text }]);
}

// ── ウォームアップ（毎時トリガー推奨） ───────────────────
function keepAlive() {
  getSheet(SHEET.SESSION);
  debugLog('keepAlive: ' + new Date());
}

// ── テスト関数 ────────────────────────────────────────────
function testSetup() {
  testSpreadsheet();

  const sheet = getSheet(SHEET.USER);
  // 生年月日形式（YYYY-MM-DD）でテストデータを登録
  sheet.appendRow(['U_TEST_001', 'テストユーザー', '1990-01-01', '男性', now()]);
  Logger.log('テスト書き込み完了');

  setSession('U_TEST_001', STATE.IDLE, {});
  Logger.log('セッション書き込み完了');

  Logger.log('=== testSetup 完了 ===');
}