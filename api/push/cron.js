// เรียกโดย Vercel Cron ทุก 5 นาที ไล่เช็คว่าถึงเวลาแจ้งเตือนขบวนไหนแล้วส่ง Push
// ป้องกันการเรียกจากภายนอก ด้วยการเทียบ Authorization Header ที่ Vercel Cron แนบมาอัตโนมัติ
// เมื่อตั้งค่า Environment Variable ชื่อ CRON_SECRET ไว้ (ดูวิธีตั้งค่าใน README)
import { kv } from "@vercel/kv";
import { webpush, ensureConfigured } from "../../lib/push.js";

const GRACE_AFTER_DEPART_MS = 60 * 60 * 1000; // เกินออกไป 1 ชั่วโมงแล้วยังไม่ส่ง ให้ทิ้งแทนแจ้งเตือนย้อนหลัง

function isAuthorized(req){
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // ยังไม่ตั้ง secret: อนุญาตไว้ก่อน (แนะนำให้ตั้งค่าจริงก่อนใช้งานจริง)
  const auth = req.headers?.authorization || "";
  return auth === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ status: "error", message: "Unauthorized" });
  }
  if (!ensureConfigured()) {
    return res.status(503).json({ status: "error", code: "push_not_configured", message: "ยังไม่ได้ตั้งค่า VAPID keys" });
  }

  const now = Date.now();
  const summary = { checked: 0, sent: 0, expired: 0, cleaned: 0, errors: 0 };

  try {
    const keys = await kv.keys("reminder:*");
    summary.checked = keys.length;

    for (const key of keys) {
      let raw;
      try { raw = await kv.get(key); } catch { continue; }
      if (!raw) continue;
      let item;
      try { item = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { await kv.del(key); summary.cleaned++; continue; }

      const remindAt = item.departAt - 10 * 60 * 1000;
      if (now < remindAt) continue; // ยังไม่ถึงเวลา ข้ามไปก่อน รอบหน้าค่อยเช็คใหม่

      if (now > item.departAt + GRACE_AFTER_DEPART_MS) {
        // เลยเวลาไปมากแล้ว (เช่น cron พลาดจังหวะ) ทิ้งแทนแจ้งเตือนย้อนหลังที่ไม่มีประโยชน์
        await kv.del(key);
        summary.cleaned++;
        continue;
      }

      const serviceName = item.arl ? "Airport Rail Link" : "ขบวน " + item.trainNo;
      const payload = JSON.stringify({
        title: "รถไฟจะออกในอีกประมาณ 10 นาที",
        body: serviceName + (item.from ? " · ออกจาก " + item.from : "") + (item.to ? " → " + item.to : ""),
        tag: "train-" + item.trainNo
      });

      try {
        await webpush.sendNotification(item.subscription, payload);
        summary.sent++;
      } catch (error) {
        // 404/410 แปลว่าผู้ใช้ยกเลิกหรือ Subscription หมดอายุฝั่งเบราว์เซอร์แล้ว ลบทิ้งเงียบๆ ได้เลย
        if (error?.statusCode === 404 || error?.statusCode === 410) {
          summary.expired++;
        } else {
          summary.errors++;
        }
      }
      await kv.del(key); // ส่งครั้งเดียวจบ ไม่ว่าสำเร็จหรือไม่ ป้องกันการส่งซ้ำรอบถัดไป
    }

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "ok", ...summary });
  } catch (error) {
    return res.status(502).json({ status: "error", message: String(error?.message || error), ...summary });
  }
}
