// สมัครรับแจ้งเตือนขบวนล่วงหน้า 10 นาที ผ่าน Push (ทำงานได้แม้ปิดแอป)
// - เก็บ Subscription + ข้อมูลขบวนลง Upstash Redis พร้อม TTL
// - GitHub Actions จะเรียก api/push/cron.js ทุกประมาณ 5 นาทีเพื่อส่ง Push เมื่อถึงเวลา
import { ensureConfigured, hashEndpoint, secondsUntil } from "../../lib/push.js";
import { getRedis, isRedisConfigured } from "../../lib/redis.js";

const REMIND_BEFORE_MS = 10 * 60 * 1000;
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000;
const MAX_TEXT_LEN = 120;

const clean = value => String(value || "").trim().slice(0, MAX_TEXT_LEN);

function validSubscription(sub) {
  return Boolean(
    sub &&
    typeof sub.endpoint === "string" &&
    sub.endpoint.startsWith("https://") &&
    sub.keys &&
    typeof sub.keys.p256dh === "string" &&
    sub.keys.p256dh &&
    typeof sub.keys.auth === "string" &&
    sub.keys.auth
  );
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  if (!ensureConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "push_not_configured",
      message: "ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY"
    });
  }
  if (!isRedisConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "redis_not_configured",
      message: "ยังไม่ได้เชื่อม Upstash Redis หรือกำหนด Redis environment variables"
    });
  }

  const body = req.body || {};
  const { subscription, trainNo, departAt, from, to, arl } = body;

  if (!validSubscription(subscription)) {
    return res.status(400).json({ status: "error", message: "ข้อมูล Subscription ไม่ถูกต้อง" });
  }

  const dep = Number(departAt);
  if (!Number.isFinite(dep)) {
    return res.status(400).json({ status: "error", message: "ต้องระบุเวลาออกเดินทาง (departAt)" });
  }

  const now = Date.now();
  const remindAt = dep - REMIND_BEFORE_MS;
  if (remindAt <= now) {
    return res.status(400).json({ status: "error", message: "ใกล้เวลาออกเกินไปแล้ว หรือขบวนออกไปแล้ว" });
  }
  if (dep - now > MAX_FUTURE_MS) {
    return res.status(400).json({ status: "error", message: "รับสมัครล่วงหน้าได้ไม่เกิน 48 ชั่วโมง" });
  }

  const cleanTrainNo = clean(trainNo);
  if (!cleanTrainNo) {
    return res.status(400).json({ status: "error", message: "ต้องระบุเลขขบวน" });
  }

  try {
    const redis = getRedis();
    const hash = hashEndpoint(subscription.endpoint);
    const key = `reminder:${hash}:${cleanTrainNo}:${dep}`;
    const value = {
      subscription,
      trainNo: cleanTrainNo,
      departAt: dep,
      from: clean(from),
      to: clean(to),
      arl: Boolean(arl),
      attempts: 0,
      createdAt: now
    };

    // หมดอายุอัตโนมัติ 1 ชั่วโมงหลังขบวนออก เผื่อ scheduler ล่าช้าชั่วคราว
    await redis.set(key, JSON.stringify(value), { ex: secondsUntil(dep, 3600) });

    return res.status(200).json({
      status: "ok",
      remindInMinutes: Math.round((remindAt - now) / 60000)
    });
  } catch (error) {
    return res.status(502).json({
      status: "error",
      message: "บันทึกการสมัครไม่สำเร็จ: " + String(error?.message || error)
    });
  }
}
