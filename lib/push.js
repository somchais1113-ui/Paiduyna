// Utility กลางสำหรับระบบ Push Notification
// - ตั้งค่า VAPID ให้ web-push ครั้งเดียว ใช้ร่วมกันทุก endpoint
// - รวมฟังก์ชันช่วย hash endpoint และคำนวณ TTL ไว้ที่เดียว เพื่อไม่ให้ endpoint ต่างไฟล์คำนวณไม่ตรงกัน
import webpush from "web-push";
import crypto from "node:crypto";

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || "mailto:admin@example.com";

let configured = false;
function ensureConfigured(){
  if(configured) return true;
  if(!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// สับ endpoint ของ Subscription ให้เป็นรหัสสั้นไว้ทำ Key ใน KV (ไม่เก็บ endpoint เต็มเป็น key ตรงๆ)
function hashEndpoint(endpoint){
  return crypto.createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 24);
}

// ชื่อ Key ของดัชนีเวลาแจ้งเตือน (Sorted Set)
// ตั้งชื่อไม่ให้ขึ้นต้นด้วย reminder: เพื่อไม่ให้ชนกับ pattern reminder:* ตอนกวาดข้อมูลเดิม
const REMINDER_INDEX_KEY = "pdn:reminder-index";

// จำนวนวินาทีจากตอนนี้ถึง timestamp ที่กำหนด บวก buffer กันเผื่อ (ไม่ต่ำกว่า 60 วินาที)
function secondsUntil(msTimestamp, bufferSec = 0){
  const diff = Math.floor((Number(msTimestamp) - Date.now()) / 1000);
  return Math.max(60, diff + bufferSec);
}

export { webpush, ensureConfigured, hashEndpoint, secondsUntil, VAPID_PUBLIC_KEY, REMINDER_INDEX_KEY };
