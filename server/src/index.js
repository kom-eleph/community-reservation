const express = require("express");
const cors = require("cors");
const { PrismaClient } = require("@prisma/client");
require("dotenv").config();

const app = express();
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

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

    res.json({ status: "ok", events });
  } catch (error) {
    next(error);
  }
});

app.get("/api/schedules", async (req, res, next) => {
  try {
    const schedules = await prisma.schedule.findMany({
      include: {
        event: true,
        reservations: {
          where: { status: "active" },
          select: { id: true },
        },
      },
      orderBy: { startsAt: "asc" },
    });

    const result = schedules.map((schedule) => {
      const capacity =
        schedule.capacityOverride ?? schedule.event.defaultCapacity ?? 0;

      return {
        id: schedule.id,
        eventId: schedule.eventId,
        eventName: schedule.event.name,
        startsAt: schedule.startsAt,
        acceptStartAt: schedule.acceptStartAt,
        acceptEndAt: schedule.acceptEndAt,
        capacity,
        reservedCount: schedule.reservations.length,
        remainingCount: Math.max(capacity - schedule.reservations.length, 0),
        location: schedule.location,
        note: schedule.note,
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
      };
    });

    res.json(result);
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
