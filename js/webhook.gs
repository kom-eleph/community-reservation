// ============================================================
// webhook.gs  LINEからのWebhookを受け取るエントリーポイント
// ============================================================

function doGet(e) {
  const action   = e.parameter.action;
  const callback = e.parameter.callback;
  let result     = { status: 'error', message: 'unknown action' };

  try {
    if (action === 'getEvents') {
      result = getAvailableEvents(e.parameter.userId);
    } else if (action === 'getSchedules') {
      result = getSchedulesByEvent(e.parameter.eventId, e.parameter.userId);
    } else if (action === 'getSchedulesByEvent') {
      result = getSchedulesByEvent(e.parameter.eventId);
    } else if (action === 'reserve') {
      result = processReservation(
        e.parameter.userId,
        e.parameter.schedId,
        e.parameter.name
      );
    } else if (action === 'getMyReservations') {
      result = getMyReservations(e.parameter.userId);
    } else if (action === 'cancel') {
      result = cancelReservationById(
        e.parameter.userId,
        e.parameter.reservationId
      );
    } else if (action === 'registerUser') {
      result = registerUser(
        e.parameter.userId,
        e.parameter.name,
        e.parameter.age,
        e.parameter.gender
      );
    } else if (action === 'getUserInfo') {
      result = getUserInfo(e.parameter.userId);
    } else if (action === 'change') {
      result = changeReservation(
        e.parameter.userId,
        e.parameter.oldReservationId,
        e.parameter.newSchedId,
        e.parameter.name
      );
    } else if (action === 'getInitialData') {
      result = getInitialData(e.parameter.userId);
    } else {
      result = { status: 'ok' };
    }
  } catch(err) {
    result = { status: 'error', message: err.message };
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
    const events = body.events || [];
    if (events.length === 0) {
      return HtmlService.createHtmlOutput('ok');
    }
    // LIFFからの予約POSTリクエスト
    if (body.action === 'reserve') {
      const result = processReservation(
        body.userId, body.schedId, body.name
      );
      return ContentService
        .createTextOutput(JSON.stringify(result))
        .setMimeType(ContentService.MimeType.JSON);
    }
    events.forEach(event => handleEvent(event));
  } catch (err) {
    Logger.log('doPost error: ' + err.message);
  }
  return HtmlService.createHtmlOutput('ok');
}

function handleEvent(event) {
  if (event.type !== 'message') return;
  if (event.message.type !== 'text') return;

  const userId     = event.source.userId;
  const text       = event.message.text.trim();
  const replyToken = event.replyToken;

  // セッション取得
  const session = getSession(userId);
  const state   = session ? session.state : STATE.IDLE;

  // ── 予約メニュー操作 ──────────────────────────
  if (text === '予約する')      return startReservation(userId, replyToken);
  if (text === '予約確認')      return showMyReservation(userId, replyToken);
  if (text === '予約変更')      return startChange(userId, replyToken);
  if (text === 'キャンセル')    return startCancel(userId, replyToken);

  // ── セッション中の入力処理 ────────────────────
  if (state === STATE.WAITING_NAME)  return handleNameInput(userId, text, replyToken, session);
  if (state === STATE.WAITING_SCHED) return handleSchedSelect(userId, text, replyToken, session);
  if (state === STATE.CONFIRM)       return handleConfirm(userId, text, replyToken, session);

  // ── FAQ・問い合わせ ───────────────────────────
  handleInquiry(userId, text, replyToken);
}

// ── LINE返信ヘルパー ──────────────────────────────
function replyMessage(replyToken, messages) {
  if (!Array.isArray(messages)) messages = [{ type: 'text', text: messages }];
  const url = 'https://api.line.me/v2/bot/message/reply';
  const options = {
    method: 'post',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
    },
    payload: JSON.stringify({ replyToken, messages }),
    muteHttpExceptions: true,
  };
  UrlFetchApp.fetch(url, options);
}

function replyText(replyToken, text) {
  replyMessage(replyToken, [{ type: 'text', text }]);
}

function keepAlive() {
  // スプレッドシートに軽くアクセスしてGASをウォームアップする
  getSheet(SHEET.SESSION);
  Logger.log('keepAlive: ' + new Date());
}


// ── 動作確認用テスト関数 ─────────────────────────
function testSetup() {
  // スプレッドシート接続テスト
  const sheet = getSheet(SHEET.USER);
  Logger.log('ユーザーシート取得: ' + (sheet ? '成功' : '失敗'));

  // テストユーザー書き込み
  sheet.appendRow(['U_TEST_001', 'テストユーザー', now()]);
  Logger.log('テスト書き込み完了 → ユーザーシートを確認してください');

  // セッション書き込みテスト
  setSession('U_TEST_001', STATE.IDLE, {});
  Logger.log('セッション書き込み完了');

  Logger.log('=== testSetup 完了 ===');
}
