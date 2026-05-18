const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

// ── レート制限（管理API総当り防止）────────────────────────
const adminRateLimitMap = new Map();
function adminRateLimit(req, res, next) {
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15分
  const maxRequests = 60;

  const record = adminRateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count += 1;
  adminRateLimitMap.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      status: "error",
      message: "リクエストが多すぎます。しばらく待ってから再試行してください。",
    });
  }

  next();
}

// ── レート制限（公開API・スパム・スクレイピング防止）──────
const publicRateLimitMap = new Map();
function publicRateLimit(req, res, next) {
  // 管理者APIキーが付いているリクエストはレート制限をスキップ（動作確認用）
  const adminKey = req.headers["x-admin-api-key"];
  if (process.env.ADMIN_API_KEY && adminKey === process.env.ADMIN_API_KEY) {
    return next();
  }

  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15分
  const maxRequests = 60;

  const record = publicRateLimitMap.get(ip) || { count: 0, resetAt: now + windowMs };

  if (now > record.resetAt) {
    record.count = 0;
    record.resetAt = now + windowMs;
  }

  record.count += 1;
  publicRateLimitMap.set(ip, record);

  if (record.count > maxRequests) {
    return res.status(429).json({
      status: "error",
      message: "リクエストが多すぎます。しばらく時間をおいてから再試行してください。",
    });
  }

  next();
}

const app = express();
const prisma = new PrismaClient();

// nginxリバースプロキシ経由のため、X-Forwarded-ForからクライアントIPを取得
app.set("trust proxy", 1);

// ── rateLimitMap 定期クリーンアップ（メモリリーク防止）──
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of adminRateLimitMap.entries()) {
    if (now > record.resetAt) adminRateLimitMap.delete(ip);
  }
  for (const [ip, record] of publicRateLimitMap.entries()) {
    if (now > record.resetAt) publicRateLimitMap.delete(ip);
  }
}, 15 * 60 * 1000); // 15分ごとに実行

function verifyLineSignature(body, signature) {
  const channelSecret = process.env.LINE_CHANNEL_SECRET;

  if (!channelSecret || !signature) {
    return false;
  }

  const hash = crypto
    .createHmac("sha256", channelSecret)
    .update(body)
    .digest("base64");

  return crypto.timingSafeEqual(
    Buffer.from(hash),
    Buffer.from(signature)
  );
}

// ── LIFFアクセストークン検証（userIdのなりすまし防止）──
async function verifyLiffToken(liffToken, claimedUserId) {
  if (!liffToken) return false;
  try {
    const res = await fetch("https://api.line.me/v2/profile", {
      headers: { Authorization: `Bearer ${liffToken}` },
    });
    if (!res.ok) return false;
    const body = await res.json();
    return body.userId === claimedUserId;
  } catch (e) {
    console.error("[verifyLiffToken] error:", e.message);
    return false;
  }
}

async function pushLineMessage(lineUserId, text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!token) {
    console.warn("LINE_CHANNEL_ACCESS_TOKEN is not set. Skip push message.");
    return;
  }

  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [
        {
          type: "text",
          text,
        },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    console.error("LINE push failed:", response.status, body);
  }
}

async function pushLineMessages(lineUserId, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) {
    console.warn("LINE_CHANNEL_ACCESS_TOKEN is not set. Skip push message.");
    return;
  }
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ to: lineUserId, messages }),
  });
  if (!response.ok) {
    const body = await response.text();
    console.error("LINE push failed:", response.status, body);
  }
}

async function replyLineMessages(replyToken, messages) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ replyToken, messages }),
  });
}

function buildSurveyFlexMessage(q1, q2, responseId) {
  const surveyUrl = process.env.LIFF_SURVEY_URL || "";

  return {
    type: "flex",
    altText: "参加後アンケートです。よければ回答してください。",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        spacing: "md",
        paddingAll: "xl",
        contents: [
          { type: "text", text: "参加後アンケート", size: "xs", color: "#888780" },
          {
            type: "text",
            text: "今夜のことを\n少しだけ教えてください。",
            wrap: true,
            size: "md",
            color: "#1a1714",
            margin: "sm",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        paddingAll: "lg",
        contents: [
          {
            type: "button",
            style: "primary",
            color: "#1a1714",
            action: {
              type: "uri",
              label: "アンケートに答える",
              uri: `${surveyUrl}?rid=${responseId}`,
            },
          },
          {
            type: "text",
            text: "回答は任意です",
            size: "xxs",
            color: "#888780",
            align: "center",
            margin: "sm",
          },
        ],
      },
    },
  };
}

function formatScheduleText(schedule) {
  return [
    schedule.event.name,
    formatDateTimeForDisplay(schedule.startsAt),
    schedule.location ? `📍 ${schedule.location}` : "",
  ].filter(Boolean).join("\n");
}

