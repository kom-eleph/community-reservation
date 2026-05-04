const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const app = express();
const prisma = new PrismaClient();

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

function formatScheduleText(schedule) {
  return [
    schedule.event.name,
    formatDateTimeForDisplay(schedule.startsAt),
    schedule.location ? `📍 ${schedule.location}` : "",
  ].filter(Boolean).join("\n");
}

app.use(cors());
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

app.post("/api/reservations", async (req, res, next) => {
  try {
    const { userId, schedId, name, birthdate, gender } = req.body;

    if (!userId || !schedId || !name) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
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

      if (schedule.acceptStartAt && now < schedule.acceptStartAt) {
        return {
          status: "error",
          message: "受付開始前です",
        };
      }

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
        },
      });

      return {
        status: "ok",
        reservationId,
        notificationText: `予約が完了しました\n\n${formatScheduleText(schedule)}`,
      };
    });

    if (result.status === "ok" && result.notificationText) {
      await pushLineMessage(userId, result.notificationText);
    }
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

app.get("/api/my-reservations", async (req, res, next) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        status: "error",
        message: "userIdが不足しています",
      });
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

app.post("/api/reservations/:reservationId/cancel", async (req, res, next) => {
  try {
    const { reservationId } = req.params;
    const { userId } = req.body;

    if (!reservationId || !userId) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
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

    if (result.status === "ok" && result.notificationText) {
      await pushLineMessage(userId, result.notificationText);
    }
    delete result.notificationText;
    res.json(result);
  } catch (error) {
    next(error);
  }
});

app.post("/api/reservations/:reservationId/change", async (req, res, next) => {
  try {
    const { reservationId } = req.params;
    const { userId, newSchedId, name, birthdate, gender } = req.body;

    if (!reservationId || !userId || !newSchedId || !name) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
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

      if (newSchedule.acceptStartAt && now < newSchedule.acceptStartAt) {
        return {
          status: "error",
          message: "受付開始前です",
        };
      }

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
        },
      });

      return {
        status: "ok",
        reservationId: newReservationId,
        notificationText: `予約を変更しました\n\n${formatScheduleText(newSchedule)}`,
      };
    });

    if (result.status === "ok" && result.notificationText) {
      await pushLineMessage(userId, result.notificationText);
    }
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

app.get("/api/user-info", async (req, res, next) => {
  try {
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({
        status: "error",
        message: "userIdが不足しています",
      });
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

app.post("/api/waitlist", async (req, res, next) => {
  try {
    const { userId, schedId } = req.body;

    if (!userId || !schedId) {
      return res.status(400).json({
        status: "error",
        message: "必須項目が不足しています",
      });
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

app.post("/api/inquiries", async (req, res, next) => {
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

    if (userId) {
      await pushLineMessage(
        userId,
        [
          "お問い合わせを受け付けました。",
          "",
          "内容：",
          String(message).trim(),
          "",
          "確認後、順次ご返信します。"
        ].join("\n")
      );
    }

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

    for (const ev of events) {
      if (ev.type === "message" && ev.message?.type === "text") {
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
    res.json({ status: "error" });
  }
});

app.get("/api/admin/inquiries", async (req, res, next) => {
  try {
    const adminKey = req.headers["x-admin-api-key"];

    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const inquiries = await prisma.inquiry.findMany({
      orderBy: { receivedAt: "desc" },
      take: 100,
    });

    res.json({
      status: "ok",
      inquiries,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/admin/reservations", async (req, res, next) => {
  try {
    const adminKey = req.headers["x-admin-api-key"];

    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const reservations = await prisma.reservation.findMany({
      orderBy: { reservedAt: "desc" },
      take: 200,
      include: {
        user: true,
        schedule: {
          include: {
            event: true,
          },
        },
      },
    });

    res.json({
      status: "ok",
      reservations: reservations.map((r) => ({
        reservationId: r.id,
        status: r.status,
        lineUserId: r.lineUserId,
        name: r.user?.name || "",
        eventName: r.schedule?.event?.name || "",
        scheduleId: r.scheduleId,
        datetime: r.schedule ? formatDateTimeForDisplay(r.schedule.startsAt) : "",
        location: r.schedule?.location || "",
        reservedAt: r.reservedAt,
        cancelledAt: r.cancelledAt,
      })),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/admin/reservations/:id/cancel", async (req, res, next) => {
  try {
    const adminKey = req.headers["x-admin-api-key"];

    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const reservationId = req.params.id;

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

      if (reservation.status !== "active") {
        return {
          status: "error",
          message: "この予約はすでに有効ではありません",
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

app.post("/api/admin/inquiries/:id/close", async (req, res, next) => {
  try {
    const adminKey = req.headers["x-admin-api-key"];

    if (!process.env.ADMIN_API_KEY || adminKey !== process.env.ADMIN_API_KEY) {
      return res.status(401).json({
        status: "error",
        message: "Unauthorized",
      });
    }

    const id = Number(req.params.id);

    if (!Number.isInteger(id)) {
      return res.status(400).json({
        status: "error",
        message: "Invalid inquiry id",
      });
    }

    const inquiry = await prisma.inquiry.update({
      where: { id },
      data: {
        status: "closed",
        closedAt: new Date(),
      },
    });

    res.json({
      status: "ok",
      inquiry,
    });
  } catch (error) {
    next(error);
  }
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
