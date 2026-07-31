// คืน VAPID Public Key ให้หน้าเว็บใช้ตอน subscribe Push
// Public Key เปิดเผยได้ ไม่ใช่ความลับ (คนละคู่กับ Private Key ที่อยู่ฝั่ง Server เท่านั้น)
import { VAPID_PUBLIC_KEY } from "../../lib/push.js";

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  if (!VAPID_PUBLIC_KEY) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({ status: "error", code: "push_not_configured", message: "ยังไม่ได้ตั้งค่า VAPID_PUBLIC_KEY" });
  }
  res.setHeader("Cache-Control", "public, max-age=3600");
  return res.status(200).json({ status: "ok", publicKey: VAPID_PUBLIC_KEY });
}
