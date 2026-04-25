// ============================================================
// reservation.gs  予約・イベント・ユーザー管理
// ============================================================

// ── 入力サニタイズヘルパー ────────────────────────────────
// 文字列をトリムし最大長を超えていないか確認する
function sanitizeString(value, maxLen) {
  if (value === null || value === undefined) return '';
  const s = String(value).trim();
  return s.slice(0, maxLen);
}

// ── イベント一覧取得 ──────────────────────────────────────
function getAvailableEvents(userId) {
  const nowDate  = new Date();
  // イベント・日程マスタは CacheService でリクエスト間キャッシュ
  const events   = getMasterCachedRows(SHEET.EVENT).filter(r => r[COL_EVENT.IS_ACTIVE] === true);
  const scheds   = getMasterCachedRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);

  // ACCEPT_START/END を一度だけパース（ループ外で変換）
  const schedsWithDate = scheds.map(s => ({
    s,
    start: new Date(s[COL_SCHED.ACCEPT_START]),
    end:   new Date(s[COL_SCHED.ACCEPT_END]),
  }));
  const activeScheds = schedsWithDate
    .filter(({ start, end }) => nowDate >= start && nowDate <= end)
    .map(({ s }) => s);
  const activeIds = new Set(activeScheds.map(s => s[COL_SCHED.EVENT_ID]));

  // ユーザーの有効予約 schedId セットを一度だけ構築（O(1) 参照）
  const userActiveSchedIds = userId
    ? new Set(
        reserves
          .filter(r => r[COL_RESERVE.USER_ID] === userId &&
                       r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE)
          .map(r => r[COL_RESERVE.SCHED_ID])
      )
    : new Set();

  return {
    events: events
      .filter(e => activeIds.has(e[COL_EVENT.ID]))
      .map(e => {
        const eventScheds   = activeScheds.filter(s => s[COL_SCHED.EVENT_ID] === e[COL_EVENT.ID]);
        const alreadyBooked = userId &&
          eventScheds.length > 0 &&
          eventScheds.every(s => userActiveSchedIds.has(s[COL_SCHED.ID]));
        return {
          id:          e[COL_EVENT.ID],
          name:        e[COL_EVENT.NAME],
          description: e[COL_EVENT.DESCRIPTION],
          capacity:    e[COL_EVENT.CAPACITY],
          alreadyBooked: !!alreadyBooked,
        };
      })
  };
}

// ── 日程一覧取得 ──────────────────────────────────────────
function getSchedulesByEvent(eventId, userId) {
  const nowDate  = new Date();
  // イベント・日程マスタは CacheService でリクエスト間キャッシュ
  const events   = getMasterCachedRows(SHEET.EVENT);
  const scheds   = getMasterCachedRows(SHEET.SCHED);
  const reserves = getAllRows(SHEET.RESERVE);
  const waitlist = getAllRows(SHEET.WAITLIST);
  const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));

  // ACCEPT_START/END を一度だけパースしてフィルタ（ループ内で毎回 new Date() しない）
  const available = scheds.filter(s => {
    if (s[COL_SCHED.EVENT_ID] !== eventId) return false;
    const start = new Date(s[COL_SCHED.ACCEPT_START]);
    const end   = new Date(s[COL_SCHED.ACCEPT_END]);
    return nowDate >= start && nowDate <= end;
  });

  // ループ前に Map を構築して O(n) → O(1) に改善
  // bookedMap: schedId → 有効予約数
  const bookedMap = new Map();
  // userBookedSet: ユーザーが予約済みの schedId セット
  const userBookedSet = new Set();
  // userWaitSet: ユーザーがキャンセル待ちの schedId セット
  const userWaitSet = new Set();

  for (const r of reserves) {
    if (r[COL_RESERVE.STATUS] !== RESERVE_STATUS.ACTIVE) continue;
    const sid = r[COL_RESERVE.SCHED_ID];
    bookedMap.set(sid, (bookedMap.get(sid) || 0) + 1);
    if (userId && r[COL_RESERVE.USER_ID] === userId) userBookedSet.add(sid);
  }
  if (userId) {
    for (const w of waitlist) {
      if (w[COL_WAITLIST.USER_ID] === userId &&
          w[COL_WAITLIST.STATUS]  === WAITLIST_STATUS.WAITING) {
        userWaitSet.add(w[COL_WAITLIST.SCHED_ID]);
      }
    }
  }

  return {
    schedules: available.map(s => {
      const sid      = s[COL_SCHED.ID];
      const capacity = resolveCapacity(s, evtMap);
      const booked   = bookedMap.get(sid) || 0;
      return {
        schedId:      sid,
        datetime:     formatDatetime(s[COL_SCHED.DATETIME]),
        location:     s[COL_SCHED.LOCATION],
        capacity,
        remaining:    capacity - booked,
        alreadyBooked: userBookedSet.has(sid),
        onWaitlist:    userWaitSet.has(sid),
      };
    })
  };
}

