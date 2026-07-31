// Redis client กลางสำหรับ Vercel Functions
// รองรับทั้งชื่อตัวแปรใหม่ของ Upstash และชื่อตัวแปรเดิมจาก Vercel KV ที่ถูกย้ายมา Upstash
import { Redis } from "@upstash/redis";

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  "";

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  "";

let client = null;

function isRedisConfigured() {
  return Boolean(REDIS_URL && REDIS_TOKEN);
}

function getRedis() {
  if (!isRedisConfigured()) return null;
  if (!client) {
    client = new Redis({ url: REDIS_URL, token: REDIS_TOKEN });
  }
  return client;
}

export { getRedis, isRedisConfigured };
