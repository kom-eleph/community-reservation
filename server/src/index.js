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
