const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

function findCsvFile(keyword) {
  const dir = path.join(__dirname, "imports");
  const files = fs.readdirSync(dir);
  const file = files.find((name) => name.includes(keyword) && name.endsWith(".csv"));

  if (!file) {
    throw new Error(`CSV file not found: ${keyword}`);
  }

  return path.join(dir, file);
}

function readCsv(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return parse(raw, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
}

function parseJstDate(value) {
  if (!value) return null;

  const normalized = value.replace(/\//g, "-");
  return new Date(`${normalized}+09:00`);
}

function parseBoolean(value) {
  return ["TRUE", "true", "1", "有効", "○"].includes(String(value || "").trim());
}

(async () => {
  try {
    const eventsCsv = path.join(__dirname, "imports", "event_master.csv");
    const schedulesCsv = path.join(__dirname, "imports", "schedule_master.csv");

    const events = readCsv(eventsCsv);
    const schedules = readCsv(schedulesCsv);

    console.log("events:", events.length);
    console.log("schedules:", schedules.length);

    for (const e of events) {
      await prisma.event.upsert({
        where: { id: e["イベントID"] },
        update: {
          name: e["イベント名"],
          description: e["説明"] || null,
          defaultCapacity: Number(e["定員"]) || null,
          isActive: parseBoolean(e["有効フラグ"]),
          feeText: e["参加費"] || null,
          belongings: e["持ち物"] || null,
          note: e["補足"] || null,
        },
        create: {
          id: e["イベントID"],
          name: e["イベント名"],
          description: e["説明"] || null,
          defaultCapacity: Number(e["定員"]) || null,
          isActive: parseBoolean(e["有効フラグ"]),
          feeText: e["参加費"] || null,
          belongings: e["持ち物"] || null,
          note: e["補足"] || null,
        },
      });
    }

    for (const s of schedules) {
      await prisma.schedule.upsert({
        where: { id: s["日程ID"] },
        update: {
          eventId: s["イベントID"],
          startsAt: parseJstDate(s["開催日時"]),
          acceptStartAt: parseJstDate(s["受付開始日時"]),
          acceptEndAt: parseJstDate(s["受付終了日時"]),
          capacityOverride: s["定員上書き"] ? Number(s["定員上書き"]) : null,
          location: s["場所"] || null,
          note: s["備考"] || null,
        },
        create: {
          id: s["日程ID"],
          eventId: s["イベントID"],
          startsAt: parseJstDate(s["開催日時"]),
          acceptStartAt: parseJstDate(s["受付開始日時"]),
          acceptEndAt: parseJstDate(s["受付終了日時"]),
          capacityOverride: s["定員上書き"] ? Number(s["定員上書き"]) : null,
          location: s["場所"] || null,
          note: s["備考"] || null,
        },
      });
    }

    console.log("IMPORT DONE");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
