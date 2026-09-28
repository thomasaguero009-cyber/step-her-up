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
  const oportunidad = await ponerEnAutoBooked(env, contactId, `${firstName} ${lastName || ""}`.trim());
  return json({ ok: true, appointment: appt, opportunity: oportunidad }, 200, cors);
}

// Al agendar desde el calendario propio, el lead también tiene que verse
// en Opportunities → pipeline Clickfunnels, etapa "Auto Booked". Reglas:
// sin oportunidad en ese pipeline → se crea en Auto Booked; con una en
// "New Lead" → se mueve a Auto Booked; en cualquier otra etapa (ya la
// están llamando, ya tuvo show, etc.) → no se toca, para no retroceder el
// seguimiento de las setters. Cualquier falla acá NO rompe la reserva
// (la cita ya quedó creada): se devuelve en `opportunity` para poder verla.
const PIPELINE_CLICKFUNNELS = "9n9W39rlWHmD2cPdSWji";
const ETAPA_NEW_LEAD = "31763877-0e89-482d-8fed-6afd89bc85a7";
const ETAPA_AUTO_BOOKED = "f90944a5-3652-4756-8379-6e92041e051c";

async function ponerEnAutoBooked(env: Env, contactId: string, nombre: string): Promise<{ accion: string; detail?: string }> {
  try {
    const buscar = await fetch(
      `${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${PIPELINE_CLICKFUNNELS}&contact_id=${contactId}`,
      { headers: ghlHeaders(env) }
    );
    if (!buscar.ok) return { accion: "error", detail: `search ${buscar.status}: ${await buscar.text()}` };
    const { opportunities = [] } = (await buscar.json()) as { opportunities?: { id: string; pipelineStageId: string }[] };

    if (!opportunities.length) {
      const crear = await fetch(`${GHL_BASE}/opportunities/`, {
        method: "POST",
        headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({
          pipelineId: PIPELINE_CLICKFUNNELS,
          locationId: env.GHL_LOCATION_ID,
          pipelineStageId: ETAPA_AUTO_BOOKED,
          contactId,
          name: nombre || "Lead calendario",
          status: "open",
          source: "Calendario landing",
        }),
      });
      if (!crear.ok) return { accion: "error", detail: `create ${crear.status}: ${await crear.text()}` };
      return { accion: "creada" };
    }

    const existente = opportunities[0];
    if (existente.pipelineStageId === ETAPA_AUTO_BOOKED) return { accion: "ya_estaba" };
    if (existente.pipelineStageId !== ETAPA_NEW_LEAD) return { accion: "sin_cambios_ya_avanzada" };
    const mover = await fetch(`${GHL_BASE}/opportunities/${existente.id}`, {
      method: "PUT",
      headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ pipelineStageId: ETAPA_AUTO_BOOKED }),
    });
    if (!mover.ok) return { accion: "error", detail: `move ${mover.status}: ${await mover.text()}` };
    return { accion: "movida" };
  } catch (err) {
    return { accion: "error", detail: String(err) };
  }
}

// ===== Resumen de leads/llamadas/shows/cierres desde Opportunities de GHL,
// para el dashboard interno (dashboard.html → pestaña "GHL en vivo").
// No toca nada del flujo de reserva de arriba. =====

// Los 4 pipelines de CAPTACIÓN (cada uno es una fuente de lead distinta) —
// quedan afuera a propósito los pipelines de "Delivery"/onboarding post-venta
// (Step Her Up - Delivery, Done For You, etc.), que no son parte de este
// embudo. Si se agrega una fuente nueva, hay que sumarla acá a mano.
const PIPELINES_LEADS: { id: string; fuente: string }[] = [
  { id: "9n9W39rlWHmD2cPdSWji", fuente: "Clickfunnels" },
  { id: "E4ZWcLirUSAzF6jRgpnB", fuente: "Facebook Forms" },
  { id: "MA9OafjUpyrhJVYjYwiU", fuente: "Gianie DM's" },
  { id: "WrUulu7PHOqb6TapPTml", fuente: "Gianie Organic" },
];