// ── 自分の予約一覧 ────────────────────────────────────────
function getMyReservations(userId) {
  const reserves = getAllRows(SHEET.RESERVE);
  const scheds   = getMasterCachedRows(SHEET.SCHED);
  const events   = getMasterCachedRows(SHEET.EVENT);
  const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));
  const schedMap = new Map(scheds.map(s => [s[COL_SCHED.ID], s]));

  const active = reserves.filter(r =>
    r[COL_RESERVE.USER_ID] === userId &&
    r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE
  );

  if (active.length === 0) return { status: USER_STATUS.NONE, reservations: [] };

  return {
    status: USER_STATUS.FOUND,
    reservations: active.map(r => {
      const sched = schedMap.get(r[COL_RESERVE.SCHED_ID]);
      const evt   = evtMap.get(sched?.[COL_SCHED.EVENT_ID]);
      return {
        reservationId: r[COL_RESERVE.ID],
        schedId:       r[COL_RESERVE.SCHED_ID],
        eventId:       sched?.[COL_SCHED.EVENT_ID] || '',
        eventName:     evt?.[COL_EVENT.NAME]        || '(不明なイベント)',
        datetime:      sched ? formatDatetime(sched[COL_SCHED.DATETIME]) : '',
        location:      sched?.[COL_SCHED.LOCATION]  || '',
      };
    })
  };
}

// ── キャンセル処理 ────────────────────────────────────────
function cancelReservationById(userId, reservationId) {
  if (!userId || !reservationId) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }

  // 通知用情報をロック取得前に読む（書き込み範囲を最小化）
  const scheds   = getMasterCachedRows(SHEET.SCHED);
  const events   = getMasterCachedRows(SHEET.EVENT);
  const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));
  const userInfo = getUserInfo(userId);
  const userName = userInfo.status === USER_STATUS.FOUND ? userInfo.name : '不明';

  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const sheet = getSheet(SHEET.RESERVE);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex((r, i) =>
      i > 0 &&
      r[COL_RESERVE.ID]      === reservationId &&
      r[COL_RESERVE.USER_ID] === userId &&
      r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE
    );
    if (idx === -1) {
      return { status: API_STATUS.ERROR, message: '予約が見つかりません。' };
    }

    const schedId = rows[idx][COL_RESERVE.SCHED_ID];
    sheet.getRange(idx + 1, COL_RESERVE.STATUS       + 1).setValue(RESERVE_STATUS.CANCELLED);
    sheet.getRange(idx + 1, COL_RESERVE.CANCELLED_AT + 1).setValue(now());
    invalidateRowCache(SHEET.RESERVE);

    const sched   = scheds.find(s => s[COL_SCHED.ID] === schedId);
    const evtName = evtMap.get(sched?.[COL_SCHED.EVENT_ID])?.[COL_EVENT.NAME] || '';
    const dt      = sched ? formatDatetime(sched[COL_SCHED.DATETIME]) : '';

    notifyUserOnCancel(userId, evtName, dt, reservationId);
    notifyAdminOnCancel(reservationId, userName);

    // ロック内でキャンセル待ち昇格まで完結させ二重通知を防ぐ
    // 事前に読んだ scheds/evtMap を渡して二重読み込みを回避
    promoteWaitlist(schedId, scheds, evtMap);

    return { status: API_STATUS.OK };
  } finally {
    lock.releaseLock();
  }
}

