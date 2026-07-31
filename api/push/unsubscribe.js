// ยกเลิกการแจ้งเตือน Push ทั้งหมดที่ผูกกับอุปกรณ์นี้ (ตาม Subscription endpoint)
import { hashEndpoint } from "../../lib/push.js";
import { getRedis, isRedisConfigured } from "../../lib/redis.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }
  if (!isRedisConfigured()) {
    return res.status(503).json({
      status: "error",
      code: "redis_not_configured",
      message: "ยังไม่ได้เชื่อม Upstash Redis หรือกำหนด Redis environment variables"
    });
  }

  const endpoint = req.body?.subscription?.endpoint;
  if (!endpoint || typeof endpoint !== "string") {
    return res.status(400).json({ status: "error", message: "ต้องระบุ Subscription" });
  }

  try {
    const redis = getRedis();
    const hash = hashEndpoint(endpoint);
    const keys = await redis.keys(`reminder:${hash}:*`);
    if (keys.length) await Promise.all(keys.map(key => redis.del(key)));
    return res.status(200).json({ status: "ok", removed: keys.length });
  } catch (error) {
    return res.status(502).json({
      status: "error",
      message: "ยกเลิกไม่สำเร็จ: " + String(error?.message || error)
    });
  }
}