// Clasifica una oportunidad por el NOMBRE de su etapa actual (no por id,
// que difiere entre pipelines aunque el nombre sea el mismo). Los 4
// pipelines comparten esta estructura: New Lead/Auto Booked (sin
// contactar) → Called 1X..8X (llamado) → Appointment Set (agendada) →
// No Show / Follow Up / Closed / Not Qualified / Already Purchased.
//
// "Not Qualified" queda AFUERA de todo el embudo a propósito: puede pasar
// antes o después de la reunión con la closer (confirmado con el dueño del
// negocio), así que no hay forma confiable de saber si esa persona llegó a
// mostrarse o no — mejor no contarla que contarla mal.
type Categoria = 'sin_contactar' | 'llamado' | 'agendada' | 'no_show' | 'show_sin_cierre' | 'cerrado' | 'descartado' | 'otro';
function clasificarEtapa(nombreEtapa: string): Categoria {
  const n = (nombreEtapa || '').toLowerCase().trim();
  if (n === 'new lead' || n === 'auto booked' || n === 'mensaje') return 'sin_contactar';
  if (n === 'not qualified') return 'descartado';
  if (n === 'no show') return 'no_show';
  if (n === 'appointment set') return 'agendada';
  if (n === 'closed') return 'cerrado';
  if (n === 'follow up' || n === 'already purchased') return 'show_sin_cierre';
  if (n.startsWith('called')) return 'llamado';
  return 'otro';
}

interface OpportunityGHL {
  pipelineId: string;
  pipelineStageId: string;
  lastStageChangeAt: string;
  monetaryValue?: number;
}

// Trae TODAS las oportunidades de un pipeline (paginado, 100 por página) —
// la API no deja filtrar por fecha server-side de forma confiable acá
// (un lead puede haberse creado meses antes de cerrarse), así que se trae
// todo y se filtra por lastStageChangeAt del lado del Worker. Con el
// volumen actual (~2500 oportunidades entre los 4 pipelines) son ~30
// sub-requests en total — si esto sigue creciendo y se acerca a 50 (límite
// del plan gratis de Workers), hay que sumar caché (KV + cron) en vez de
// traer todo en cada request.
async function traerOportunidadesDePipeline(env: Env, pipelineId: string): Promise<OpportunityGHL[]> {
  const todas: OpportunityGHL[] = [];
  let startAfter: string | null = null;
  let startAfterId: string | null = null;
  for (let pagina = 0; pagina < 40; pagina++) {
    let u = `${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${pipelineId}&limit=100`;
    if (startAfter && startAfterId) u += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const res = await fetch(u, { headers: ghlHeaders(env) });
    if (!res.ok) throw new Error(`opportunities_search_failed: ${await res.text()}`);
    const body = (await res.json()) as { opportunities?: OpportunityGHL[]; meta?: { nextPage?: number; startAfter?: string; startAfterId?: string } };
    const lote = body.opportunities || [];
    todas.push(...lote);
    if (!body.meta?.nextPage || !lote.length) break;
    startAfter = String(body.meta.startAfter);
    startAfterId = String(body.meta.startAfterId);
  }
  return todas;
}

async function handleLeadsSummary(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const start = parseInt(url.searchParams.get("start") || "", 10);
  const end = parseInt(url.searchParams.get("end") || "", 10);
  if (!start || !end) return json({ ok: false, error: "missing_range" }, 400, cors);

  // Mapa etapaId → nombre, para los 4 pipelines — se pide una sola vez acá
  // (no hardcodeado) así si el equipo renombra/agrega una etapa en GHL,
  // sigue funcionando sin tocar código.
  const pipeRes = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!pipeRes.ok) return json({ ok: false, error: "pipelines_failed", detail: await pipeRes.text() }, 502, cors);
  const pipeBody = (await pipeRes.json()) as { pipelines?: { id: string; stages?: { id: string; name: string }[] }[] };
  const nombreDeEtapa = new Map<string, string>();
  for (const p of pipeBody.pipelines || []) {
    for (const s of p.stages || []) nombreDeEtapa.set(s.id, s.name);
  }

  const totales = { llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0, noShows: 0, descartados: 0 };
  const porFuente: Record<string, { llamadas: number; agendadas: number; shows: number; cierres: number; ventas: number }> = {};

  // Los 4 pipelines se paginan EN PARALELO (cada uno es independiente) —
  // secuencial tardaba ~17s con el volumen actual, así queda bien por debajo
  // de eso.
  let resultadosPorPipeline: OpportunityGHL[][];
  try {
    resultadosPorPipeline = await Promise.all(PIPELINES_LEADS.map(p => traerOportunidadesDePipeline(env, p.id)));
  } catch (err) {
    return json({ ok: false, error: "opportunities_failed", detail: String(err) }, 502, cors);
  }

  PIPELINES_LEADS.forEach((pipeline, i) => {
    const fu = (porFuente[pipeline.fuente] = { llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0 });
    const oportunidades = resultadosPorPipeline[i];
    for (const o of oportunidades) {
      const cambio = Date.parse(o.lastStageChangeAt);
      if (!cambio || cambio < start || cambio >= end) continue;
      const categoria = clasificarEtapa(nombreDeEtapa.get(o.pipelineStageId) || '');
      const esLlamado = categoria === 'llamado' || categoria === 'agendada' || categoria === 'no_show' || categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const esAgendada = categoria === 'agendada' || categoria === 'no_show' || categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const esShow = categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const monto = o.monetaryValue || 0;

      if (esLlamado) { totales.llamadas++; fu.llamadas++; }
      if (esAgendada) { totales.agendadas++; fu.agendadas++; }
      if (esShow) { totales.shows++; fu.shows++; }
      if (categoria === 'cerrado') { totales.cierres++; fu.cierres++; totales.ventas += monto; fu.ventas += monto; }
      if (categoria === 'no_show') totales.noShows++;
      if (categoria === 'descartado') totales.descartados++;
    }
  });

  return json({ ok: true, totales, porFuente }, 200, cors);
}

