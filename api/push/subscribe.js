// สมัครรับแจ้งเตือนขบวนล่วงหน้า 10 นาที ผ่าน Push (ทำงานได้แม้ปิดแอป)
// - เก็บ Subscription + ข้อมูลขบวนลง Vercel KV มี TTL หมดอายุอัตโนมัติ ไม่ต้องลบเอง
// - Cron (api/push/cron.js) จะมาไล่เช็คทุก 5 นาทีและส่ง Push ให้เมื่อถึงเวลา
import { kv } from "@vercel/kv";
import { ensureConfigured, hashEndpoint, secondsUntil } from "../../lib/push.js";

const REMIND_BEFORE_MS = 10 * 60 * 1000; // แจ้งเตือนล่วงหน้า 10 นาทีก่อนออก
const MAX_FUTURE_MS = 48 * 60 * 60 * 1000; // ไม่รับสมัครเกิน 48 ชั่วโมงล่วงหน้า กันข้อมูลขยะ
const MAX_TEXT_LEN = 120;

const clean = s => String(s || "").trim().slice(0, MAX_TEXT_LEN);

function validSubscription(sub){
  return sub && typeof sub.endpoint === "string" && sub.endpoint.startsWith("https://")
    && sub.keys && typeof sub.keys.p256dh === "string" && sub.keys.p256dh
    && typeof sub.keys.auth === "string" && sub.keys.auth;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  if (!ensureConfigured()) {
    return res.status(503).json({ status: "error", code: "push_not_configured", message: "ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY" });
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
  if (!clean(trainNo)) {
    return res.status(400).json({ status: "error", message: "ต้องระบุเลขขบวน" });
  }

  try {
    const hash = hashEndpoint(subscription.endpoint);
    const key = `reminder:${hash}:${clean(trainNo)}:${dep}`;
    const value = {
      subscription,
      trainNo: clean(trainNo),
      departAt: dep,
      from: clean(from),
      to: clean(to),
      arl: Boolean(arl),
      createdAt: now
    };
    // หมดอายุอัตโนมัติ 1 ชั่วโมงหลังขบวนออก กันข้อมูลค้างถ้า cron พลาดจังหวะ
    await kv.set(key, JSON.stringify(value), { ex: secondsUntil(dep, 3600) });

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "ok", remindInMinutes: Math.round((remindAt - now) / 60000) });
  } catch (error) {
    return res.status(502).json({ status: "error", message: "บันทึกการสมัครไม่สำเร็จ: " + String(error?.message || error) });
  }
}
