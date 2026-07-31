// ยกเลิกการแจ้งเตือน Push ทั้งหมดที่ผูกกับอุปกรณ์นี้ (ตาม Subscription endpoint)
import { kv } from "@vercel/kv";
import { hashEndpoint } from "../../lib/push.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  const endpoint = req.body?.subscription?.endpoint;
  if (!endpoint || typeof endpoint !== "string") {
    return res.status(400).json({ status: "error", message: "ต้องระบุ Subscription" });
  }

  try {
    const hash = hashEndpoint(endpoint);
    const keys = await kv.keys(`reminder:${hash}:*`);
    if (keys.length) await Promise.all(keys.map(k => kv.del(k)));
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ status: "ok", removed: keys.length });
  } catch (error) {
    return res.status(502).json({ status: "error", message: "ยกเลิกไม่สำเร็จ: " + String(error?.message || error) });
  }
}
