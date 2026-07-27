import { baseUrl, callbackUrl, exchangeAuthorizationCode, verifyOAuthState } from "../../lib/strava.js";

function page(title, message, home, ok = false) {
  return `<!doctype html><html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title><style>body{margin:0;background:#54101d;color:#fff;font-family:system-ui,sans-serif;min-height:100vh;display:grid;place-items:center;padding:24px;box-sizing:border-box}.box{max-width:560px;background:#fff;color:#281a1c;border-radius:18px;padding:28px;box-shadow:0 20px 60px #0005}.tag{font-size:12px;font-weight:800;letter-spacing:1px;color:${ok ? "#0e7a52" : "#d92d20"}}h1{font-size:25px;margin:8px 0 10px}p{line-height:1.65;color:#725e62}a{display:inline-block;margin-top:12px;background:#54101d;color:#fff;text-decoration:none;padding:11px 16px;border-radius:10px;font-weight:700}</style></head><body><main class="box"><div class="tag">${ok ? "CONNECTED" : "CONNECTION ERROR"}</div><h1>${title}</h1><p>${message}</p><a href="${home}">กลับไปหน้า PAI.DUY.NA</a></main></body></html>`;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).send("Method not allowed");
  const home = baseUrl(req);
  try {
    if (req.query?.error) {
      return res.status(400).send(page("ไม่ได้เชื่อมบัญชี Strava", "การอนุญาตถูกยกเลิกหรือ Strava ไม่ได้ส่งสิทธิ์กลับมา", home));
    }
    if (!verifyOAuthState(req.query?.state)) {
      return res.status(400).send(page("ลิงก์เชื่อมต่อไม่ถูกต้อง", "ค่า State หมดอายุหรือไม่ผ่านการตรวจสอบ กรุณาเริ่มเชื่อมบัญชีใหม่", home));
    }
    if (!req.query?.code) {
      return res.status(400).send(page("ไม่พบ Authorization Code", "Strava ไม่ได้ส่งรหัสสำหรับแลก Token กลับมา", home));
    }
    const token = await exchangeAuthorizationCode(String(req.query.code), callbackUrl(req));
    const athlete = token.athlete ? `${token.athlete.firstname || ""} ${token.athlete.lastname || ""}`.trim() : "บัญชีของคุณ";
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(page("เชื่อม Strava สำเร็จ", `เชื่อมกับ ${athlete || "บัญชีของคุณ"} แล้ว หน้า Landing จะดึงกิจกรรมวิ่งล่าสุดของวันนี้โดยอัตโนมัติ`, home, true));
  } catch (error) {
    return res.status(500).send(page("เชื่อม Strava ไม่สำเร็จ", String(error?.message || error), home));
  }
}
