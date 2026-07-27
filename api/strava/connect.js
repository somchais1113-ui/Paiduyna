import { callbackUrl, createOAuthState, verifySetupKey } from "../../lib/strava.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  if (!verifySetupKey(req.query?.key)) {
    return res.status(401).send("Unauthorized: add the correct STRAVA_SETUP_KEY as ?key=...");
  }
  if (!process.env.STRAVA_CLIENT_ID || !process.env.STRAVA_CLIENT_SECRET) {
    return res.status(503).send("Strava environment variables are not configured");
  }

  const params = new URLSearchParams({
    client_id: process.env.STRAVA_CLIENT_ID,
    redirect_uri: callbackUrl(req),
    response_type: "code",
    approval_prompt: "auto",
    scope: process.env.STRAVA_SCOPE || "read,activity:read_all",
    state: createOAuthState()
  });
  res.redirect(302, `https://www.strava.com/oauth/authorize?${params}`);
}