// ── 予約処理（内部共通） ──────────────────────────────────
function processReservation(userId, schedId, name) {
  if (!userId || !schedId) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getMasterCachedRows(SHEET.SCHED);
    const events   = getMasterCachedRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));

    const duplicate = reserves.find(r =>
      r[COL_RESERVE.USER_ID]  === userId &&
      r[COL_RESERVE.SCHED_ID] === schedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    );
    if (duplicate) {
      return { status: API_STATUS.ERROR, message: 'すでにこの日程に予約済みです。' };
    }

    const sched = scheds.find(s => s[COL_SCHED.ID] === schedId);
    if (!sched) return { status: API_STATUS.ERROR, message: '日程が見つかりません。' };

    const capacity = resolveCapacity(sched, evtMap);
    const booked   = reserves.filter(r =>
      r[COL_RESERVE.SCHED_ID] === schedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    ).length;
    if (booked >= capacity) {
      return { status: API_STATUS.FULL, message: 'この日程は満席です。キャンセル待ちに登録しますか？' };
    }

    const reservationId = generateUniqueId('RSV');
    getSheet(SHEET.RESERVE).appendRow([
      reservationId, userId, schedId, RESERVE_STATUS.ACTIVE, now(), '',
    ]);
    // 書き込み後は RESERVE の行データキャッシュを無効化
    invalidateRowCache(SHEET.RESERVE);

    const evtName = evtMap.get(sched[COL_SCHED.EVENT_ID])?.[COL_EVENT.NAME] || '';
    const dt      = formatDatetime(sched[COL_SCHED.DATETIME]);
    const loc     = sched[COL_SCHED.LOCATION] || '';
    notifyUserOnReserve(userId, evtName, dt, loc, reservationId);

    return { status: API_STATUS.OK, reservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── 参加者情報登録＋予約を一本化 ─────────────────────────
// ロックを1回だけ取得してユーザー登録と予約を完結させる。
// registerUser + processReservation を逐次呼ぶとロックを2回取得することになり、
// 前日集中時に後続リクエストがロック待機でタイムアウトする可能性があるため、
// 1つのロック内で両処理をまとめている。
function reserveWithAttendee(userId, schedId, name, birthdate, gender) {
  // ── バリデーション（ロック取得前に実施）────────────────
  const cleanName = sanitizeString(name, 30);
  if (!cleanName) return { status: API_STATUS.ERROR, message: 'お名前を入力してください。' };

  const bdError = validateBirthdate(birthdate);
  if (bdError) return { status: API_STATUS.ERROR, message: bdError };

  const allowedGenders = ['男性', '女性', 'その他', '未回答'];
  if (!allowedGenders.includes(gender)) {
    return { status: API_STATUS.ERROR, message: '性別の値が不正です。' };
  }
  if (!userId || !schedId) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }

  // ── 1つのロック内でユーザー登録 + 予約を完結 ──────────
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    // ① ユーザー情報を登録/更新
    upsertUser(userId, cleanName, birthdate, gender);

    // ② 重複・満席チェックと予約登録
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getMasterCachedRows(SHEET.SCHED);
    const events   = getMasterCachedRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));

    if (reserves.some(r =>
      r[COL_RESERVE.USER_ID]  === userId &&
      r[COL_RESERVE.SCHED_ID] === schedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    )) {
      return { status: API_STATUS.ERROR, message: 'すでにこの日程に予約済みです。' };
    }

    const sched = scheds.find(s => s[COL_SCHED.ID] === schedId);
    if (!sched) return { status: API_STATUS.ERROR, message: '日程が見つかりません。' };

    const capacity = resolveCapacity(sched, evtMap);
    const booked   = reserves.filter(r =>
      r[COL_RESERVE.SCHED_ID] === schedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    ).length;
    if (booked >= capacity) {
      return { status: API_STATUS.FULL, message: 'この日程は満席です。キャンセル待ちに登録しますか？' };
    }

    const reservationId = generateUniqueId('RSV');
    getSheet(SHEET.RESERVE).appendRow([
      reservationId, userId, schedId, RESERVE_STATUS.ACTIVE, now(), '',
    ]);
    invalidateRowCache(SHEET.RESERVE);

    const evtName = evtMap.get(sched[COL_SCHED.EVENT_ID])?.[COL_EVENT.NAME] || '';
    const dt      = formatDatetime(sched[COL_SCHED.DATETIME]);
    const loc     = sched[COL_SCHED.LOCATION] || '';
    notifyUserOnReserve(userId, evtName, dt, loc, reservationId);

    return { status: API_STATUS.OK, reservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── 参加者情報登録＋日程変更を一本化 ─────────────────────
// reserveWithAttendee と同様に1つのロック内で完結させる。
function changeWithAttendee(userId, oldReservationId, newSchedId, name, birthdate, gender) {
  // ── バリデーション（ロック取得前）────────────────────
  const cleanName = sanitizeString(name, 30);
  if (!cleanName) return { status: API_STATUS.ERROR, message: 'お名前を入力してください。' };

  const bdError = validateBirthdate(birthdate);
  if (bdError) return { status: API_STATUS.ERROR, message: bdError };

  const allowedGenders = ['男性', '女性', 'その他', '未回答'];
  if (!allowedGenders.includes(gender)) {
    return { status: API_STATUS.ERROR, message: '性別の値が不正です。' };
  }
  if (!userId || !oldReservationId || !newSchedId) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }

  // ── 1つのロック内でユーザー登録 + 日程変更を完結 ───────
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    // ① ユーザー情報を登録/更新
    upsertUser(userId, cleanName, birthdate, gender);

    // ② 変更元予約の確認
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getMasterCachedRows(SHEET.SCHED);
    const events   = getMasterCachedRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));

    const oldIdx = reserves.findIndex(r =>
      r[COL_RESERVE.ID]      === oldReservationId &&
      r[COL_RESERVE.USER_ID] === userId &&
      r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE
    );
    if (oldIdx === -1) {
      return { status: API_STATUS.ERROR, message: '変更元の予約が見つかりません。' };
    }

    if (reserves.some(r =>
      r[COL_RESERVE.USER_ID]  === userId &&
      r[COL_RESERVE.SCHED_ID] === newSchedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    )) {
      return { status: API_STATUS.ERROR, message: 'すでにこの日程に予約済みです。' };
    }

    const sched = scheds.find(s => s[COL_SCHED.ID] === newSchedId);
    if (!sched) return { status: API_STATUS.ERROR, message: '日程が見つかりません。' };

    const capacity = resolveCapacity(sched, evtMap);
    const booked   = reserves.filter(r =>
      r[COL_RESERVE.SCHED_ID] === newSchedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    ).length;
    if (booked >= capacity) {
      return { status: API_STATUS.FULL, message: 'この日程は満席です。キャンセル待ちに登録しますか？' };
    }

    const oldSchedId       = reserves[oldIdx][COL_RESERVE.SCHED_ID];
    const newReservationId = generateUniqueId('RSV');

    getSheet(SHEET.RESERVE).appendRow([
      newReservationId, userId, newSchedId, RESERVE_STATUS.ACTIVE, now(), '',
    ]);
    getSheet(SHEET.RESERVE).getRange(oldIdx + 2, COL_RESERVE.STATUS + 1)
      .setValue(RESERVE_STATUS.CHANGED);
    invalidateRowCache(SHEET.RESERVE);

    const evtName = evtMap.get(sched[COL_SCHED.EVENT_ID])?.[COL_EVENT.NAME] || '';
    const dt      = formatDatetime(sched[COL_SCHED.DATETIME]);
    const loc     = sched[COL_SCHED.LOCATION] || '';
    notifyUserOnChange(userId, evtName, dt, loc, newReservationId);

    promoteWaitlist(oldSchedId, scheds, evtMap);

    return { status: API_STATUS.OK, reservationId: newReservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── ユーザー情報の Upsert（ロックなし・呼び出し元がロック取得済みの場合に使用）──
// reserveWithAttendee / changeWithAttendee のロック内から呼ばれる。
// 呼び出し元がすでにロックを保持しているため、ここではロックを取得しない。
function upsertUser(userId, name, birthdate, gender) {
  const sheet = getSheet(SHEET.USER);
  const rows  = sheet.getDataRange().getValues();
  const idx   = rows.findIndex((r, i) => i > 0 && r[COL_USER.ID] === userId);
  if (idx > 0) {
    sheet.getRange(idx + 1, COL_USER.NAME + 1, 1, 3).setValues([[name, birthdate, gender]]);
  } else {
    sheet.appendRow([userId, name, birthdate, gender, now()]);
  }
  invalidateRowCache(SHEET.USER);
}

// ── ユーザー登録（内部共通・ロック付き）─────────────────
// 単体で呼ばれる場合（getUserInfo アクション等）はこちらを使う。
// birthdate: 'YYYY-MM-DD' 形式の文字列
function registerUser(userId, name, birthdate, gender) {
  if (!userId || !name || !birthdate || !gender) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }

  const bdError = validateBirthdate(birthdate);
  if (bdError) return { status: API_STATUS.ERROR, message: bdError };

  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const sheet = getSheet(SHEET.USER);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex((r, i) => i > 0 && r[COL_USER.ID] === userId);
    if (idx > 0) {
      sheet.getRange(idx + 1, COL_USER.NAME + 1, 1, 3).setValues([[name, birthdate, gender]]);
    } else {
      sheet.appendRow([userId, name, birthdate, gender, now()]);
    }
    invalidateRowCache(SHEET.USER);
    return { status: API_STATUS.OK };
  } finally {
    lock.releaseLock();
  }
}