// ── CORS：許可オリジンを明示的に制限 ────────────────────
const allowedOrigins = [
  "https://1dayx.jp",
  "https://www.1dayx.jp",
  "https://reservation.1dayx.jp",
  "https://kom-eleph.github.io",   // LIFF（予約フロント）
  ...(process.env.NODE_ENV !== "production"
    ? ["http://localhost:3000", "http://localhost:3001"]
    : []),
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("CORS: origin not allowed"));
    }
  },
  credentials: true,
}));

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "community-reservation-api",
  });
});

app.get("/api/events", async (req, res, next) => {
  try {
    const events = await prisma.event.findMany({
      where: { isActive: true },
      orderBy: { id: "asc" },
    });

    const result = events.map((event) => ({
      id: event.id,
      name: event.name,
      description: event.description,
      defaultCapacity: event.defaultCapacity,
      feeText: event.feeText,
      belongings: event.belongings,
      note: event.note,
    }));

    res.json({ status: "ok", events: result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/schedules", async (req, res, next) => {
  try {
    const { eventId, userId } = req.query;

    const schedules = await prisma.schedule.findMany({
      where: {
        ...(eventId ? { eventId } : {}),
        startsAt: {
          gte: new Date(),
        },
        // 非公開フラグが立っている日程はユーザーに見せない
        isHidden: false,
      },
      include: {
        event: true,
        reservations: {
          where: { status: "active" },
          select: { id: true, lineUserId: true },
        },
        waitlists: userId
          ? {
              where: {
                lineUserId: userId,
                status: "active",
              },
              select: { id: true },
            }
          : false,
      },
      orderBy: { startsAt: "asc" },
    });

    const result = schedules.map((schedule) => {
      const capacity =
        schedule.capacityOverride ?? schedule.event.defaultCapacity ?? 0;
      const reservedCount = schedule.reservations.length;
      const remaining = Math.max(capacity - reservedCount, 0);

      return {
        id: schedule.id,
        schedId: schedule.id,
        eventId: schedule.eventId,
        eventName: schedule.event.name,
        startsAt: schedule.startsAt,
        datetime: formatDateTimeForDisplay(schedule.startsAt),
        acceptStartAt: schedule.acceptStartAt,
        acceptEndAt: schedule.acceptEndAt,
        capacity,
        reservedCount,
        remaining,
        remainingCount: remaining,
        location: schedule.location || "",
        note: schedule.note || "",
        alreadyBooked: userId
          ? schedule.reservations.some((r) => r.lineUserId === userId)
          : false,
        onWaitlist: userId ? (schedule.waitlists?.length || 0) > 0 : false,
      };
    });

    res.json({ status: "ok", schedules: result });
  } catch (error) {
    next(error);
  }
});

app.get("/api/faqs", async (req, res, next) => {
  try {
    const faqs = await prisma.faq.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
    });

    res.json({ status: "ok", faqs });
  } catch (error) {
    next(error);
  }
});

function createReservationId() {
  const now = new Date();
  const ymd = now.toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `RSV-${ymd}-${rand}`;
}

async function createScheduleId(tx) {
  const latest = await tx.schedule.findMany({
    where: {
      id: {
        startsWith: "SCH-",
      },
    },
    orderBy: {
      id: "desc",
    },
    take: 1,
    select: {
      id: true,
    },
  });

  const latestId = latest[0]?.id || "SCH-000";
  const latestNumber = Number(latestId.replace("SCH-", ""));
  const nextNumber = Number.isFinite(latestNumber) ? latestNumber + 1 : 1;

  return `SCH-${String(nextNumber).padStart(3, "0")}`;
}

app.post("/api/reservations", publicRateLimit, async (req, res, next) => {
  try {
    const { userId, schedId, name, birthdate, gender, hasAllergy, carbonatedNg, allergyNote, consentedAt, liffToken } = req.body;

    if (!userId || !schedId || !name) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findUnique({
        where: { id: schedId },
        include: { event: true },
      });

      if (!schedule) {
        return {
          status: "error",
          message: "日程が見つかりません",
        };
      }

      const now = new Date();

      if (schedule.acceptEndAt && now > schedule.acceptEndAt) {
        return {
          status: "error",
          message: "受付は終了しました",
        };
      }

      await tx.user.upsert({
        where: { lineUserId: userId },
        update: {
          name,
          birthdate: birthdate ? new Date(birthdate) : null,
          gender: gender || null,
        },
        create: {
          lineUserId: userId,
          name,
          birthdate: birthdate ? new Date(birthdate) : null,
          gender: gender || null,
          registeredAt: now,
        },
      });

      const duplicate = await tx.reservation.findFirst({
        where: {
          lineUserId: userId,
          scheduleId: schedId,
          status: "active",
        },
      });

      if (duplicate) {
        return {
          status: "ok",
          reservationId: duplicate.id,
          message: "すでに予約済みです",
        };
      }

      const capacity =
        schedule.capacityOverride ?? schedule.event.defaultCapacity ?? 0;

      const activeCount = await tx.reservation.count({
        where: {
          scheduleId: schedId,
          status: "active",
        },
      });

      if (capacity > 0 && activeCount >= capacity) {
        return {
          status: "full",
          message: "満席です",
        };
      }

      const reservationId = createReservationId();

      await tx.reservation.create({
        data: {
          id: reservationId,
          lineUserId: userId,
          scheduleId: schedId,
          status: "active",
          reservedAt: now,
          hasAllergy:   hasAllergy   ?? null,
          carbonatedNg: carbonatedNg ?? null,
          allergyNote:  allergyNote  || null,
          consentedAt:  consentedAt ? new Date(consentedAt) : null,
        },
      });

      return {
        status: "ok",
        reservationId,
        notificationText: `予約が完了しました\n\n${formatScheduleText(schedule)}`,
      };
    });

    // d5: ユーザーへのPush通知を無償化対応のためコメントアウト（done画面に情報を直接表示）
    // if (result.status === "ok" && result.notificationText) {
    //   await pushLineMessage(userId, result.notificationText);
    // }
    delete result.notificationText;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function formatDateTimeForDisplay(date) {
  if (!date) return "";

  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

app.get("/api/my-reservations", publicRateLimit, async (req, res, next) => {
  try {
    const { userId } = req.query;
    const liffToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

    if (!userId) {
      return res.status(400).json({
        status: "error",
        message: "userIdが不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const reservations = await prisma.reservation.findMany({
      where: {
        lineUserId: userId,
        status: "active",
      },
      include: {
        schedule: {
          include: {
            event: true,
          },
        },
      },
      orderBy: {
        reservedAt: "desc",
      },
    });

    const result = reservations.map((r) => ({
      reservationId: r.id,
      eventId: r.schedule.eventId,
      eventName: r.schedule.event.name,
      schedId: r.scheduleId,
      datetime: formatDateTimeForDisplay(r.schedule.startsAt),
      location: r.schedule.location || "",
      reservedAt: r.reservedAt,
    }));

    res.json({
      status: "ok",
      reservations: result,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/reservations/:reservationId/cancel", publicRateLimit, async (req, res, next) => {
  try {
    const { reservationId } = req.params;
    const { userId, liffToken } = req.body;

    if (!reservationId || !userId) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: {
          schedule: {
            include: {
              event: true,
            },
          },
        },
      });

      if (!reservation) {
        return {
          status: "error",
          message: "予約が見つかりません",
        };
      }

      if (reservation.lineUserId !== userId) {
        return {
          status: "error",
          message: "この予約はキャンセルできません",
        };
      }

      if (reservation.status !== "active") {
        return {
          status: "error",
          message: "すでにキャンセル済みです",
        };
      }

      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
        },
      });

      return {
        status: "ok",
        notificationText: `予約をキャンセルしました\n\n${formatScheduleText(reservation.schedule)}`,
      };
    });

    // d7: ユーザーへのPush通知を無償化対応のためコメントアウト（done画面に情報を直接表示）
    // if (result.status === "ok" && result.notificationText) {
    //   await pushLineMessage(userId, result.notificationText);
    // }
    delete result.notificationText;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reservations/:reservationId/change", publicRateLimit, async (req, res, next) => {
  try {
    const { reservationId } = req.params;
    const { userId, newSchedId, name, birthdate, gender, hasAllergy, carbonatedNg, allergyNote, consentedAt, liffToken } = req.body;

    if (!reservationId || !userId || !newSchedId || !name) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const oldReservation = await tx.reservation.findUnique({
        where: { id: reservationId },
      });

      if (!oldReservation) {
        return {
          status: "error",
          message: "変更元の予約が見つかりません",
        };
      }

      if (oldReservation.lineUserId !== userId) {
        return {
          status: "error",
          message: "この予約は変更できません",
        };
      }

      if (oldReservation.status !== "active") {
        return {
          status: "error",
          message: "この予約は変更できません",
        };
      }

      if (oldReservation.scheduleId === newSchedId) {
        return {
          status: "ok",
          reservationId: oldReservation.id,
          message: "同じ日程です",
        };
      }

      const newSchedule = await tx.schedule.findUnique({
        where: { id: newSchedId },
        include: { event: true },
      });

      if (!newSchedule) {
        return {
          status: "error",
          message: "変更先の日程が見つかりません",
        };
      }

      const now = new Date();

      if (newSchedule.acceptEndAt && now > newSchedule.acceptEndAt) {
        return {
          status: "error",
          message: "受付は終了しました",
        };
      }

      await tx.user.upsert({
        where: { lineUserId: userId },
        update: {
          name,
          birthdate: birthdate ? new Date(birthdate) : null,
          gender: gender || null,
        },
        create: {
          lineUserId: userId,
          name,
          birthdate: birthdate ? new Date(birthdate) : null,
          gender: gender || null,
          registeredAt: now,
        },
      });

      const duplicate = await tx.reservation.findFirst({
        where: {
          lineUserId: userId,
          scheduleId: newSchedId,
          status: "active",
        },
      });

      if (duplicate) {
        return {
          status: "ok",
          reservationId: duplicate.id,
          message: "すでに予約済みの日程です",
        };
      }

      const capacity =
        newSchedule.capacityOverride ?? newSchedule.event.defaultCapacity ?? 0;

      const activeCount = await tx.reservation.count({
        where: {
          scheduleId: newSchedId,
          status: "active",
        },
      });

      if (capacity > 0 && activeCount >= capacity) {
        return {
          status: "full",
          message: "満席です",
        };
      }

      const newReservationId = createReservationId();

      await tx.reservation.update({
        where: { id: reservationId },
        data: {
          status: "modified",
          cancelledAt: now,
        },
      });

      await tx.reservation.create({
        data: {
          id: newReservationId,
          lineUserId: userId,
          scheduleId: newSchedId,
          status: "active",
          reservedAt: now,
          hasAllergy:   hasAllergy   ?? null,
          carbonatedNg: carbonatedNg ?? null,
          allergyNote:  allergyNote  || null,
          consentedAt:  consentedAt ? new Date(consentedAt) : null,
        },
      });

      return {
        status: "ok",
        reservationId: newReservationId,
        notificationText: `予約を変更しました\n\n${formatScheduleText(newSchedule)}`,
      };
    });

    // d6: ユーザーへのPush通知を無償化対応のためコメントアウト（done画面に情報を直接表示）
    // if (result.status === "ok" && result.notificationText) {
    //   await pushLineMessage(userId, result.notificationText);
    // }
    delete result.notificationText;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

function formatDateOnlyForInput(date) {
  if (!date) return "";

  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  return formatter.format(date);
}

app.get("/api/user-info", publicRateLimit, async (req, res, next) => {
  try {
    const { userId } = req.query;
    const liffToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");

    if (!userId) {
      return res.status(400).json({
        status: "error",
        message: "userIdが不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const user = await prisma.user.findUnique({
      where: { lineUserId: userId },
    });

    if (!user || !user.name) {
      return res.json({ status: "none" });
    }

    res.json({
      status: "found",
      name: user.name,
      birthdate: formatDateOnlyForInput(user.birthdate),
      gender: user.gender || "",
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/waitlist", publicRateLimit, async (req, res, next) => {
  try {
    const { userId, schedId, liffToken } = req.body;

    if (!userId || !schedId) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
    }

    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証に失敗しました" });
    }

    const result = await prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findUnique({
        where: { id: schedId },
      });

      if (!schedule) {
        return {
          status: "error",
          message: "日程が見つかりません",
        };
      }

      const existing = await tx.waitlist.findFirst({
        where: {
          lineUserId: userId,
          scheduleId: schedId,
          status: "active",
        },
      });

      if (existing) {
        return {
          status: "ok",
          message: "すでにキャンセル待ち登録済みです",
        };
      }

      await tx.waitlist.create({
        data: {
          lineUserId: userId,
          scheduleId: schedId,
          status: "active",
          registeredAt: new Date(),
        },
      });

      return { status: "ok" };
    });

    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/inquiries", publicRateLimit, async (req, res, next) => {
  try {
    const { userId, name, message } = req.body;

    if (!message || !String(message).trim()) {
      return res.status(400).json({
        status: "error",
        message: "お問い合わせ内容を入力してください",
      });
    }

    if (String(message).length > 1000) {
      return res.status(400).json({
        status: "error",
        message: "お問い合わせ内容は1000文字以内で入力してください",
      });
    }

    const inquiry = await prisma.inquiry.create({
      data: {
        lineUserId: userId || null,
        name: name || null,
        message: String(message).trim(),
        status: "open",
        receivedAt: new Date(),
      },
    });

    const adminUserId = process.env.ADMIN_LINE_USER_ID;

    if (adminUserId) {
      await pushLineMessage(
        adminUserId,
        [
          "📩 新しい問い合わせ",
          "",
          `名前: ${name || "未入力"}`,
          `LINE User ID: ${userId || "不明"}`,
          "",
          String(message).trim(),
        ].join("\n")
      );
    }

    // ユーザーへの自動返信Push: フロント側のtoastメッセージで代替済みのためコメントアウト
    // if (userId) {
    //   await pushLineMessage(
    //     userId,
    //     [
    //       "お問い合わせを受け付けました。",
    //       "",
    //       "内容：",
    //       String(message).trim(),
    //       "",
    //       "確認後、順次ご返信します。"
    //     ].join("\n")
    //   );
    // }

    res.json({
      status: "ok",
      inquiryId: inquiry.id,
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/webhook/line", async (req, res) => {
  try {
    const signature = req.headers["x-line-signature"];

    if (!verifyLineSignature(req.rawBody || "", signature)) {
      return res.status(401).json({ status: "error" });
    }

    const events = req.body.events || [];
    const inquiryUrl = process.env.LIFF_INQUIRY_URL;

    // リッチメニューの postback イベントは無視（自動応答しない）
    // テキストメッセージもリッチメニュー由来の定型文は無視する
    const RICH_MENU_POSTBACK_DATA = [
      "action=about",
      "about",
      "1dayx_about",
    ];
    const IGNORE_KEYWORDS = [
      "1 day xとは？",
      "1 day xとは",
      "1 day Xとは？",
      "1 day Xとは",
      "1dayx",
    ];

    for (const ev of events) {
      // postback: アンケート回答のみ処理、それ以外はリッチメニュー由来として無視
      if (ev.type === "postback") {
        const data = ev.postback?.data || "";
        if (data.startsWith("survey_")) {
          await handleSurveyPostback(ev);
        }
        continue;
      }

      if (ev.type === "message" && ev.message?.type === "text") {
        const text = (ev.message.text || "").trim();

        // リッチメニュー由来のテキストは無視
        const isIgnored = IGNORE_KEYWORDS.some(kw =>
          text.toLowerCase() === kw.toLowerCase()
        );
        if (isIgnored) continue;

        const replyToken = ev.replyToken;

        await fetch("https://api.line.me/v2/bot/message/reply", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
          },
          body: JSON.stringify({
            replyToken,
            messages: [
              {
                type: "text",
                text:
                  "お問い合わせは以下のフォームからお願いします。\n" +
                  inquiryUrl,
              },
            ],
          }),
        });
      }
    }

    res.json({ status: "ok" });
  } catch (e) {
    console.error(e);
    // LINEはWebhookに200以外が返ると再送を繰り返すため、エラー時も200を返す
    res.status(200).json({ status: "ok" });
  }
});

// ── 管理者認証ミドルウェア（全 /api/admin/* で共用）──────
function requireAdminKey(req, res, next) {
  const adminKey = req.headers["x-admin-api-key"];
  if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  next();
}

// ════════════════════════════════════════════════════════════
// 管理者 API（全ルート共通：adminRateLimit + requireAdminKey）
// ════════════════════════════════════════════════════════════

// ── 問い合わせ一覧 ────────────────────────────────────────
app.get("/api/admin/inquiries", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const inquiries = await prisma.inquiry.findMany({
      orderBy: { receivedAt: "desc" },
      take: 100,
    });
    res.json({ status: "ok", inquiries });
  } catch (error) {
    next(error);
  }
});

// ── 問い合わせ対応済み ────────────────────────────────────
app.post("/api/admin/inquiries/:id/close", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ status: "error", message: "Invalid inquiry id" });
    }
    const inquiry = await prisma.inquiry.update({
      where: { id },
      data: { status: "closed", closedAt: new Date() },
    });
    res.json({ status: "ok", inquiry });
  } catch (error) {
    next(error);
  }
});

