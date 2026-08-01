// Endpoint สำหรับ scheduler ภายนอก (GitHub Actions) เรียกทุกประมาณ 5 นาที
// เหตุผลที่ไม่ใช้ Vercel Cron: แผน Hobby อนุญาตให้รันได้เพียงวันละครั้ง
import crypto from "node:crypto";
import { webpush, ensureConfigured, secondsUntil, REMINDER_INDEX_KEY } from "../../lib/push.js";
import { getRedis, isRedisConfigured } from "../../lib/redis.js";

const REMIND_BEFORE_MS = 10 * 60 * 1000;
const MAX_LATE_AFTER_DEPART_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
// จำนวนรายการสูงสุดต่อรอบ กันไม่ให้ Function ทำงานนานเกินเวลาที่แพลตฟอร์มกำหนด
const MAX_BATCH = 200;
// รายการในดัชนีที่เลยกำหนดนานกว่านี้ถือว่าไม่มีข้อมูลจริงแล้ว ลบทิ้งได้
const INDEX_STALE_MS = 24 * 60 * 60 * 1000;

/* ดึงเฉพาะรายการที่ถึงกำหนดแจ้งจากดัชนี Sorted Set
   เดิมใช้ redis.keys("reminder:*") ซึ่งอ่านทุก Key ทุกรอบ ต้นทุนโตตามจำนวนผู้ใช้
   ถ้าดัชนีว่าง (ข้อมูลเดิมจากเวอร์ชันก่อน) จะกวาดแบบเดิมหนึ่งครั้งแล้วเติมเข้าดัชนีให้ */
async function collectDueKeys(redis, now) {
  let due = [];
  try {
    due = await redis.zrange(REMINDER_INDEX_KEY, 0, now, { byScore: true });
  } catch (error) {
    console.error("reminder_index_read_failed", error?.message || error);
    due = [];
  }

  let indexed = 0;
  try {
    indexed = await redis.zcard(REMINDER_INDEX_KEY);
  } catch {
    indexed = due.length;
  }

  if (indexed === 0) {
    // เส้นทางสำรองสำหรับข้อมูลที่บันทึกไว้ก่อนมีดัชนี
    const legacy = await redis.keys("reminder:*");
    for (const key of legacy) {
      const parts = String(key).split(":");
      const departAt = Number(parts[parts.length - 1]);
      if (!Number.isFinite(departAt)) continue;
      await redis.zadd(REMINDER_INDEX_KEY, { score: departAt - REMIND_BEFORE_MS, member: key }).catch(() => {});
    }
    due = legacy.filter(key => {
      const departAt = Number(String(key).split(":").pop());
      return Number.isFinite(departAt) && now >= departAt - REMIND_BEFORE_MS;
    });
  }

  return (Array.isArray(due) ? due : []).map(String).slice(0, MAX_BATCH);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isAuthorized(req) {
  const secret = String(process.env.CRON_SECRET || "").trim();
  if (!secret) return false;

  const auth = String(req.headers?.authorization || "");
  const prefix = "Bearer ";
  if (!auth.startsWith(prefix)) return false;

  return safeEqual(auth.slice(prefix.length), secret);
}

// ลบทั้งข้อมูลและรายการในดัชนีพร้อมกันเสมอ เพื่อไม่ให้ทั้งสองฝั่งไม่ตรงกัน
async function dropReminder(redis, key) {
  await redis.del(key);
  await redis.zrem(REMINDER_INDEX_KEY, key).catch(() => {});
}

function parseReminder(raw) {
  if (!raw) return null;
  const item = typeof raw === "string" ? JSON.parse(raw) : raw;

  if (!item || !Number.isFinite(Number(item.departAt)) || !item.subscription) {
    return null;
  }

  return {
    ...item,
    departAt: Number(item.departAt),
    attempts: Number(item.attempts) || 0
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  if (!String(process.env.CRON_SECRET || "").trim()) {
    return res.status(503).json({
      status: "error",
      code: "cron_secret_not_configured",
      message: "ยังไม่ได้ตั้งค่า CRON_SECRET"
    });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  if (!ensureConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "push_not_configured",
      message: "ยังไม่ได้ตั้งค่า VAPID keys"
    });
  }
  if (!isRedisConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "redis_not_configured",
      message: "ยังไม่ได้เชื่อม Upstash Redis หรือกำหนด Redis environment variables"
    });
  }

  const now = Date.now();
  const summary = {
    checked: 0,
    sent: 0,
    expired: 0,
    cleaned: 0,
    retrying: 0,
    errors: 0
  };

  try {
    const redis = getRedis();
    const lockKey = "lock:push-reminder-cron";
    const lockToken = crypto.randomUUID();
    const acquired = await redis.set(lockKey, lockToken, { nx: true, ex: 240 });

    if (!acquired) {
      return res.status(200).json({
        status: "ok",
        skipped: "already_running",
        now: new Date(now).toISOString(),
        ...summary
      });
    }

    try {
      // ลบรายการค้างในดัชนีที่เก่ามากก่อน เพื่อไม่ให้ดัชนีบวมสะสม
      await redis.zremrangebyscore(REMINDER_INDEX_KEY, 0, now - INDEX_STALE_MS).catch(() => {});

      const keys = await collectDueKeys(redis, now);
      summary.checked = keys.length;

      for (const key of keys) {
        let item;
        try {
          item = parseReminder(await redis.get(key));
        } catch {
          item = null;
        }

        if (!item) {
          await dropReminder(redis, key);
          summary.cleaned++;
          continue;
        }

        const remindAt = item.departAt - REMIND_BEFORE_MS;
        if (now < remindAt) continue;

        if (now > item.departAt + MAX_LATE_AFTER_DEPART_MS) {
          await dropReminder(redis, key);
          summary.cleaned++;
          continue;
        }

        const serviceName = item.arl ? "Airport Rail Link" : "ขบวน " + item.trainNo;
        const payload = JSON.stringify({
          title: "รถไฟจะออกในอีกประมาณ 10 นาที",
          body: serviceName +
            (item.from ? " · ออกจาก " + item.from : "") +
            (item.to ? " → " + item.to : ""),
          tag: "train-" + item.trainNo
        });

        try {
          await webpush.sendNotification(item.subscription, payload);
          await dropReminder(redis, key);
          summary.sent++;
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await dropReminder(redis, key);
            summary.expired++;
            continue;
          }

          const attempts = item.attempts + 1;
          summary.errors++;

          if (attempts >= MAX_ATTEMPTS || now >= item.departAt) {
            await dropReminder(redis, key);
            summary.cleaned++;
            continue;
          }

          await redis.set(
            key,
            JSON.stringify({ ...item, attempts, lastErrorAt: now }),
            { ex: secondsUntil(item.departAt, 3600) }
          );
          summary.retrying++;
        }
      }

      return res.status(200).json({
        status: "ok",
        now: new Date(now).toISOString(),
        ...summary
      });
    } finally {
      // ลบ lock เฉพาะเมื่อยังเป็น lock ของ invocation นี้ ป้องกันลบ lock ของรอบใหม่
      try {
        const currentLock = await redis.get(lockKey);
        if (currentLock === lockToken) await redis.del(lockKey);
      } catch {
        // lock มี TTL 4 นาที จึงหายเองได้แม้ลบไม่สำเร็จ
      }
    }
  } catch (error) {
    console.error("push_cron_error", error?.message || error);
    return res.status(502).json({
      status: "error",
      message: "ประมวลผลคิวแจ้งเตือนไม่สำเร็จ",
      ...summary
    });
  }
}
