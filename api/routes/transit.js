// วางแผนเดินทางข้ามระบบด้วย Google Directions API (โหมด transit)
// - รับต้นทาง/ปลายทางเป็นพิกัด (lat/lng) หรือข้อความ (ชื่อสถานี/สถานที่)
// - คืนเส้นทางเป็น leg ย่อย (เดิน / ขึ้นรถไฟฟ้า / ต่อรถ) แบบ normalize แล้ว
// - รองรับเฉพาะสายที่เปิดให้บริการจริงตามข้อมูลฝั่ง Google
// - API Key อยู่ฝั่ง Server เท่านั้น ไม่ส่งกลับหน้าเว็บ
const DIRECTIONS_URL = "https://maps.googleapis.com/maps/api/directions/json";

// ค่าจำกัดข้อความ ป้องกัน query ยาวผิดปกติ
const MAX_QUERY_LEN = 200;

const finiteNumber = value => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// แปลงพารามิเตอร์เป็นรูปแบบที่ Directions API รับได้
// พิกัดมาก่อนข้อความเสมอ เพราะแม่นยำกว่า
function resolveWaypoint(latRaw, lngRaw, textRaw) {
  const lat = finiteNumber(latRaw);
  const lng = finiteNumber(lngRaw);
  if (lat !== null && lng !== null) {
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return { error: "พิกัดไม่ถูกต้อง" };
    return { value: `${lat},${lng}` };
  }
  const text = String(textRaw || "").trim().slice(0, MAX_QUERY_LEN);
  if (text) return { value: text };
  return { error: "ต้องระบุพิกัดหรือชื่อสถานที่" };
}

// ระบุประเภท leg เพื่อให้ฝั่งหน้าเว็บเลือกไอคอนและสีได้ถูก
function classifyStep(step) {
  if (step?.travel_mode === "WALKING") return "walk";
  const vehicleType = step?.transit_details?.line?.vehicle?.type || "";
  const railTypes = ["SUBWAY", "METRO_RAIL", "MONORAIL", "HEAVY_RAIL", "COMMUTER_TRAIN", "RAIL", "TRAM", "LIGHT_RAIL"];
  if (railTypes.includes(vehicleType)) return "rail";
  return "transit";
}

// แปลง step ของ Google เป็นโครงสร้างที่ใช้แสดงผลง่าย ตัดฟิลด์ที่ไม่จำเป็นออก
function normalizeStep(step) {
  const kind = classifyStep(step);
  const durationText = step?.duration?.text || "";
  const distanceText = step?.distance?.text || "";

  if (kind === "walk") {
    return {
      kind,
      durationText,
      distanceText,
      instruction: "เดิน"
    };
  }

  const t = step?.transit_details || {};
  const line = t.line || {};
  const vehicleName = line?.vehicle?.name || "รถสาธารณะ";
  return {
    kind,
    durationText,
    distanceText,
    lineName: line?.short_name || line?.name || vehicleName,
    lineColor: line?.color || "",
    vehicle: vehicleName,
    departureStop: t?.departure_stop?.name || "",
    arrivalStop: t?.arrival_stop?.name || "",
    departureTime: t?.departure_time?.text || "",
    arrivalTime: t?.arrival_time?.text || "",
    numStops: Number.isFinite(Number(t?.num_stops)) ? Number(t.num_stops) : null,
    headsign: t?.headsign || ""
  };
}

// รวมแต่ละ route ให้เหลือข้อมูลสรุปที่จำเป็น
function normalizeRoute(route) {
  const leg = Array.isArray(route?.legs) ? route.legs[0] : null;
  if (!leg) return null;
  const steps = Array.isArray(leg.steps) ? leg.steps.map(normalizeStep) : [];
  const transfers = steps.filter(s => s.kind === "rail" || s.kind === "transit").length;
  return {
    summary: route?.summary || "",
    durationText: leg?.duration?.text || "",
    distanceText: leg?.distance?.text || "",
    departureTime: leg?.departure_time?.text || "",
    arrivalTime: leg?.arrival_time?.text || "",
    startAddress: leg?.start_address || "",
    endAddress: leg?.end_address || "",
    transfers: Math.max(0, transfers - 1),
    steps
  };
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", message: "Method not allowed" });
  }

  // รองรับ key เฉพาะ Directions หรือใช้ key เดียวกับ Places ได้ หากเปิด Directions API ให้ key นั้น
  const apiKey = process.env.GOOGLE_DIRECTIONS_API_KEY || process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(503).json({
      status: "error",
      code: "directions_not_configured",
      message: "ยังไม่ได้ตั้งค่า GOOGLE_DIRECTIONS_API_KEY"
    });
  }

  const origin = resolveWaypoint(req.query?.olat, req.query?.olng, req.query?.o);
  const destination = resolveWaypoint(req.query?.dlat, req.query?.dlng, req.query?.d);
  if (origin.error) return res.status(400).json({ status: "error", message: `ต้นทาง: ${origin.error}` });
  if (destination.error) return res.status(400).json({ status: "error", message: `ปลายทาง: ${destination.error}` });

  try {
    const url = new URL(DIRECTIONS_URL);
    url.searchParams.set("origin", origin.value);
    url.searchParams.set("destination", destination.value);
    url.searchParams.set("mode", "transit");
    url.searchParams.set("transit_mode", "rail|train|subway|tram");
    url.searchParams.set("alternatives", "true");
    url.searchParams.set("language", "th");
    url.searchParams.set("region", "th");
    url.searchParams.set("key", apiKey);
    // เวลาออกเดินทาง ถ้าไม่ส่งมาจะใช้ตอนนี้
    const depart = finiteNumber(req.query?.departAt);
    url.searchParams.set("departure_time", depart !== null ? String(Math.floor(depart)) : "now");

    const response = await fetch(url);
    const payload = await response.json().catch(() => ({}));

    // Google คืน 200 พร้อม status ภายในเสมอ ต้องเช็ค payload.status
    if (payload.status === "ZERO_RESULTS") {
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ status: "ok", count: 0, routes: [], message: "ไม่พบเส้นทางขนส่งสาธารณะระหว่างสองจุดนี้" });
    }
    if (payload.status !== "OK") {
      const message = payload?.error_message || `Directions API: ${payload.status || response.status}`;
      const error = new Error(message);
      error.status = payload.status === "OVER_QUERY_LIMIT" ? 429 : 502;
      throw error;
    }

    const routes = (Array.isArray(payload.routes) ? payload.routes : [])
      .map(normalizeRoute)
      .filter(Boolean)
      .slice(0, 3);

    res.setHeader("Cache-Control", "public, s-maxage=120, stale-while-revalidate=600");
    return res.status(200).json({
      status: "ok",
      source: "google_directions",
      count: routes.length,
      routes
    });
  } catch (error) {
    res.setHeader("Cache-Control", "no-store");
    const status = Number(error?.status) === 429 ? 429 : 502;
    return res.status(status).json({
      status: "error",
      code: "directions_error",
      message: String(error?.message || error)
    });
  }
}
