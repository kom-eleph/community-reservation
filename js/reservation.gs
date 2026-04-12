// ============================================================
// reservation.gs
// ============================================================

function getAvailableEvents(userId) {
  const now      = new Date();
  const events   = getAllRows(SHEET.EVENT).filter(r => r[4] === true);
  const scheds   = getAllRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);

  const activeScheds = scheds.filter(
    s => now >= new Date(s[3]) && now <= new Date(s[4])
  );
  const activeIds = new Set(activeScheds.map(s => s[1]));

  return {
    events: events
      .filter(e => activeIds.has(e[0]))
      .map(e => {
        const eventScheds = activeScheds.filter(s => s[1] === e[0]);
        const allBooked   = userId
          ? eventScheds.every(s =>
              reserves.some(r => r[1] === userId && r[2] === s[0] && r[3] === '予約中')
            )
          : false;
        return {
          id:           e[0],
          name:         e[1],
          description:  e[2],
          capacity:     e[3],
          alreadyBooked: allBooked,
        };
      })
  };
}

function getSchedulesByEvent(eventId, userId) {
  const now      = new Date();
  const events   = getAllRows(SHEET.EVENT);
  const scheds   = getAllRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);
  const evtMap   = new Map(events.map(e => [e[0], e]));

  const available = scheds.filter(s =>
    s[1] === eventId &&
    now >= new Date(s[3]) &&
    now <= new Date(s[4])
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
        schedId:       s[0],
        datetime:      Utilities.formatDate(
          new Date(s[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm'
        ),
        location:      s[6],
        capacity:      capacity,
        remaining:     capacity - booked,
        alreadyBooked: alreadyBooked,
      };
    })
  };
}

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
        eventName:     evt?.[1]   || '',
        datetime:      sched ? Utilities.formatDate(
          new Date(sched[2]), 'Asia/Tokyo', 'M月d日(E) HH:mm'
        ) : '',
        location: sched?.[6] || '',
      };
    })
  };
}

function cancelReservationById(userId, reservationId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.RESERVE);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex(
      (r, i) => i > 0 &&
        r[0] === reservationId &&
        r[1] === userId &&
        r[3] === '予約中'
    );
    if (idx === -1) {
      return { status: 'error', message: '予約が見つかりません。' };
    }
    sheet.getRange(idx + 1, 4).setValue('キャンセル');
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

function processReservation(userId, schedId, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
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

    const sched    = scheds.find(s => s[0] === schedId);
    const capacity = sched[5] || evtMap.get(sched[1])?.[3] || 0;
    const booked   = reserves.filter(
      r => r[2] === schedId && r[3] === '予約中'
    ).length;
    if (booked >= capacity) {
      return { status: 'error', message: 'この日程は満席です。' };
    }

    const reservationId = generateId('RSV', SHEET.RESERVE);
    getSheet(SHEET.RESERVE).appendRow([
      reservationId, userId, schedId, '予約中', now()
    ]);

    return { status: 'ok', reservationId };
  } finally {
    lock.releaseLock();
  }
}

function registerUser(userId, name, age, gender) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet(SHEET.USER);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex((r, i) => i > 0 && r[0] === userId);
    if (idx > 0) {
      // 既存ユーザーは情報を更新
      sheet.getRange(idx + 1, 2, 1, 3).setValues([[name, age, gender]]);
    } else {
      sheet.appendRow([userId, name, age, gender, now()]);
    }
    return { status: 'ok' };
  } finally {
    lock.releaseLock();
  }
}

function getUserInfo(userId) {
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

function changeReservation(userId, oldReservationId, newSchedId, name) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getAllRows(SHEET.SCHED);
    const events   = getAllRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[0], e]));

    // 旧予約の存在確認
    const oldIdx = reserves.findIndex(
      r => r[0] === oldReservationId && r[1] === userId && r[3] === '予約中'
    );
    if (oldIdx === -1) {
      return { status: 'error', message: '変更元の予約が見つかりません。' };
    }

    // 新日程の重複チェック
    const duplicate = reserves.find(
      r => r[1] === userId && r[2] === newSchedId && r[3] === '予約中'
    );
    if (duplicate) {
      return { status: 'error', message: 'すでにこの日程に予約済みです。' };
    }

    // 新日程の定員チェック
    const sched    = scheds.find(s => s[0] === newSchedId);
    if (!sched) return { status: 'error', message: '日程が見つかりません。' };
    const capacity = sched[5] || evtMap.get(sched[1])?.[3] || 0;
    const booked   = reserves.filter(
      r => r[2] === newSchedId && r[3] === '予約中'
    ).length;
    if (booked >= capacity) {
      return { status: 'error', message: 'この日程は満席です。' };
    }

    // 新予約を登録
    const newReservationId = generateId('RSV', SHEET.RESERVE);
    getSheet(SHEET.RESERVE).appendRow([
      newReservationId, userId, newSchedId, '予約中', now()
    ]);

    // 旧予約をキャンセル（新予約成功後に実行）
    const sheet = getSheet(SHEET.RESERVE);
    sheet.getRange(oldIdx + 2, 4).setValue('変更済');

    return { status: 'ok', reservationId: newReservationId };

  } finally {
    lock.releaseLock();
  }
}

function getInitialData(userId) {
  const userInfo    = getUserInfo(userId);
  const eventsData  = getAvailableEvents(userId);
  const myRsvData   = getMyReservations(userId);
  return {
    status:       'ok',
    userInfo:     userInfo,
    events:       eventsData.events,
    reservations: myRsvData.reservations || [],
  };
}