// ── 予約一覧 ──────────────────────────────────────────────
app.get("/api/admin/reservations", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const reservations = await prisma.reservation.findMany({
      orderBy: { reservedAt: "desc" },
      take: 200,
      include: {
        user: true,
        schedule: { include: { event: true } },
      },
    });
    res.json({
      status: "ok",
      reservations: reservations.map((r) => ({
        reservationId: r.id,
        status: r.status,
        lineUserId: r.lineUserId,
        name: r.user?.name || "",
        birthdate: r.user?.birthdate ? r.user.birthdate.toISOString().slice(0, 10) : null,
        gender: r.user?.gender || null,
        eventName: r.schedule?.event?.name || "",
        eventId: r.schedule?.event?.id || "",
        scheduleId: r.scheduleId,
        startsAt: r.schedule?.startsAt || null,
        datetime: r.schedule ? formatDateTimeForDisplay(r.schedule.startsAt) : "",
        location: r.schedule?.location || "",
        reservedAt: r.reservedAt,
        cancelledAt: r.cancelledAt,
        hasAllergy: r.hasAllergy,
        carbonatedNg: r.carbonatedNg,
        allergyNote: r.allergyNote || "",
        consentedAt: r.consentedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ── 予約キャンセル（管理者） ──────────────────────────────
app.post("/api/admin/reservations/:id/cancel", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const reservationId = req.params.id;

    const result = await prisma.$transaction(async (tx) => {
      const reservation = await tx.reservation.findUnique({
        where: { id: reservationId },
        include: { schedule: { include: { event: true } } },
      });
      if (!reservation) return { status: "error", message: "予約が見つかりません" };
      if (reservation.status !== "active") return { status: "error", message: "この予約はすでに有効ではありません" };

      await tx.reservation.update({
        where: { id: reservationId },
        data: { status: "cancelled", cancelledAt: new Date() },
      });
      return {
        status: "ok",
        lineUserId: reservation.lineUserId,
        notificationText: `予約をキャンセルしました\n\n${formatScheduleText(reservation.schedule)}`,
      };
    });

    if (result.status === "ok" && result.lineUserId && result.notificationText) {
      await pushLineMessage(result.lineUserId, result.notificationText);
    }
    delete result.notificationText;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

// ── 日程一覧（管理者：非公開含む全件） ───────────────────
app.get("/api/admin/schedules", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const schedules = await prisma.schedule.findMany({
      orderBy: { startsAt: "asc" },
      include: {
        event: true,
        reservations: { where: { status: "active" }, select: { id: true } },
        waitlists: { where: { status: "active" }, select: { id: true } },
      },
    });

    const result = schedules.map((s) => {
      const capacity = s.capacityOverride ?? s.event.defaultCapacity ?? 0;
      const reservedCount = s.reservations.length;
      const waitlistCount = s.waitlists.length;
      return {
        id: s.id,
        eventId: s.eventId,
        eventName: s.event.name,
        startsAt: s.startsAt,
        datetime: formatDateTimeForDisplay(s.startsAt),
        acceptStartAt: s.acceptStartAt,
        acceptEndAt: s.acceptEndAt,
        capacity,
        reservedCount,
        waitlistCount,
        remainingCount: Math.max(capacity - reservedCount, 0),
        location: s.location || "",
        note: s.note || "",
        isHidden: s.isHidden ?? false,
        createdAt: s.createdAt,
      };
    });

    res.json({ status: "ok", schedules: result });
  } catch (error) {
    next(error);
  }
});

// ── 日程追加 ──────────────────────────────────────────────
app.post("/api/admin/schedules", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { eventId, startsAt, acceptStartAt, acceptEndAt, capacityOverride, location, note } = req.body;

    if (!eventId || !startsAt) {
      return res.status(400).json({ status: "error", message: "イベント、開催日時は必須です" });
    }

    const event = await prisma.event.findUnique({ where: { id: eventId } });
    if (!event) {
      return res.status(400).json({ status: "error", message: "イベントが見つかりません" });
    }

    const schedule = await prisma.$transaction(async (tx) => {
      const id = await createScheduleId(tx);
      return tx.schedule.create({
        data: {
          id,
          eventId,
          startsAt: new Date(startsAt),
          acceptStartAt: acceptStartAt ? new Date(acceptStartAt) : null,
          acceptEndAt: acceptEndAt ? new Date(acceptEndAt) : null,
          capacityOverride: capacityOverride === "" || capacityOverride == null ? null : Number(capacityOverride),
          location: location || null,
          note: note || null,
        },
      });
    });

    res.json({ status: "ok", schedule });
  } catch (error) {
    if (error.code === "P2002") {
      return res.status(400).json({ status: "error", message: "同じ日程IDがすでに存在します" });
    }
    next(error);
  }
});

// ── 日程マスタ編集 ────────────────────────────────────────
app.patch("/api/admin/schedules/:id", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { startsAt, acceptStartAt, acceptEndAt, capacityOverride, location, note } = req.body;

    const schedule = await prisma.schedule.findUnique({ where: { id } });
    if (!schedule) {
      return res.status(404).json({ status: "error", message: "日程が見つかりません" });
    }

    const updated = await prisma.schedule.update({
      where: { id },
      data: {
        ...(startsAt !== undefined && { startsAt: new Date(startsAt) }),
        ...(acceptStartAt !== undefined && { acceptStartAt: acceptStartAt ? new Date(acceptStartAt) : null }),
        ...(acceptEndAt !== undefined && { acceptEndAt: acceptEndAt ? new Date(acceptEndAt) : null }),
        ...(capacityOverride !== undefined && {
          capacityOverride: capacityOverride === "" || capacityOverride == null ? null : Number(capacityOverride),
        }),
        ...(location !== undefined && { location: location || null }),
        ...(note !== undefined && { note: note || null }),
      },
    });

    res.json({ status: "ok", schedule: updated });
  } catch (error) {
    next(error);
  }
});

// ── 日程非公開化（isHidden フラグ） ──────────────────────
app.post("/api/admin/schedules/:id/hide", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { notifyReservees = false } = req.body;

    const schedule = await prisma.schedule.findUnique({
      where: { id },
      include: {
        event: true,
        reservations: { where: { status: "active" }, select: { lineUserId: true } },
      },
    });

    if (!schedule) {
      return res.status(404).json({ status: "error", message: "日程が見つかりません" });
    }

    // isHidden フラグを true に設定して非公開化
    await prisma.schedule.update({
      where: { id },
      data: { isHidden: true },
    });

    let notifiedCount = 0;
    if (notifyReservees && schedule.reservations.length > 0) {
      const text = [
        "【重要】イベント中止のお知らせ",
        "",
        `${schedule.event.name}`,
        formatDateTimeForDisplay(schedule.startsAt),
        "",
        "上記イベントは中止となりました。ご迷惑をおかけして申し訳ございません。",
      ].join("\n");

      for (const r of schedule.reservations) {
        await pushLineMessage(r.lineUserId, text);
        notifiedCount++;
      }
    }

    res.json({ status: "ok", notifiedCount });
  } catch (error) {
    next(error);
  }
});

