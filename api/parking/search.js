const GOOGLE_PLACES_BASE = "https://places.googleapis.com/v1/places";
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.shortFormattedAddress",
  "places.location",
  "places.primaryType",
  "places.primaryTypeDisplayName",
  "places.types",
  "places.googleMapsUri",
  "places.businessStatus"
].join(",");

// เวลาสูงสุดที่ยอมรอ Google ก่อนตัดจบ ป้องกัน Function ค้างจนหมดเวลาของแพลตฟอร์ม
const UPSTREAM_TIMEOUT_MS = 8000;

// สร้าง signal สำหรับ timeout โดยรองรับ Node รุ่นที่ยังไม่มี AbortSignal.timeout
function timeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const finiteNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function haversine(aLat, aLng, bLat, bLng) {
  const radius = 6371000;
  const toRad = degrees => degrees * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.sqrt(a)));
}

function shortLocation(address = "") {
  return String(address)
    .replace(/,?\s*ประเทศไทย\s*$/u, "")
    .split(",")
    .map(part => part.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" · ");
}

function normalizePlaces(rawPlaces, origin) {
  const places = (Array.isArray(rawPlaces) ? rawPlaces : []).map((place, index) => {
    const lat = finiteNumber(place?.location?.latitude);
    const lng = finiteNumber(place?.location?.longitude);
    const name = String(place?.displayName?.text || "").trim() || `ลานจอดรถ ${index + 1}`;
    const address = String(place?.formattedAddress || place?.shortFormattedAddress || "").trim();
    const shortAddress = String(place?.shortFormattedAddress || shortLocation(address)).trim();
    const distanceM = origin && lat !== null && lng !== null
      ? haversine(origin.lat, origin.lng, lat, lng)
      : null;

    return {
      id: String(place?.id || `parking-${index + 1}`),
      name,
      title: name,
      address,
      shortAddress,
      lat,
      lng,
      distanceM,
      primaryType: String(place?.primaryType || "parking"),
      typeLabel: String(place?.primaryTypeDisplayName?.text || "ลานจอดรถ"),
      types: Array.isArray(place?.types) ? place.types : [],
      googleMapsUri: String(place?.googleMapsUri || ""),
      businessStatus: String(place?.businessStatus || "")
    };
  }).filter(place => place.lat !== null && place.lng !== null && place.businessStatus !== "CLOSED_PERMANENTLY");

  const nameCounts = new Map();
  for (const place of places) {
    const key = place.name.toLocaleLowerCase("th-TH").replace(/\s+/g, " ");
    nameCounts.set(key, (nameCounts.get(key) || 0) + 1);
  }

  for (const place of places) {
    const key = place.name.toLocaleLowerCase("th-TH").replace(/\s+/g, " ");
    if ((nameCounts.get(key) || 0) > 1 && place.shortAddress) {
      place.title = `${place.name} · ${place.shortAddress}`;
    }
  }

  return places;
}

async function callGoogle(endpoint, body, apiKey) {
  const response = await fetch(`${GOOGLE_PLACES_BASE}:${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": FIELD_MASK
    },
    body: JSON.stringify(body),
    signal: timeoutSignal(UPSTREAM_TIMEOUT_MS)
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    // รายละเอียดจาก Google เก็บไว้ใน log เท่านั้น ไม่ส่งกลับไปที่หน้าเว็บ
    console.error("places_upstream", response.status, payload?.error?.message || "");
    const error = new Error("upstream_status_" + response.status);
    error.status = response.status;
    throw error;
  }
  return payload;
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      status: "error",
      code: "google_places_not_configured",
      message: "GOOGLE_PLACES_API_KEY is not configured"
    });
  }

  try {
    const lat = finiteNumber(req.query?.lat);
    const lng = finiteNumber(req.query?.lng);
    const query = String(req.query?.q || "").trim().slice(0, 180);
    let payload;
    let mode;
    let origin = null;

    if (lat !== null && lng !== null) {
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
        return res.status(400).json({ status: "error", message: "Invalid coordinates" });
      }
      const radius = clamp(finiteNumber(req.query?.radius) ?? 1200, 100, 5000);
      origin = { lat, lng };
      mode = "nearby";
      payload = await callGoogle("searchNearby", {
        includedTypes: ["parking", "parking_garage", "parking_lot"],
        maxResultCount: 15,
        rankPreference: "DISTANCE",
        languageCode: "th",
        regionCode: "TH",
        locationRestriction: {
          circle: {
            center: { latitude: lat, longitude: lng },
            radius
          }
        }
      }, apiKey);
    } else if (query) {
      mode = "text";
      payload = await callGoogle("searchText", {
        textQuery: query,
        includedType: "parking",
        strictTypeFiltering: false,
        pageSize: 15,
        languageCode: "th",
        regionCode: "TH"
      }, apiKey);
    } else {
      return res.status(400).json({
        status: "error",
        message: "Provide lat/lng or q"
      });
    }

    const places = normalizePlaces(payload?.places, origin);
    if (origin) places.sort((a, b) => (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity));

    res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=1800");
    return res.status(200).json({
      status: "ok",
      source: "google_places",
      mode,
      count: places.length,
      places
    });
  } catch (error) {
    console.error("google_places_error", error?.message || error);
    res.setHeader("Cache-Control", "no-store");
    const aborted = error?.name === "TimeoutError" || error?.name === "AbortError";
    const status = aborted ? 504 : (Number(error?.status) === 429 ? 429 : 502);
    return res.status(status).json({
      status: "error",
      code: aborted ? "google_places_timeout" : "google_places_error",
      message: aborted
        ? "เครือข่ายตอบช้าเกินไป กรุณาลองใหม่อีกครั้ง"
        : "ค้นหาลานจอดไม่สำเร็จในขณะนี้ กรุณาลองใหม่อีกครั้ง"
    });
  }
}
