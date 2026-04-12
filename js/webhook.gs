// ============================================================
// webhook.gs  LINEからのWebhookを受け取るエントリーポイント
// ============================================================

function doGet(e) {
  const action   = e.parameter.action;
  const callback = e.parameter.callback;
  let result     = { status: 'error', message: 'unknown action' };

  // DEBUGフラグが true のときのみログ記録（本番ログ量削減）
  debugLog(`doGet action=${action} userId=${e.parameter.userId || '(none)'}`);

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
          e.parameter.age,
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
      case 'getEventStats':
        // 管理者向け（本番ではパスワード確認などの追加を推奨）
        result = getEventStats(e.parameter.eventId);
        break;
      case 'joinWaitlist':
        result = joinWaitlist(e.parameter.userId, e.parameter.schedId);
        break;
      default:
        result = { status: 'error', message: 'unknown action: ' + action };
    }
  } catch (err) {
    // エラーは常にログ記録（DEBUGフラグ不問）
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

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // LIFFからのPOSTリクエスト処理
    if (body.action === 'reserve') {
      const result = processReservation(body.userId, body.schedId, body.name);
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // LINE Webhookイベント処理
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

  const session = getSession(userId);
  const state   = session ? session.state : STATE.IDLE;

  if (text === '予約する')   return startReservation(userId, replyToken);
  if (text === '予約確認')   return showMyReservation(userId, replyToken);
  if (text === '予約変更')   return startChange(userId, replyToken);
  if (text === 'キャンセル') return startCancel(userId, replyToken);

  if (state === STATE.WAITING_NAME)  return handleNameInput(userId, text, replyToken, session);
  if (state === STATE.WAITING_SCHED) return handleSchedSelect(userId, text, replyToken, session);
  if (state === STATE.CONFIRM)       return handleConfirm(userId, text, replyToken, session);

  handleInquiry(userId, text, replyToken);
}

// ── LINE返信ヘルパー ──────────────────────────────────────
function replyMessage(replyToken, messages) {
  if (!Array.isArray(messages)) messages = [{ type: 'text', text: messages }];
  const url = 'https://api.line.me/v2/bot/message/reply';
  const options = {
    method:  'post',
    headers: {
      'Content-Type': 'application/json',
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
  sheet.appendRow(['U_TEST_001', 'テストユーザー', 30, '男性', now()]);
  Logger.log('テスト書き込み完了');

  setSession('U_TEST_001', STATE.IDLE, {});
  Logger.log('セッション書き込み完了');

  Logger.log('=== testSetup 完了 ===');
}