// ===== Leads que llegan por día — se cuentan CONTACTOS nuevos (dateAdded),
// no oportunidades: la mayoría de los leads (Instagram, etc.) entran como
// contacto sin oportunidad hasta que una setter los trabaja, así que
// contar oportunidades daría muy por debajo de lo real. La lista de
// contactos viene ordenada del más nuevo al más viejo, por eso se corta la
// paginación apenas se pasa del inicio del rango (son pocas páginas). El
// día se calcula en hora de Puerto Rico (donde opera el negocio). =====
interface ContactoGHL {
  dateAdded: string;
  source?: string | null;
  attributions?: { medium?: string | null }[];
}

function origenDeContacto(c: ContactoGHL): string {
  const crudo = (c.attributions?.[0]?.medium || c.source || "").trim();
  if (!crudo) return "Otro";
  return crudo.charAt(0).toUpperCase() + crudo.slice(1).toLowerCase();
}

async function handleLeadsPorDia(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const start = parseInt(url.searchParams.get("start") || "", 10);
  const end = parseInt(url.searchParams.get("end") || "", 10);
  if (!start || !end) return json({ ok: false, error: "missing_range" }, 400, cors);

  const diaPR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" });
  const dias: Record<string, { total: number; porOrigen: Record<string, number> }> = {};
  const origenes = new Set<string>();
  let total = 0;
  let cortadoPorLimite = false;

  let startAfter: string | null = null;
  let startAfterId: string | null = null;
  for (let pagina = 0; pagina < 25; pagina++) {
    let u = `${GHL_BASE}/contacts/?locationId=${env.GHL_LOCATION_ID}&limit=100`;
    if (startAfter && startAfterId) u += `&startAfter=${startAfter}&startAfterId=${startAfterId}`;
    const res = await fetch(u, { headers: ghlHeaders(env) });
    if (!res.ok) return json({ ok: false, error: "contacts_failed", detail: await res.text() }, 502, cors);
    const body = (await res.json()) as { contacts?: ContactoGHL[]; meta?: { startAfter?: string; startAfterId?: string } };
    const lote = body.contacts || [];
    for (const c of lote) {
      const t = Date.parse(c.dateAdded);
      if (!t || t < start || t >= end) continue;
      const dia = diaPR.format(new Date(t));
      const origen = origenDeContacto(c);
      origenes.add(origen);
      const d = (dias[dia] = dias[dia] || { total: 0, porOrigen: {} });
      d.total++;
      d.porOrigen[origen] = (d.porOrigen[origen] || 0) + 1;
      total++;
    }
    const ultimo = lote.length ? Date.parse(lote[lote.length - 1].dateAdded) : 0;
    if (!lote.length || !body.meta?.startAfter || ultimo < start) break;
    if (pagina === 24) cortadoPorLimite = true;
    startAfter = String(body.meta.startAfter);
    startAfterId = String(body.meta.startAfterId);
  }

  return json({ ok: true, total, dias, origenes: [...origenes].sort(), cortadoPorLimite }, 200, cors);
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
      if (url.pathname === "/leads-summary" && request.method === "GET") {
        return await handleLeadsSummary(url, env, cors);
      }
      if (url.pathname === "/leads-por-dia" && request.method === "GET") {
        return await handleLeadsPorDia(url, env, cors);
      }
    } catch (err) {
      return json({ ok: false, error: "unexpected", detail: String(err) }, 500, cors);
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};
