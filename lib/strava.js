import crypto from "node:crypto";
import { get, put } from "@vercel/blob";

const TOKEN_PATH = "paiduyna-private/strava-token.json";
const STRAVA_TOKEN_URL = "https://www.strava.com/api/v3/oauth/token";
const STRAVA_API = "https://www.strava.com/api/v3";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function safeEqual(a, b) {
  const aa = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

export function verifySetupKey(value) {
  const expected = process.env.STRAVA_SETUP_KEY;
  return Boolean(expected && safeEqual(value, expected));
}

export function baseUrl(req) {
  if (process.env.STRAVA_REDIRECT_URI) {
    return process.env.STRAVA_REDIRECT_URI.replace(/\/api\/strava\/callback\/?$/, "");
  }
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host) throw new Error("Cannot determine website host");
  return `${proto}://${host}`;
}

export function callbackUrl(req) {
  return process.env.STRAVA_REDIRECT_URI || `${baseUrl(req)}/api/strava/callback`;
}

export function createOAuthState() {
  const secret = required("STRAVA_CLIENT_SECRET");
  const payload = Buffer.from(JSON.stringify({
    ts: Date.now(),
    nonce: crypto.randomBytes(18).toString("hex")
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyOAuthState(state) {
  try {
    const [payload, signature] = String(state || "").split(".");
    if (!payload || !signature) return false;
    const secret = required("STRAVA_CLIENT_SECRET");
    const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return false;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return Number.isFinite(parsed.ts) && Date.now() - parsed.ts >= 0 && Date.now() - parsed.ts <= 15 * 60 * 1000;
  } catch {
    return false;
  }
}

let blobStorageAvailable = null;

async function readBlobJson(pathname) {
  try {
    const blob = await get(pathname, { access: "private", useCache: false });
    blobStorageAvailable = true;
    if (!blob) return null;
    const text = await new Response(blob.stream).text();
    return JSON.parse(text);
  } catch {
    blobStorageAvailable = false;
    return null;
  }
}

async function ensureBlobStorage() {
  if (blobStorageAvailable === true) return;
  try {
    await get(TOKEN_PATH, { access: "private", useCache: false });
    blobStorageAvailable = true;
  } catch {
    blobStorageAvailable = false;
    const error = new Error("A Private Vercel Blob store must be connected to persist rotating Strava tokens");
    error.code = "TOKEN_STORAGE_REQUIRED";
    throw error;
  }
}

async function writeBlobJson(pathname, value) {
  await ensureBlobStorage();
  await put(pathname, JSON.stringify(value), {
    access: "private",
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 60
  });
}

export async function readStoredToken() {
  const stored = await readBlobJson(TOKEN_PATH);
  if (stored) return stored;

  if (process.env.STRAVA_ACCESS_TOKEN && process.env.STRAVA_REFRESH_TOKEN) {
    return {
      access_token: process.env.STRAVA_ACCESS_TOKEN,
      refresh_token: process.env.STRAVA_REFRESH_TOKEN,
      expires_at: Number(process.env.STRAVA_EXPIRES_AT || 0),
      scope: process.env.STRAVA_SCOPE || "read,activity:read_all",
      source: "environment"
    };
  }
  return null;
}

export async function saveStoredToken(token) {
  await writeBlobJson(TOKEN_PATH, {
    ...token,
    saved_at: new Date().toISOString(),
    source: "vercel-blob"
  });
}

async function postToken(params) {
  const response = await fetch(STRAVA_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Strava token request failed (${response.status})`);
  }
  return data;
}

export async function exchangeAuthorizationCode(code, redirectUri) {
  const token = await postToken({
    client_id: required("STRAVA_CLIENT_ID"),
    client_secret: required("STRAVA_CLIENT_SECRET"),
    code,
    grant_type: "authorization_code"
  });
  await saveStoredToken({
    ...token,
    redirect_uri: redirectUri,
    connected_at: new Date().toISOString()
  });
  return token;
}

export async function getValidAccessToken() {
  const token = await readStoredToken();
  if (!token) return null;

  const expiresAt = Number(token.expires_at || 0);
  if (expiresAt > Math.floor(Date.now() / 1000) + 600) return token.access_token;

  await ensureBlobStorage();

  const refreshed = await postToken({
    client_id: required("STRAVA_CLIENT_ID"),
    client_secret: required("STRAVA_CLIENT_SECRET"),
    grant_type: "refresh_token",
    refresh_token: token.refresh_token
  });
  await saveStoredToken({
    ...token,
    ...refreshed,
    athlete: refreshed.athlete || token.athlete,
    scope: refreshed.scope || token.scope,
    refreshed_at: new Date().toISOString()
  });
  return refreshed.access_token;
}

async function stravaGet(path, accessToken) {
  const response = await fetch(`${STRAVA_API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Strava API failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function bangkokDayRange() {
  const offset = 7 * 60 * 60 * 1000;
  const local = new Date(Date.now() + offset);
  const y = local.getUTCFullYear();
  const m = local.getUTCMonth();
  const d = local.getUTCDate();
  const startMs = Date.UTC(y, m, d, 0, 0, 0) - offset;
  const endMs = Date.UTC(y, m, d + 1, 0, 0, 0) - offset;
  return {
    date: `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`,
    after: Math.floor(startMs / 1000) - 1,
    before: Math.floor(endMs / 1000)
  };
}

const SUPPORTED_ACTIVITY_TYPES = new Set(["Run", "TrailRun", "VirtualRun", "Walk", "Hike"]);

function isSupportedActivity(activity) {
  const sportType = String(activity?.sport_type || "");
  const legacyType = String(activity?.type || "");
  return SUPPORTED_ACTIVITY_TYPES.has(sportType) || SUPPORTED_ACTIVITY_TYPES.has(legacyType);
}

function round(value, digits = 1) {
  if (!Number.isFinite(Number(value))) return null;
  const p = 10 ** digits;
  return Math.round(Number(value) * p) / p;
}

export async function latestActivityToday() {
  const accessToken = await getValidAccessToken();
  if (!accessToken) return { status: "setup_required" };

  const range = bangkokDayRange();
  const params = new URLSearchParams({
    after: String(range.after),
    before: String(range.before),
    page: "1",
    per_page: "50"
  });
  const activities = await stravaGet(`/athlete/activities?${params}`, accessToken);
  const latest = Array.isArray(activities)
    ? activities.filter(isSupportedActivity).sort((a, b) => new Date(b.start_date) - new Date(a.start_date))[0]
    : null;

  if (!latest) return { status: "no_activity", date: range.date };

  const detail = await stravaGet(`/activities/${encodeURIComponent(latest.id)}?include_all_efforts=false`, accessToken);
  const distanceKm = Number(detail.distance || 0) / 1000;
  const movingSeconds = Number(detail.moving_time || 0);

  return {
    status: "ok",
    date: range.date,
    updated_at: new Date().toISOString(),
    activity: {
      id: String(detail.id),
      name: detail.name || "Today Activity",
      sport_type: detail.sport_type || detail.type || "Workout",
      distance_km: round(distanceKm, 2),
      moving_time_seconds: movingSeconds,
      elapsed_time_seconds: Number(detail.elapsed_time || 0),
      pace_seconds_per_km: distanceKm > 0 ? Math.round(movingSeconds / distanceKm) : null,
      average_heartrate: round(detail.average_heartrate, 0),
      max_heartrate: round(detail.max_heartrate, 0),
      calories: round(detail.calories, 0),
      elevation_gain_m: round(detail.total_elevation_gain, 0),
      start_date: detail.start_date,
      start_date_local: detail.start_date_local,
      url: `https://www.strava.com/activities/${encodeURIComponent(detail.id)}`
    }
  };
}
