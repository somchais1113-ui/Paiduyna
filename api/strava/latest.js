import { latestRunToday } from "../../lib/strava.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const result = await latestRunToday();
    res.setHeader("Cache-Control", "public, s-maxage=60, stale-while-revalidate=300");
    return res.status(200).json(result);
  } catch (error) {
    const code = error?.code === "TOKEN_STORAGE_REQUIRED" ? "token_storage_required" : "strava_error";
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      status: "error",
      code,
      message: String(error?.message || error)
    });
  }
}
