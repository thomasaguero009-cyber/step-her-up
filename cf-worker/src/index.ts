// Intermediario entre calendario.html y la API de GHL. Guarda la Private
// Integration key como secret (nunca en el repo) y expone dos rutas simples
// para que el front no tenga que hablar con GHL directamente.

export interface Env {
  GHL_API_KEY: string;
  GHL_LOCATION_ID: string;
  GHL_CALENDAR_ID: string;
  ALLOWED_ORIGINS: string;
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function json(data: unknown, status: number, extraHeaders: HeadersInit): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...extraHeaders },
  });
}

function ghlHeaders(env: Env): HeadersInit {
  return {
    Authorization: `Bearer ${env.GHL_API_KEY}`,
    Version: GHL_VERSION,
    Accept: "application/json",
  };
}

// GHL devuelve los slots como ISO con offset propio (timezone del negocio).
// Formateamos "hh:mm AM/PM" directo del string, sin reconvertir zona horaria,
// para evitar correr el horario por error de conversión en el cliente.
function formatHora(iso: string): string {
  const match = iso.match(/T(\d{2}):(\d{2})/);
  if (!match) return iso;
  let h = parseInt(match[1], 10);
  const m = match[2];
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${m} ${ampm}`;
}

async function handleFreeSlots(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const days = Math.min(parseInt(url.searchParams.get("days") || "14", 10) || 14, 30);
  const startDate = Date.now();
  const endDate = startDate + days * 24 * 60 * 60 * 1000;

  const ghlUrl = `${GHL_BASE}/calendars/${env.GHL_CALENDAR_ID}/free-slots?startDate=${startDate}&endDate=${endDate}`;
  const res = await fetch(ghlUrl, { headers: ghlHeaders(env) });
  if (!res.ok) {
    const detail = await res.text();
    return json({ ok: false, error: "ghl_free_slots_failed", detail }, 502, cors);
  }
  const raw = (await res.json()) as Record<string, { slots?: string[] }>;

  const out: Record<string, { time: string; iso: string }[]> = {};
  for (const [date, info] of Object.entries(raw)) {
    if (!info?.slots?.length) continue;
    out[date] = info.slots.map((iso) => ({ time: formatHora(iso), iso }));
  }
  return json({ ok: true, days: out }, 200, cors);
}

async function upsertContact(
  env: Env,
  data: { firstName: string; lastName: string; email: string; phone: string }
): Promise<string> {
  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      locationId: env.GHL_LOCATION_ID,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email || undefined,
      phone: data.phone || undefined,
    }),
  });
  if (!res.ok) {
    throw new Error(`upsert_contact_failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { contact?: { id?: string } };
  const id = body.contact?.id;
  if (!id) throw new Error("upsert_contact_no_id");
  return id;
}

async function handleBook(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let payload: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    startTime?: string;
  };
  try {
    payload = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }

  const { firstName, lastName, email, phone, startTime } = payload;
  if (!firstName || !startTime || (!email && !phone)) {
    return json({ ok: false, error: "missing_fields" }, 400, cors);
  }

  let contactId: string;
  try {
    contactId = await upsertContact(env, {
      firstName,
      lastName: lastName || "",
      email: email || "",
      phone: phone || "",
    });
  } catch (err) {
    return json({ ok: false, error: "contact_failed", detail: String(err) }, 502, cors);
  }

  // No mandamos endTime: dejamos que GHL calcule la duración con la
  // configuración propia del calendario, en vez de adivinarla acá.
  const apptRes = await fetch(`${GHL_BASE}/calendars/events/appointments`, {
    method: "POST",
    headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({
      calendarId: env.GHL_CALENDAR_ID,
      locationId: env.GHL_LOCATION_ID,
      contactId,
      startTime,
      title: `Llamada de aplicación — ${firstName} ${lastName || ""}`.trim(),
      // "new" en la API = "Unconfirmed" en GHL. El lead la reserva sola
      // (nadie del equipo la validó todavía); queda pendiente hasta que
      // alguien la pase a "Confirmed" a mano en GHL, lo que dispara el
      // workflow que manda el mail de confirmación.
      appointmentStatus: "new",
    }),
  });

  if (!apptRes.ok) {
    const detail = await apptRes.text();
    // GHL devuelve 400 (no 409/422) con este mensaje puntual cuando el
    // horario se ocupó entre que se mostró y se confirmó — lo distinguimos
    // de cualquier otro error para que el front pueda pedir otro horario.
    const esSlotTomado = detail.toLowerCase().includes("no longer available");
    if (esSlotTomado) {
      return json({ ok: false, error: "slot_taken" }, 409, cors);
    }
    return json({ ok: false, error: "appointment_failed", detail }, 502, cors);
  }

  const appt = await apptRes.json();
  return json({ ok: true, appointment: appt }, 200, cors);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get("Origin"), env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (url.pathname === "/free-slots" && request.method === "GET") {
        return await handleFreeSlots(url, env, cors);
      }
      if (url.pathname === "/book" && request.method === "POST") {
        return await handleBook(request, env, cors);
      }
    } catch (err) {
      return json({ ok: false, error: "unexpected", detail: String(err) }, 500, cors);
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};