// ── 生年月日バリデーション ────────────────────────────────
// 返値: エラーメッセージ文字列 or null（正常）
function validateBirthdate(birthdate) {
  if (!birthdate || !/^\d{4}-\d{2}-\d{2}$/.test(String(birthdate))) {
    return '生年月日の形式が正しくありません（YYYY-MM-DD）。';
  }
  const bd = new Date(birthdate);
  if (isNaN(bd.getTime())) return '存在しない日付です。';

  const today   = new Date();
  const ageMs   = today - bd;
  const ageYear = ageMs / (1000 * 60 * 60 * 24 * 365.25);

  if (bd > today)                      return '生年月日に未来の日付は指定できません。';
  if (ageYear < BIRTHDATE_MIN_YEARS)   return '生年月日が正しくありません。';
  if (ageYear > BIRTHDATE_MAX_YEARS)   return '生年月日が正しくありません。';
  return null;
}

// ── ユーザー情報取得 ──────────────────────────────────────
// ── 生年月日を YYYY-MM-DD 文字列に正規化するヘルパー ─────
// スプレッドシートのセルが Date オブジェクトで返る場合も正しく変換する
function formatBirthdate(value) {
  if (!value) return '';
  // すでに YYYY-MM-DD 形式の文字列ならそのまま返す
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  // Date オブジェクト、または ISO 文字列の場合はタイムゾーンを考慮して変換
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  // JST (UTC+9) で日付を取得
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  const y   = jst.getUTCFullYear();
  const m   = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(jst.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function getUserInfo(userId) {
  if (!userId) return { status: USER_STATUS.NONE };
  const idx = findRowIndex(SHEET.USER, COL_USER.ID, userId);
  if (idx === -1) return { status: USER_STATUS.NONE };
  const row = getAllRows(SHEET.USER)[idx];
  return {
    status:    USER_STATUS.FOUND,
    name:      row[COL_USER.NAME],
    birthdate: formatBirthdate(row[COL_USER.BIRTHDATE]),
    gender:    row[COL_USER.GENDER],
  };
}

// ── 日程変更 ──────────────────────────────────────────────
function changeReservation(userId, oldReservationId, newSchedId, name) {
  if (!userId || !oldReservationId || !newSchedId) {
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const reserves = getAllRows(SHEET.RESERVE);
    const scheds   = getMasterCachedRows(SHEET.SCHED);
    const events   = getMasterCachedRows(SHEET.EVENT);
    const evtMap   = new Map(events.map(e => [e[COL_EVENT.ID], e]));

    const oldIdx = reserves.findIndex(r =>
      r[COL_RESERVE.ID]      === oldReservationId &&
      r[COL_RESERVE.USER_ID] === userId &&
      r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE
    );
    if (oldIdx === -1) {
      return { status: API_STATUS.ERROR, message: '変更元の予約が見つかりません。' };
    }

    const duplicate = reserves.find(r =>
      r[COL_RESERVE.USER_ID]  === userId &&
      r[COL_RESERVE.SCHED_ID] === newSchedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    );
    if (duplicate) {
      return { status: API_STATUS.ERROR, message: 'すでにこの日程に予約済みです。' };
    }

    const sched = scheds.find(s => s[COL_SCHED.ID] === newSchedId);
    if (!sched) return { status: API_STATUS.ERROR, message: '日程が見つかりません。' };

    const capacity = resolveCapacity(sched, evtMap);
    const booked   = reserves.filter(r =>
      r[COL_RESERVE.SCHED_ID] === newSchedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    ).length;
    if (booked >= capacity) {
      return { status: API_STATUS.FULL, message: 'この日程は満席です。キャンセル待ちに登録しますか？' };
    }

    const oldSchedId       = reserves[oldIdx][COL_RESERVE.SCHED_ID];
    const newReservationId = generateUniqueId('RSV');

    getSheet(SHEET.RESERVE).appendRow([
      newReservationId, userId, newSchedId, RESERVE_STATUS.ACTIVE, now(), '',
    ]);
    getSheet(SHEET.RESERVE).getRange(oldIdx + 2, COL_RESERVE.STATUS + 1)
      .setValue(RESERVE_STATUS.CHANGED);
    invalidateRowCache(SHEET.RESERVE);

    const evtName = evtMap.get(sched[COL_SCHED.EVENT_ID])?.[COL_EVENT.NAME] || '';
    const dt      = formatDatetime(sched[COL_SCHED.DATETIME]);
    const loc     = sched[COL_SCHED.LOCATION] || '';
    notifyUserOnChange(userId, evtName, dt, loc, newReservationId);

    // ロック内でキャンセル待ち昇格まで完結
    promoteWaitlist(oldSchedId, scheds, evtMap);

    return { status: API_STATUS.OK, reservationId: newReservationId };
  } finally {
    lock.releaseLock();
  }
}

// ── 起動時の軽量データ取得（分割読み込み版） ─────────────
// 読むシート: イベント・日程・予約・ユーザー の4枚
// 読まない:   予約一覧用の schedMap 結合は getMyReservations に委譲
//
// mode=myrsv の場合は events を返さず予約一覧のみを返す。
// フロント側は起動直後に必要なデータだけ受け取り、
// 予約一覧は「予約確認」タップ時に getMyReservations で遅延取得する。
// [SEC-3] getBootData は速度維持のため認証不要のまま据え置く。
// 代わりに個人情報（名前・生年月日・性別）を返さない設計とし情報漏洩を防ぐ。
// userInfo はフォーム表示時にフロントが getUserInfo（認証必須）で遅延取得する。
// mode=myrsv（予約一覧）は個人の予約情報を含むため getMyReservations（認証必須）
// 経由に変更し、getBootData からは返さない。
function getBootData(userId, mode) {
  if (!userId) return { status: API_STATUS.ERROR, message: 'userIdが必要です。' };

  // ── ユーザー登録有無フラグのみ返す（個人情報は含めない）──────
  // 名前・生年月日・性別は認証必須の getUserInfo で取得すること。
  const allUsers   = getAllRows(SHEET.USER);
  const userRow    = allUsers.find(r => r[COL_USER.ID] === userId);
  const userStatus = userRow ? USER_STATUS.FOUND : USER_STATUS.NONE;

  // mode=myrsv: 予約一覧は認証必須の getMyReservations で取得するよう案内
  // getBootData からは返さない（個人の予約情報を認証なしで返さないため）
  if (mode === 'myrsv') {
    return {
      status:       API_STATUS.OK,
      userInfo:     { status: userStatus },
      events:       [],
      reservations: [],  // フロントは別途 getMyReservations（認証済み）で取得
    };
  }

  // 通常起動: イベント一覧のみ返す（予約一覧シートを読まない）
  // イベント・日程マスタは CacheService でリクエスト間キャッシュ
  const allEvents   = getMasterCachedRows(SHEET.EVENT);
  const allScheds   = getMasterCachedRows(SHEET.SCHED);
  const allReserves = getAllRows(SHEET.RESERVE);

  const nowDate = new Date();
  // ACCEPT_START/END を一度だけパースしてフィルタ
  const activeScheds = allScheds.filter(s => {
    const start = new Date(s[COL_SCHED.ACCEPT_START]);
    const end   = new Date(s[COL_SCHED.ACCEPT_END]);
    return nowDate >= start && nowDate <= end;
  });
  const activeIds = new Set(activeScheds.map(s => s[COL_SCHED.EVENT_ID]));

  // alreadyBooked 判定用: ユーザーの有効予約 schedId セット
  const userActiveSchedIds = new Set(
    allReserves
      .filter(r => r[COL_RESERVE.USER_ID] === userId &&
                   r[COL_RESERVE.STATUS]  === RESERVE_STATUS.ACTIVE)
      .map(r => r[COL_RESERVE.SCHED_ID])
  );

  const events = allEvents
    .filter(e => e[COL_EVENT.IS_ACTIVE] === true && activeIds.has(e[COL_EVENT.ID]))
    .map(e => {
      const eventScheds   = activeScheds.filter(s => s[COL_SCHED.EVENT_ID] === e[COL_EVENT.ID]);
      const alreadyBooked = eventScheds.length > 0 &&
        eventScheds.every(s => userActiveSchedIds.has(s[COL_SCHED.ID]));
      return {
        id:          e[COL_EVENT.ID],
        name:        e[COL_EVENT.NAME],
        description: e[COL_EVENT.DESCRIPTION],
        capacity:    e[COL_EVENT.CAPACITY],
        alreadyBooked,
      };
    });

  return {
    status:       API_STATUS.OK,
    userInfo:     { status: userStatus },  // 個人情報は含めない
    events,
    reservations: [],  // 通常起動では返さない。必要時に getMyReservations で取得。
  };
}

// 後方互換: getInitialData は getBootData に委譲
function getInitialData(userId) {
  return getBootData(userId, 'normal');
}

// ── イベント属性統計（管理者用） ──────────────────────────
function getEventStats(eventId) {
  const reserves = getAllRows(SHEET.RESERVE);
  const scheds   = getMasterCachedRows(SHEET.SCHED);
  const users    = getAllRows(SHEET.USER);
  const events   = getMasterCachedRows(SHEET.EVENT);

  const targetSchedIds = scheds
    .filter(s => !eventId || s[COL_SCHED.EVENT_ID] === eventId)
    .map(s => s[COL_SCHED.ID]);

  const targetReserves = reserves.filter(r =>
    targetSchedIds.includes(r[COL_RESERVE.SCHED_ID]) &&
    (r[COL_RESERVE.STATUS] === RESERVE_STATUS.ACTIVE ||
     r[COL_RESERVE.STATUS] === RESERVE_STATUS.CHANGED)
  );

  const userMap     = new Map(users.map(u => [u[COL_USER.ID], u]));
  const genderCount = {};
  const ageGroups   = { '10代': 0, '20代': 0, '30代': 0, '40代': 0, '50代以上': 0, '不明': 0 };

  targetReserves.forEach(r => {
    const user = userMap.get(r[COL_RESERVE.USER_ID]);
    if (!user) return;

    const gender = user[COL_USER.GENDER] || '不明';
    genderCount[gender] = (genderCount[gender] || 0) + 1;

    // 生年月日から現在の年齢を算出
    const bd  = new Date(user[COL_USER.BIRTHDATE]);
    const age = isNaN(bd.getTime())
      ? NaN
      : Math.floor((new Date() - bd) / (1000 * 60 * 60 * 24 * 365.25));

    if      (isNaN(age)) ageGroups['不明']++;
    else if (age < 20)   ageGroups['10代']++;
    else if (age < 30)   ageGroups['20代']++;
    else if (age < 40)   ageGroups['30代']++;
    else if (age < 50)   ageGroups['40代']++;
    else                 ageGroups['50代以上']++;
  });

  const eventName = events.find(e => e[COL_EVENT.ID] === eventId)?.[COL_EVENT.NAME] || '全イベント';

  return {
    status:        API_STATUS.OK,
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
    return { status: API_STATUS.ERROR, message: '必要なパラメータが不足しています。' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    const sheet = getSheet(SHEET.WAITLIST);
    const rows  = sheet.getDataRange().getValues();
    const already = rows.some((r, i) =>
      i > 0 &&
      r[COL_WAITLIST.USER_ID]  === userId &&
      r[COL_WAITLIST.SCHED_ID] === schedId &&
      r[COL_WAITLIST.STATUS]   === WAITLIST_STATUS.WAITING
    );
    if (already) return { status: API_STATUS.ERROR, message: 'すでにキャンセル待ちに登録済みです。' };
    sheet.appendRow([userId, schedId, WAITLIST_STATUS.WAITING, now(), '']);
    invalidateRowCache(SHEET.WAITLIST);
    return { status: API_STATUS.OK };
  } finally {
    lock.releaseLock();
  }
}

// ── キャンセル待ち自動昇格 ────────────────────────────────
// cancel/changeReservation のロック内から呼ばれるため、
// ここではロックを取得しない（再取得するとデッドロックになる）。
// 呼び出し元がすでに読み込んだ scheds/evtMap を渡すことで
// 二重シート読み込みを回避する。
function promoteWaitlist(schedId, scheds, evtMap) {
  if (!schedId) return;
  try {
    // 渡されなかった場合は自前で読む（後方互換）
    if (!scheds) scheds = getMasterCachedRows(SHEET.SCHED);
    if (!evtMap) {
      const events = getMasterCachedRows(SHEET.EVENT);
      evtMap = new Map(events.map(e => [e[COL_EVENT.ID], e]));
    }

    const sched = scheds.find(s => s[COL_SCHED.ID] === schedId);
    if (!sched) return;

    // 残席を再確認（コミット後の値を読む）
    const reserves = getAllRows(SHEET.RESERVE);
    const capacity = resolveCapacity(sched, evtMap);
    const booked   = reserves.filter(r =>
      r[COL_RESERVE.SCHED_ID] === schedId &&
      r[COL_RESERVE.STATUS]   === RESERVE_STATUS.ACTIVE
    ).length;

    if (booked >= capacity) {
      debugLog('[promoteWaitlist] 残席なし schedId=' + schedId + ' booked=' + booked + '/' + capacity);
      return;
    }

    const sheet = getSheet(SHEET.WAITLIST);
    const rows  = sheet.getDataRange().getValues();
    const idx   = rows.findIndex((r, i) =>
      i > 0 &&
      r[COL_WAITLIST.SCHED_ID] === schedId &&
      r[COL_WAITLIST.STATUS]   === WAITLIST_STATUS.WAITING
    );
    if (idx === -1) return;

    const waitUserId = rows[idx][COL_WAITLIST.USER_ID];
    sheet.getRange(idx + 1, COL_WAITLIST.STATUS      + 1).setValue(WAITLIST_STATUS.NOTIFIED);
    sheet.getRange(idx + 1, COL_WAITLIST.NOTIFIED_AT + 1).setValue(now());
    invalidateRowCache(SHEET.WAITLIST);

    const dt = formatDatetime(sched[COL_SCHED.DATETIME]);
    pushMessage(waitUserId,
      '【キャンセル空き通知】\n空きが出ました！\n\n' +
      '📅 ' + dt + '\n\n' +
      'お早めにメニューの「予約する」からお申し込みください🙏\n' +
      '（先着順のため、他の方が先に予約された場合はご了承ください）'
    );
    debugLog('[promoteWaitlist] 通知送信 userId=' + waitUserId + ' schedId=' + schedId);
  } catch (e) {
    Logger.log('[promoteWaitlist] エラー: ' + e.message);
  }
}

// ── 予約完了ユーザー通知 ─────────────────────────────────
function notifyUserOnReserve(userId, evtName, dt, loc, reservationId) {
  if (!userId) return;
  try {
    pushMessage(userId,
      '【予約完了】\n予約が完了しました✅\n\n' +
      '📌 ' + evtName + '\n' +
      '📅 ' + dt + '\n' +
      '📍 ' + loc + '\n\n' +
      '予約ID: ' + reservationId + '\n\n' +
      '変更・キャンセルはメニューの「予約確認」からどうぞ。'
    );
  } catch (e) {
    Logger.log('[notifyUserOnReserve] エラー: ' + e.message);
  }
}

// ── 日程変更完了ユーザー通知 ─────────────────────────────
function notifyUserOnChange(userId, evtName, dt, loc, reservationId) {
  if (!userId) return;
  try {
    pushMessage(userId,
      '【日程変更完了】\n日程変更が完了しました🔄\n\n' +
      '📌 ' + evtName + '\n' +
      '📅 ' + dt + '（新しい日程）\n' +
      '📍 ' + loc + '\n\n' +
      '予約ID: ' + reservationId
    );
  } catch (e) {
    Logger.log('[notifyUserOnChange] エラー: ' + e.message);
  }
}

// ── キャンセル完了ユーザー通知 ─────────────────────────
function notifyUserOnCancel(userId, evtName, dt, reservationId) {
  if (!userId) return;
  try {
    pushMessage(userId,
      '【キャンセル完了】\nキャンセルが完了しました🗑️\n\n' +
      '📌 ' + evtName + '\n' +
      '📅 ' + dt + '\n\n' +
      'またのご参加をお待ちしています。'
    );
  } catch (e) {
    Logger.log('[notifyUserOnCancel] エラー: ' + e.message);
  }
}

// ── 管理者へのキャンセル通知 ─────────────────────────────
function notifyAdminOnCancel(reservationId, userName) {
  if (typeof ADMIN_LINE_USER_ID === 'undefined' || !ADMIN_LINE_USER_ID) return;
  try {
    pushMessage(ADMIN_LINE_USER_ID,
      `【キャンセル通知】\n予約ID: ${reservationId}\nキャンセル者: ${userName}`
    );
  } catch (e) {
    Logger.log('管理者通知失敗: ' + e.message);
  }
}

// ── 定員解決ヘルパー ──────────────────────────────────────
function resolveCapacity(sched, evtMap) {
  const individual = sched[COL_SCHED.CAPACITY];
  if (individual !== null && individual !== '' && individual !== undefined) {
    return Number(individual);
  }
  return evtMap.get(sched[COL_SCHED.EVENT_ID])?.[COL_EVENT.CAPACITY] ?? 0;
}