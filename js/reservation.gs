// ============================================================
// reservation.gs  予約・イベント・ユーザー管理
// ============================================================

// ── イベント一覧取得 ──────────────────────────────────────
function getAvailableEvents(userId) {
  const nowDate  = new Date();
  const events   = getAllRows(SHEET.EVENT).filter(r => r[4] === true);
  const scheds   = getAllRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);

  const activeScheds = scheds.filter(
    s => nowDate >= new Date(s[3]) && nowDate <= new Date(s[4])
  );
  const activeIds = new Set(activeScheds.map(s => s[1]));

  return {
    events: events
      .filter(e => activeIds.has(e[0]))
      .map(e => {
        const eventScheds = activeScheds.filter(s => s[1] === e[0]);

        // 全日程に予約済みの場合のみ「申込済み」としてボタン無効化
        const alreadyBooked = userId
          ? eventScheds.length > 0 && eventScheds.every(s =>
              reserves.some(r => r[1] === userId && r[2] === s[0] && r[3] === '予約中')
            )
          : false;

        return {
          id:           e[0],
          name:         e[1],
          description:  e[2],
          capacity:     e[3],
          alreadyBooked,
        };
      })
  };
}

// ── 日程一覧取得 ──────────────────────────────────────────
function getSchedulesByEvent(eventId, userId) {
  const nowDate  = new Date();
  const events   = getAllRows(SHEET.EVENT);
  const scheds   = getAllRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);
  const evtMap   = new Map(events.map(e => [e[0], e]));

  const available = scheds.filter(s =>
    s[1] === eventId &&
    nowDate >= new Date(s[3]) &&
    nowDate <= new Date(s[4])
  );

  return {
    schedules: available.map(s => {
      const capacity = s[5] || evtMap.get(s[1])?.[3] || 0;
      const booked   = reserves.filter(
        r => r[2] === s[0] && r[3] === '予約中'
      ).length;
      const alreadyBooked = userId
        ? reserves.some(r => r[1] === userId && r[2] === s[0] && r[3] === '予約中')
        : false;
      return {
        schedId:      s[0],
        datetime:     Utilities.formatDate(new Date(s[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm'),
        location:     s[6],
        capacity,
        remaining:    capacity - booked,
        alreadyBooked,
      };
    })
  };
}

// ── 自分の予約一覧 ────────────────────────────────────────
function getMyReservations(userId) {
  const reserves = getAllRows(SHEET.RESERVE);
  const scheds   = getAllRows(SHEET.SCHED);
  const events   = getAllRows(SHEET.EVENT);
  const evtMap   = new Map(events.map(e => [e[0], e]));
  const schedMap = new Map(scheds.map(s => [s[0], s]));

  const active = reserves.filter(
    r => r[1] === userId && r[3] === '予約中'
  );

  if (active.length === 0) return { status: 'none', reservations: [] };

  return {
    status: 'found',
    reservations: active.map(r => {
      const sched = schedMap.get(r[2]);
      const evt   = evtMap.get(sched?.[1]);
      return {
        reservationId: r[0],
        schedId:       r[2],
        eventId:       sched?.[1] || '',
        eventName:     evt?.[1]   || '(不明なイベント)',
        datetime:      sched ? Utilities.formatDate(
          new Date(sched[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm'
        ) : '',
        location: sched?.[6] || '',
      };
    })
  };
}

// ── キャンセル処理 ────────────────────────────────────────
function cancelReservationById(userId, reservationId) {
  if (!userId || !reservationId) {
    return { status: 'error', message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.RESERVE);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex(
      (r, i) => i > 0 &&
        r[0] === reservationId &&
        r[1] === userId &&       // userIdを検証してなりすまし防止
        r[3] === '予約中'
    );
    if (idx === -1) {
      return { status: 'error', message: '予約が見つかりません。' };
    }
    sheet.getRange(idx + 1, 4).setValue('キャンセル');
    sheet.getRange(idx + 1, 6).setValue(now()); // キャンセル日時を記録

    notifyAdminOnCancel(reservationId, userId);

    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

// ── 予約処理 ──────────────────────────────────────────────
function processReservation(userId, schedId, name) {
  if (!userId || !schedId) {
    return { status: 'error', message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // ロック取得後に最新データを取得（競合防止）
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getAllRows(SHEET.SCHED);
    const events   = getAllRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[0], e]));

    const duplicate = reserves.find(
      r => r[1] === userId && r[2] === schedId && r[3] === '予約中'
    );
    if (duplicate) {
      return { status: 'error', message: 'すでにこの日程に予約済みです。' };
    }

    const sched = scheds.find(s => s[0] === schedId);
    if (!sched) return { status: 'error', message: '日程が見つかりません。' };

    const capacity = sched[5] || evtMap.get(sched[1])?.[3] || 0;
    const booked   = reserves.filter(
      r => r[2] === schedId && r[3] === '予約中'
    ).length;
    if (booked >= capacity) {
      return { status: 'error', message: 'この日程は満席です。' };
    }

    const reservationId = generateUniqueId('RSV', SHEET.RESERVE);
    getSheet(SHEET.RESERVE).appendRow([
      reservationId, userId, schedId, '予約中', now(), ''
    ]);

    return { status: 'ok', reservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── ユーザー登録 ──────────────────────────────────────────
function registerUser(userId, name, age, gender) {
  if (!userId || !name || !age || !gender) {
    return { status: 'error', message: '必要なパラメータが不足しています。' };
  }
  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 120) {
    return { status: 'error', message: '正しい年齢を入力してください。' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.USER);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex((r, i) => i > 0 && r[0] === userId);
    if (idx > 0) {
      sheet.getRange(idx + 1, 2, 1, 3).setValues([[name, ageNum, gender]]);
    } else {
      sheet.appendRow([userId, name, ageNum, gender, now()]);
    }
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

// ── ユーザー情報取得 ──────────────────────────────────────
function getUserInfo(userId) {
  if (!userId) return { status: 'none' };
  const idx = findRowIndex(SHEET.USER, 0, userId);
  if (idx === -1) return { status: 'none' };
  const row = getAllRows(SHEET.USER)[idx];
  return {
    status: 'found',
    name:   row[1],
    age:    row[2],
    gender: row[3],
  };
}

// ── 日程変更 ──────────────────────────────────────────────
function changeReservation(userId, oldReservationId, newSchedId, name) {
  if (!userId || !oldReservationId || !newSchedId) {
    return { status: 'error', message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // ロック取得後に最新データを取得（競合防止）
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getAllRows(SHEET.SCHED);
    const events   = getAllRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[0], e]));

    // 旧予約の存在確認（userIdで本人確認）
    const oldIdx = reserves.findIndex(
      r => r[0] === oldReservationId && r[1] === userId && r[3] === '予約中'
    );
    if (oldIdx === -1) {
      return { status: 'error', message: '変更元の予約が見つかりません。' };
    }

    // 重複チェック
    const duplicate = reserves.find(
      r => r[1] === userId && r[2] === newSchedId && r[3] === '予約中'
    );
    if (duplicate) {
      return { status: 'error', message: 'すでにこの日程に予約済みです。' };
    }

    // 定員チェック
    const sched = scheds.find(s => s[0] === newSchedId);
    if (!sched) return { status: 'error', message: '日程が見つかりません。' };

    const capacity = sched[5] || evtMap.get(sched[1])?.[3] || 0;
    const booked   = reserves.filter(
      r => r[2] === newSchedId && r[3] === '予約中'
    ).length;
    if (booked >= capacity) {
      return { status: 'error', message: 'この日程は満席です。' };
    }

    // 新予約を先に登録してから旧予約をキャンセル（アトミック性確保）
    const newReservationId = generateUniqueId('RSV', SHEET.RESERVE);
    getSheet(SHEET.RESERVE).appendRow([
      newReservationId, userId, newSchedId, '予約中', now(), ''
    ]);
    getSheet(SHEET.RESERVE).getRange(oldIdx + 2, 4).setValue('変更済');

    return { status: 'ok', reservationId: newReservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── 初回データ一括取得（シート読み込みを最小化） ──────────
// 各関数が個別にgetAllRowsを呼ぶ実装から、
// スプレッドシートへのアクセス回数を減らすよう一括処理
function getInitialData(userId) {
  if (!userId) return { status: 'error', message: 'userIdが必要です。' };

  // 全シートデータを一括取得（I/O回数削減）
  const allEvents   = getAllRows(SHEET.EVENT);
  const allScheds   = getAllRows(SHEET.SCHED);
  const allReserves = getAllRows(SHEET.RESERVE);
  const allUsers    = getAllRows(SHEET.USER);

  // ユーザー情報
  const userRow = allUsers.find(r => r[0] === userId);
  const userInfo = userRow
    ? { status: 'found', name: userRow[1], age: userRow[2], gender: userRow[3] }
    : { status: 'none' };

  // イベント一覧
  const nowDate      = new Date();
  const activeScheds = allScheds.filter(
    s => nowDate >= new Date(s[3]) && nowDate <= new Date(s[4])
  );
  const activeIds = new Set(activeScheds.map(s => s[1]));
  const events = allEvents
    .filter(e => e[4] === true && activeIds.has(e[0]))
    .map(e => {
      const eventScheds   = activeScheds.filter(s => s[1] === e[0]);
      const alreadyBooked = eventScheds.length > 0 && eventScheds.every(s =>
        allReserves.some(r => r[1] === userId && r[2] === s[0] && r[3] === '予約中')
      );
      return {
        id:           e[0],
        name:         e[1],
        description:  e[2],
        capacity:     e[3],
        alreadyBooked,
      };
    });

  // 自分の予約
  const evtMap   = new Map(allEvents.map(e => [e[0], e]));
  const schedMap = new Map(allScheds.map(s => [s[0], s]));
  const activeRsv = allReserves.filter(r => r[1] === userId && r[3] === '予約中');
  const reservations = activeRsv.map(r => {
    const sched = schedMap.get(r[2]);
    const evt   = evtMap.get(sched?.[1]);
    return {
      reservationId: r[0],
      schedId:       r[2],
      eventId:       sched?.[1] || '',
      eventName:     evt?.[1]   || '(不明なイベント)',
      datetime:      sched ? Utilities.formatDate(
        new Date(sched[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm'
      ) : '',
      location: sched?.[6] || '',
    };
  });

  return {
    status:       'ok',
    userInfo,
    events,
    reservations,
  };
}

// ── イベント属性統計（管理者用） ──────────────────────────
function getEventStats(eventId) {
  const reserves = getAllRows(SHEET.RESERVE);
  const scheds   = getAllRows(SHEET.SCHED);
  const users    = getAllRows(SHEET.USER);
  const events   = getAllRows(SHEET.EVENT);

  const targetScheds = scheds
    .filter(s => !eventId || s[1] === eventId)
    .map(s => s[0]);

  const targetReserves = reserves.filter(
    r => targetScheds.includes(r[2]) && (r[3] === '予約中' || r[3] === '変更済')
  );

  const userMap   = new Map(users.map(u => [u[0], u]));
  const genderCount = {};
  const ageGroups   = { '10代': 0, '20代': 0, '30代': 0, '40代': 0, '50代以上': 0, '不明': 0 };

  targetReserves.forEach(r => {
    const user = userMap.get(r[1]);
    if (!user) return;

    const gender = user[3] || '不明';
    genderCount[gender] = (genderCount[gender] || 0) + 1;

    const age = parseInt(user[2], 10);
    if      (isNaN(age)) ageGroups['不明']++;
    else if (age < 20)   ageGroups['10代']++;
    else if (age < 30)   ageGroups['20代']++;
    else if (age < 40)   ageGroups['30代']++;
    else if (age < 50)   ageGroups['40代']++;
    else                 ageGroups['50代以上']++;
  });

  const eventName = events.find(e => e[0] === eventId)?.[1] || '全イベント';

  return {
    status:        'ok',
    eventId:       eventId || 'all',
    eventName,
    totalBookings: targetReserves.length,
    genderStats:   genderCount,
    ageGroupStats: ageGroups,
  };
}

// ── キャンセル待ちリスト登録 ──────────────────────────────
function joinWaitlist(userId, schedId) {
  if (!userId || !schedId) {
    return { status: 'error', message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.WAITLIST);
    const rows  = sheet.getDataRange().getValues();
    const already = rows.some(
      (r, i) => i > 0 && r[0] === userId && r[1] === schedId && r[2] === '待機中'
    );
    if (already) return { status: 'error', message: 'すでにキャンセル待ちに登録済みです。' };
    sheet.appendRow([userId, schedId, '待機中', now()]);
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

// ── 管理者へのキャンセル通知（任意） ─────────────────────
function notifyAdminOnCancel(reservationId, userId) {
  if (typeof ADMIN_LINE_USER_ID === 'undefined' || !ADMIN_LINE_USER_ID) return;
  try {
    const url = 'https://api.line.me/v2/bot/message/push';
    const options = {
      method: 'post',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + LINE_CHANNEL_ACCESS_TOKEN,
      },
      payload: JSON.stringify({
        to: ADMIN_LINE_USER_ID,
        messages: [{
          type: 'text',
          text: `【キャンセル通知】\n予約ID: ${reservationId}\nユーザー: ${userId}\n\n管理スプレッドシートをご確認ください。`,
        }],
      }),
      muteHttpExceptions: true,
    };
    UrlFetchApp.fetch(url, options);
  } catch (e) {
    Logger.log('管理者通知失敗: ' + e.message);
  }
}