// ── ユーザー一覧 ──────────────────────────────────────────
app.get("/api/admin/users", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { registeredAt: "desc" },
      take: 300,
      select: {
        lineUserId: true,
        name: true,
        birthdate: true,
        gender: true,
        registeredAt: true,
      },
    });
    res.json({
      status: "ok",
      users: users.map((u) => ({
        ...u,
        birthdate: u.birthdate ? u.birthdate.toISOString().slice(0, 10) : null,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ── キャンセル待ち一覧 ────────────────────────────────────
app.get("/api/admin/waitlists", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const waitlists = await prisma.waitlist.findMany({
      orderBy: { registeredAt: "desc" },
      take: 200,
      include: {
        user: { select: { name: true } },
        schedule: { include: { event: true } },
      },
    });

    res.json({
      status: "ok",
      waitlists: waitlists.map((w) => ({
        id: w.id,
        lineUserId: w.lineUserId,
        name: w.user?.name || "",
        scheduleId: w.scheduleId,
        eventName: w.schedule?.event?.name || "",
        eventId: w.schedule?.event?.id || "",
        startsAt: w.schedule?.startsAt || null,
        datetime: w.schedule ? formatDateTimeForDisplay(w.schedule.startsAt) : "",
        location: w.schedule?.location || "",
        status: w.status,
        registeredAt: w.registeredAt,
        notifiedAt: w.notifiedAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

// ── アンケート：postback 処理 ────────────────────────────
async function handleSurveyPostback(ev) {
  const data = ev.postback?.data || "";
  const params = new URLSearchParams(data);
  const qNum = parseInt(params.get("survey_q"), 10);
  const answer = params.get("answer") || "";
  const rid = parseInt(params.get("rid"), 10);
  const replyToken = ev.replyToken;

  if (!rid || !qNum) return;

  try {
    const sr = await prisma.surveyResponse.findUnique({ where: { id: rid } });
    if (!sr) return;

    if (qNum === 1 && sr.currentStep === 1) {
      await prisma.surveyResponse.update({
        where: { id: rid },
        data: { answer1: answer, currentStep: 2 },
      });
      await replyLineMessages(replyToken, [
        { type: "text", text: "Q1 ありがとうございます。\nQ2 も回答いただけると嬉しいです。\n自由記述があればそのまま返信してください（任意）。" },
      ]);
    } else if (qNum === 2 && sr.currentStep === 2) {
      await prisma.surveyResponse.update({
        where: { id: rid },
        data: { answer2: answer, currentStep: 3, completedAt: new Date() },
      });
      await replyLineMessages(replyToken, [
        { type: "text", text: "回答ありがとうございました。\n自由記述があればそのまま返信してください（任意）。" },
      ]);
    }
  } catch (e) {
    console.error("handleSurveyPostback error:", e);
  }
}

// ── アンケート：自由記述テキスト処理 ─────────────────────
// ── アンケート：LIFF経由の回答一括保存 ──────────────────
// LIFF画面から Q1選択・Q2選択・自由記述をまとめて送信
app.post("/api/survey/answer", async (req, res, next) => {
  try {
    const { rid, answer1, answer2, freeText, liffToken, userId } = req.body;
    if (!rid || !liffToken || !userId) {
      return res.status(400).json({ status: "error", message: "必須パラメータが不足しています" });
    }
    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証エラー" });
    }
    const responseId = parseInt(rid, 10);
    const sr = await prisma.surveyResponse.findUnique({ where: { id: responseId } });
    if (!sr) return res.status(404).json({ status: "error", message: "回答セッションが見つかりません" });
    if (sr.lineUserId !== userId) {
      return res.status(403).json({ status: "error", message: "権限がありません" });
    }
    await prisma.surveyResponse.update({
      where: { id: responseId },
      data: {
        answer1: answer1 || null,
        answer2: answer2 || null,
        free1: freeText || null,
        currentStep: 3,
        completedAt: new Date(),
      },
    });
    res.json({ status: "ok" });
  } catch (e) { next(e); }
});

// ── アンケート：回答内容の取得（LIFF初期表示用）───────────
// 質問文・選択肢をLIFF画面に渡す
app.get("/api/survey/questions/:rid", async (req, res, next) => {
  try {
    const rid = parseInt(req.params.rid, 10);
    const liffToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    const userId = req.query.userId;
    if (!liffToken || !userId) {
      return res.status(401).json({ status: "error", message: "認証情報が不足しています" });
    }
    if (!await verifyLiffToken(liffToken, userId)) {
      return res.status(401).json({ status: "error", message: "認証エラー" });
    }
    const sr = await prisma.surveyResponse.findUnique({ where: { id: rid } });
    if (!sr || sr.lineUserId !== userId) {
      return res.status(404).json({ status: "error", message: "見つかりません" });
    }
    const [q1, q2] = await Promise.all([
      prisma.surveyQuestion.findUnique({ where: { id: sr.questionId1 } }),
      prisma.surveyQuestion.findUnique({ where: { id: sr.questionId2 } }),
    ]);
    res.json({
      status: "ok",
      alreadyAnswered: sr.currentStep >= 3,
      q1: q1 ? { id: q1.id, body: q1.body, options: JSON.parse(q1.options || "[]"), hasFree: q1.hasFree } : null,
      q2: q2 ? { id: q2.id, body: q2.body, options: JSON.parse(q2.options || "[]"), hasFree: q2.hasFree } : null,
    });
  } catch (e) { next(e); }
});

// ── 管理者API: 質問一覧取得 ──────────────────────────────
app.get("/api/admin/survey/questions", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const questions = await prisma.surveyQuestion.findMany({
      orderBy: [{ module: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
    });
    res.json({ status: "ok", questions });
  } catch (e) { next(e); }
});

// ── 管理者API: 質問追加 ──────────────────────────────────
app.post("/api/admin/survey/questions", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { module, body, options, hasFree, sortOrder } = req.body;
    if (!module || !body || !options || !Array.isArray(JSON.parse(options))) {
      return res.status(400).json({ status: "error", message: "module・body・optionsは必須です" });
    }
    const q = await prisma.surveyQuestion.create({
      data: {
        module,
        body,
        options,
        hasFree: hasFree !== false,
        sortOrder: sortOrder || 0,
      },
    });
    res.json({ status: "ok", question: q });
  } catch (e) { next(e); }
});

// ── 管理者API: 質問編集 ──────────────────────────────────
app.patch("/api/admin/survey/questions/:id", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { module, body, options, hasFree, isActive, sortOrder } = req.body;
    const data = {};
    if (module !== undefined) data.module = module;
    if (body !== undefined) data.body = body;
    if (options !== undefined) data.options = options;
    if (hasFree !== undefined) data.hasFree = hasFree;
    if (isActive !== undefined) data.isActive = isActive;
    if (sortOrder !== undefined) data.sortOrder = sortOrder;
    const q = await prisma.surveyQuestion.update({ where: { id }, data });
    res.json({ status: "ok", question: q });
  } catch (e) { next(e); }
});

// ── 管理者API: アンケート送信 ────────────────────────────
app.post("/api/admin/survey/send", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { scheduleId, module, lineUserIds } = req.body;
    if (!scheduleId || !module || !Array.isArray(lineUserIds) || lineUserIds.length === 0) {
      return res.status(400).json({ status: "error", message: "scheduleId・module・lineUserIdsは必須です" });
    }

    const activeQuestions = await prisma.surveyQuestion.findMany({
      where: { module, isActive: true },
    });
    if (activeQuestions.length < 2) {
      return res.status(400).json({ status: "error", message: `${module} の有効な質問が2問以上必要です` });
    }

    // Fisher-Yates でシャッフル後に先頭2問選出（ユーザーごとに同じ2問を送る）
    const shuffled = [...activeQuestions].sort(() => Math.random() - 0.5);
    const [q1, q2] = shuffled;

    let successCount = 0;
    const errors = [];

    for (const lineUserId of lineUserIds) {
      try {
        const sr = await prisma.surveyResponse.create({
          data: { lineUserId, scheduleId, questionId1: q1.id, questionId2: q2.id },
        });
        const flex = buildSurveyFlexMessage(q1, q2, sr.id);
        await pushLineMessages(lineUserId, [flex]);
        successCount++;
      } catch (e) {
        console.error(`Survey send failed for ${lineUserId}:`, e);
        errors.push(lineUserId);
      }
    }

    res.json({ status: "ok", successCount, errors });
  } catch (e) { next(e); }
});

// ── 管理者API: 回答一覧 ──────────────────────────────────
app.get("/api/admin/survey/responses", adminRateLimit, requireAdminKey, async (req, res, next) => {
  try {
    const { scheduleId } = req.query;
    const where = scheduleId ? { scheduleId } : {};
    const responses = await prisma.surveyResponse.findMany({
      where,
      orderBy: { sentAt: "desc" },
      take: 500,
    });

    const qIds = [...new Set([
      ...responses.map(r => r.questionId1),
      ...responses.map(r => r.questionId2),
    ])];
    const questions = await prisma.surveyQuestion.findMany({ where: { id: { in: qIds } } });
    const qMap = Object.fromEntries(questions.map(q => [q.id, q.body]));

    res.json({
      status: "ok",
      responses: responses.map(r => ({
        id: r.id,
        lineUserId: r.lineUserId,
        scheduleId: r.scheduleId,
        q1: qMap[r.questionId1] || "",
        q2: qMap[r.questionId2] || "",
        answer1: r.answer1,
        answer2: r.answer2,
        free1: r.free1,
        free2: r.free2,
        currentStep: r.currentStep,
        sentAt: r.sentAt,
        completedAt: r.completedAt,
      })),
    });
  } catch (e) { next(e); }
});


app.use((req, res) => {
  res.status(404).json({
    status: "error",
    message: "Not found",
  });
});

app.use((error, req, res, next) => {
  console.error(error);

  res.status(500).json({
    status: "error",
    message: "Internal server error",
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`API server running on port ${port}`);
});