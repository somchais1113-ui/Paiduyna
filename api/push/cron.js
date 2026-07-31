// Endpoint สำหรับ scheduler ภายนอก (GitHub Actions) เรียกทุกประมาณ 5 นาที
// เหตุผลที่ไม่ใช้ Vercel Cron: แผน Hobby อนุญาตให้รันได้เพียงวันละครั้ง
import crypto from "node:crypto";
import { webpush, ensureConfigured, secondsUntil } from "../../lib/push.js";
import { getRedis, isRedisConfigured } from "../../lib/redis.js";

const REMIND_BEFORE_MS = 10 * 60 * 1000;
const MAX_LATE_AFTER_DEPART_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;

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
      const keys = await redis.keys("reminder:*");
      summary.checked = keys.length;

      for (const key of keys) {
        let item;
        try {
          item = parseReminder(await redis.get(key));
        } catch {
          item = null;
        }

        if (!item) {
          await redis.del(key);
          summary.cleaned++;
          continue;
        }

        const remindAt = item.departAt - REMIND_BEFORE_MS;
        if (now < remindAt) continue;

        if (now > item.departAt + MAX_LATE_AFTER_DEPART_MS) {
          await redis.del(key);
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
          await redis.del(key);
          summary.sent++;
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 410) {
            await redis.del(key);
            summary.expired++;
            continue;
          }

          const attempts = item.attempts + 1;
          summary.errors++;

          if (attempts >= MAX_ATTEMPTS || now >= item.departAt) {
            await redis.del(key);
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
    return res.status(502).json({
      status: "error",
      message: String(error?.message || error),
      ...summary
    });
  }
}
