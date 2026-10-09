// Intermediario entre calendario.html y la API de GHL. Guarda la Private
// Integration key como secret (nunca en el repo) y expone dos rutas simples
// para que el front no tenga que hablar con GHL directamente.

export interface Env {
  GHL_API_KEY: string;
  GHL_LOCATION_ID: string;
  GHL_CALENDAR_ID: string;
  ALLOWED_ORIGINS: string;
  VIDEOS: R2Bucket;
  // Secrets (se cargan con `npx wrangler secret put ...`, nunca van en el repo)
  OPENAI_API_KEY: string;
  ADMIN_KEY: string;
  SITE_KEY: string; // contraseña de la plataforma (para los recursos privados)
  OPENAI_MODEL: string;
  ESTRATEGIAS: KVNamespace; // ejemplos reales de estrategias (privados)
}

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

function corsHeaders(origin: string | null, env: Env): HeadersInit {
  const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  const allowOrigin = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Key, X-Site-Key",
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
  data: { firstName: string; lastName: string; email: string; phone: string; timezone?: string }
): Promise<string> {
  const pedir = (timezone?: string) =>
    fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        locationId: env.GHL_LOCATION_ID,
        firstName: data.firstName,
        lastName: data.lastName,
        email: data.email || undefined,
        phone: data.phone || undefined,
        timezone,
      }),
    });
  // La zona horaria del lead queda en su ficha (los mails/recordatorios de
  // GHL la usan). Si GHL rechazara el campo, se reintenta sin él: nunca debe
  // impedir la reserva.
  let res = await pedir(data.timezone);
  if (!res.ok && data.timezone) res = await pedir(undefined);
  if (!res.ok) {
    throw new Error(`upsert_contact_failed: ${await res.text()}`);
  }
  const body = (await res.json()) as { contact?: { id?: string } };
  const id = body.contact?.id;
  if (!id) throw new Error("upsert_contact_no_id");
  return id;
}

function zonaValida(tz?: string): string | undefined {
  if (!tz || typeof tz !== "string" || tz.length > 64) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return tz;
  } catch {
    return undefined;
  }
}

// País y zona horaria desde la IP con la que llega la persona — Cloudflare
// los calcula en el borde, así que si usa VPN se ve la salida de la VPN.
// Lo usan index.html (código de país del celular) y calendario.html
// (mostrar los horarios en su zona).
function handleGeo(request: Request, cors: HeadersInit): Response {
  const cf = ((request as unknown as { cf?: Record<string, string> }).cf) || {};
  return json({ ok: true, country: cf.country || null, timezone: cf.timezone || null, city: cf.city || null }, 200, cors);
}

async function handleBook(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let payload: {
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    startTime?: string;
    timezone?: string;
    utm_source?: string;
    utm_medium?: string;
    utm_campaign?: string;
    utm_content?: string;
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
      timezone: zonaValida(payload.timezone),
    });
  } catch (err) {
    return json({ ok: false, error: "contact_failed", detail: String(err) }, 502, cors);
  }

  // Atribución: de qué link/anuncio vino. Si falla NO rompe la reserva.
  let atribucion = "sin_utm";
  try {
    atribucion = await etiquetarAtribucion(env, contactId, payload);
  } catch (err) {
    atribucion = "error";
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
  return json({ ok: true, appointment: appt, opportunity: oportunidad, atribucion }, 200, cors);
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
  contact?: { tags?: string[] };
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
  // Desglose por UTM (etiquetas del contacto). "" = sin UTM.
  type FilaUtm = { llamadas: number; agendadas: number; shows: number; cierres: number; ventas: number };
  const utm: Record<"src" | "med" | "camp" | "cont", Record<string, FilaUtm>> = { src: {}, med: {}, camp: {}, cont: {} };
  const sumar = (dim: "src" | "med" | "camp" | "cont", clave: string, v: { ll: boolean; ag: boolean; sh: boolean; ci: boolean; monto: number }) => {
    const f = (utm[dim][clave] = utm[dim][clave] || { llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0 });
    if (v.ll) f.llamadas++;
    if (v.ag) f.agendadas++;
    if (v.sh) f.shows++;
    if (v.ci) { f.cierres++; f.ventas += v.monto; }
  };
  let conTags = 0, sinTags = 0;

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

      if (esLlamado || esAgendada || esShow || categoria === 'cerrado') {
        const atr = atribucionDeTags(o.contact?.tags);
        if (o.contact?.tags) conTags++; else sinTags++;
        const v = { ll: esLlamado, ag: esAgendada, sh: esShow, ci: categoria === 'cerrado', monto };
        (["src", "med", "camp", "cont"] as const).forEach((d) => sumar(d, atr[d], v));
      }
      if (esLlamado) { totales.llamadas++; fu.llamadas++; }
      if (esAgendada) { totales.agendadas++; fu.agendadas++; }
      if (esShow) { totales.shows++; fu.shows++; }
      if (categoria === 'cerrado') { totales.cierres++; fu.cierres++; totales.ventas += monto; fu.ventas += monto; }
      if (categoria === 'no_show') totales.noShows++;
      if (categoria === 'descartado') totales.descartados++;
    }
  });

  return json({ ok: true, totales, porFuente, utm, utmDiagnostico: { conTags, sinTags } }, 200, cors);
}

// ===== Funnel día a día — mismo criterio que handleLeadsSummary (last
// stage change dentro del rango, clasificarEtapa por nombre), pero
// agrupado por día en vez de sumado en un solo total. Sirve para el
// gráfico de tendencia diaria del funnel en "Vista General". El día se
// calcula con el último cambio de etapa, no con la fecha de creación:
// una oportunidad que se agendó el día 3 pero cerró el día 20 cuenta
// como "cierre" el día 20 (no el 3), consistente con cómo ya se arma
// el resto del dashboard. =====
async function handleFunnelPorDia(url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const start = parseInt(url.searchParams.get("start") || "", 10);
  const end = parseInt(url.searchParams.get("end") || "", 10);
  if (!start || !end) return json({ ok: false, error: "missing_range" }, 400, cors);

  const pipeRes = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!pipeRes.ok) return json({ ok: false, error: "pipelines_failed", detail: await pipeRes.text() }, 502, cors);
  const pipeBody = (await pipeRes.json()) as { pipelines?: { id: string; stages?: { id: string; name: string }[] }[] };
  const nombreDeEtapa = new Map<string, string>();
  for (const p of pipeBody.pipelines || []) {
    for (const s of p.stages || []) nombreDeEtapa.set(s.id, s.name);
  }

  const diaPR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" });
  type Fila = { llamadas: number; agendadas: number; shows: number; cierres: number; ventas: number };
  const filaVacia = (): Fila => ({ llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0 });
  const dias: Record<string, Fila & { porFuente: Record<string, Fila> }> = {};
  const totales = filaVacia();

  let resultadosPorPipeline: OpportunityGHL[][];
  try {
    resultadosPorPipeline = await Promise.all(PIPELINES_LEADS.map(p => traerOportunidadesDePipeline(env, p.id)));
  } catch (err) {
    return json({ ok: false, error: "opportunities_failed", detail: String(err) }, 502, cors);
  }

  PIPELINES_LEADS.forEach((pipeline, i) => {
    for (const o of resultadosPorPipeline[i]) {
      const cambio = Date.parse(o.lastStageChangeAt);
      if (!cambio || cambio < start || cambio >= end) continue;
      const categoria = clasificarEtapa(nombreDeEtapa.get(o.pipelineStageId) || '');
      const esLlamado = categoria === 'llamado' || categoria === 'agendada' || categoria === 'no_show' || categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const esAgendada = categoria === 'agendada' || categoria === 'no_show' || categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const esShow = categoria === 'show_sin_cierre' || categoria === 'cerrado';
      const monto = o.monetaryValue || 0;

      const dia = diaPR.format(new Date(cambio));
      if (!dias[dia]) dias[dia] = { ...filaVacia(), porFuente: {} };
      const d = dias[dia];
      if (!d.porFuente[pipeline.fuente]) d.porFuente[pipeline.fuente] = filaVacia();
      const f = d.porFuente[pipeline.fuente];

      if (esLlamado) { d.llamadas++; f.llamadas++; totales.llamadas++; }
      if (esAgendada) { d.agendadas++; f.agendadas++; totales.agendadas++; }
      if (esShow) { d.shows++; f.shows++; totales.shows++; }
      if (categoria === 'cerrado') { d.cierres++; f.cierres++; d.ventas += monto; f.ventas += monto; totales.cierres++; totales.ventas += monto; }
    }
  });

  return json({ ok: true, dias, totales, fuentes: PIPELINES_LEADS.map(p => p.fuente) }, 200, cors);
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
  tags?: string[];
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
  const utmLeads: Record<"src" | "camp" | "cont", Record<string, number>> = { src: {}, camp: {}, cont: {} };
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
      const atr = atribucionDeTags(c.tags);
      (["src", "camp", "cont"] as const).forEach((k) => { utmLeads[k][atr[k]] = (utmLeads[k][atr[k]] || 0) + 1; });
      total++;
    }
    const ultimo = lote.length ? Date.parse(lote[lote.length - 1].dateAdded) : 0;
    if (!lote.length || !body.meta?.startAfter || ultimo < start) break;
    if (pagina === 24) cortadoPorLimite = true;
    startAfter = String(body.meta.startAfter);
    startAfterId = String(body.meta.startAfterId);
  }

  return json({ ok: true, total, dias, origenes: [...origenes].sort(), utmLeads, cortadoPorLimite }, 200, cors);
}

// ===== Videos servidos desde R2 (reemplaza a Bunny CDN — mismo archivo,
// sin costo de ancho de banda). Range requests soportados de verdad
// (no solo "Accept-Ranges: bytes" de mentira): sin esto el video no
// puede saltar/buscar, se ve en el navegador como si no fuera seekable. =====
function parseRangeHeader(rangeHeader: string | null, size: number): { offset: number; length: number } | null {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m) return null;
  const [, startStr, endStr] = m;
  if (startStr === "" && endStr === "") return null;
  let start: number, end: number;
  if (startStr === "") {
    const suffixLength = parseInt(endStr, 10);
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === "" ? size - 1 : Math.min(parseInt(endStr, 10), size - 1);
  }
  if (isNaN(start) || isNaN(end) || start > end || start >= size) return null;
  return { offset: start, length: end - start + 1 };
}

async function handleVideoGet(request: Request, env: Env, key: string, cors: HeadersInit): Promise<Response> {
  const head = await env.VIDEOS.head(key);
  if (!head) return json({ ok: false, error: "not_found" }, 404, cors);

  const range = parseRangeHeader(request.headers.get("Range"), head.size);
  const obj = range ? await env.VIDEOS.get(key, { range }) : await env.VIDEOS.get(key);
  if (!obj) return json({ ok: false, error: "not_found" }, 404, cors);

  const headers = new Headers(cors);
  obj.writeHttpMetadata(headers);
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "public, max-age=31536000, immutable");
  headers.set("ETag", obj.httpEtag);

  if (range) {
    headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`);
    headers.set("Content-Length", String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(head.size));
  return new Response(obj.body, { status: 200, headers });
}


// --- Estrategias: genera el borrador con OpenAI ---------------------------
// La clave de OpenAI vive solo acá (secret del Worker). Solo puede llamar
// quien manda la clave de admin correcta en el header X-Admin-Key.
function igualesSeguro(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Las 8 secciones de la estrategia, con la estructura de la plantilla de Gianie.
// Cada una se genera por separado (así se puede rehacer una sola).
const SECCIONES: Record<string, { titulo: string; estructura: string }> = {
  punto: {
    titulo: "1. Punto de partida",
    estructura: `### Resumen del diagnóstico: estado actual (etapa del negocio, ingresos, clientas o ventas, seguidores), el problema raíz de comunicación o de percepción de valor, y qué frena más las ventas. Cierra con una tabla de una sola celda titulada "Diagnóstico clave".
### Tu meta principal a 12 meses: meta clara y con números (facturación, seguidores, clientas por mes), más una tabla "Meta | Resultado esperado" con filas de marca personal, contenido, embudo, publicidad y confianza.
### Análisis SWOT estratégico: tabla de dos columnas Fortalezas | Debilidades, y otra Oportunidades | Amenazas.`,
  },
  marca: {
    titulo: "2. Fundamento de marca",
    estructura: `### Tu clienta ideal: "[nombre de arquetipo]": tabla "Dimensión | Tu clienta ideal" con las filas Quién es (edad, profesión, ubicación, ingresos, etapa de vida), Qué le duele (3 frustraciones), Qué desea (3 aspiraciones), Dónde está (plataformas, horarios, contenido que sigue), Qué la frena (objeción raíz).
### Tu posicionamiento: 2 o 3 oraciones: a quién ayuda, qué problema resuelve y cómo lo hace distinto.
### Tu propuesta de valor: "Lo que ofreces" (qué es exactamente, rango de precio, tiempos) y "Lo que te diferencia" con 3 puntos que empiezan con ✓.
### La psicología maestra de tu contenido: las ideas psicológicas que mueven a su clienta ideal y cómo se aplican en su contenido.`,
  },
  perfil: {
    titulo: "3. Perfil de Instagram: la vitrina de venta",
    estructura: `### Qué depurar y arreglar del perfil actual: solo si hay datos del perfil en las respuestas; si no los hay, déjalo fuera.
### Tu bio optimizada: Opción 1, Opción 2 y Opción 3, y una "Palabra clave" (UNA sola palabra).
### Tus 3 publicaciones pineadas: tabla "Pineada | Qué es y por qué": #1 Quién eres (video donde sale ella, prioridad semana 1), #2 Prueba social, #3 Tu oferta (con la palabra clave).
### Tus historias destacadas: tabla de 6: Empieza aquí, Resultados, Servicios, Proceso, Preguntas, Mi vida, adaptadas a su negocio.`,
  },
  contenido: {
    titulo: "4. Pilar 1: contenido orgánico",
    estructura: `### Data que funciona hoy: estos 6 puntos, tal cual: Reels de 15 a 30 segundos tienen la mejor interacción y pasados 90 segundos cae fuerte; 85% se ve sin sonido, así que subtítulos siempre; el algoritmo premia guardados, compartidos por DM y tiempo de visualización; el contenido detrás de cámaras rinde 34% más que el promocional; un caption con CTA sube la interacción 42%; los Reels constantes crecen 25% más rápido.
### La regla de contenido: una regla simple y propia de su negocio.
### Tus pilares de contenido: tabla "Pilar | Objetivo | Temas" con Autoridad, Conexión, Prueba y Venta, con temas concretos de su nicho.
### Tu frecuencia de publicación: nivel recomendado según su meta y tiempo, y tabla de los niveles 1 (mantener, 3 Reels por semana), 2 (crecer, 5 Reels por semana) y 3 (acelerar, 7 a 14).
### Tu secuencia diaria de historias: humaniza, valor, proceso, interacción y CTA suave, con ejemplos de su negocio.
### Los 4 frameworks de creación: guion hablado (hook 0-3 s, desarrollo, valor, cierre, CTA), b-roll con texto, historia de vida (antes, quiebre, decisión, hoy, lección, CTA suave) y anuncio (hook, problema, solución, prueba, CTA único), cada uno con un ejemplo aplicado a su caso.
### Banco de ideas probadas: ideas para Atraer, Confianza, Comunidad, Conectar y Vender.
### 10 ideas personalizadas de alto impacto: lista numerada con ideas muy concretas para su nicho.`,
  },
  ads: {
    titulo: "5. Pilar 2: Meta Ads",
    estructura: `### La campaña única: objetivo (mensajes de WhatsApp, prospectos o conversiones), presupuesto por mes (mes 1, mes 2, mes 3 en adelante), público (demografía, intereses, comportamientos) y CTA.
### La mecánica: el recorrido paso a paso desde el anuncio hasta la venta.
### Los 5 ángulos de venta + psicología: tabla "Ángulo | Descripción", cada uno con nombre, hook, problema, solución, CTA y mensaje precompilado.
### Respuestas de WhatsApp + cómo cerrar: respuesta en menos de 1 hora y preguntas de calificación.
### A/B testing: cómo identificar el ganador.
### Métricas a vigilar: CPM $5-15, CPC $0.50-1.50, CTR 2-5%, tasa de conversión 8-15%.
### Presupuesto y timeline según meta: tabla "Mes | Presupuesto | Objetivo" con mes 1 (testing), mes 2 (escala) y mes 3 en adelante (optimizar).
### Red flags: señales de que algo falla y qué ajustar.`,
  },
  embudo: {
    titulo: "6. Pilar 3: tu embudo de venta",
    estructura: `### Las 5 etapas del embudo: tabla "Etapa | Qué pasa | Herramienta | Métrica" con Descubrimiento, Conexión, Confianza, Conversión y Fidelización, adaptadas a su negocio.
### Tu punto de conversión: dónde y cómo se cierra la venta en su caso.
### Lead magnets para convertir contenido en prospectos: 2 o 3 ideas concretas.
### Qué montar en orden: pasos numerados.`,
  },
  plan: {
    titulo: "7. Tu plan de 90 días",
    estructura: `### Timeline mensual: tabla "Mes | Enfoque | Acciones | Meta" para los meses 1, 2 y 3, con metas con números.
### Plan semanal de ejecución - Mes 1: semana 1 (fundamento), semana 2 (vitrina visual), semana 3 (contenido orgánico), semana 4 (primera pauta), cada una con su checklist y las preguntas para revisar si algo falla.
### Tus próximos pasos inmediatos: lista corta y concreta.
### Guiones listos para grabar esta semana: 2 o 3 guiones completos para su nicho.`,
  },
  cierre: {
    titulo: "8. Cierre estratégico",
    estructura: `Un párrafo breve que le habla directamente por su nombre y resume cómo se va a construir su marca, y una tabla de una sola celda titulada "Tu nueva promesa de marca". Termina con las líneas: **Step Her Up**, Consultoría de posicionamiento y monetización, **Sanar · Creer · Conquistar**.`,
  },
};

async function handleEstrategiaGenerar(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  if (!env.ADMIN_KEY || !env.OPENAI_API_KEY) {
    return json({ ok: false, error: "not_configured" }, 503, cors);
  }
  const clave = request.headers.get("X-Admin-Key") || "";
  if (!igualesSeguro(clave, env.ADMIN_KEY)) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }
  let body: { seccion?: string; prompt?: string; respuestas?: string; contexto?: string; instruccion?: string; textoActual?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "bad_json" }, 400, cors);
  }
  const sec = SECCIONES[body.seccion || ""];
  const prompt = (body.prompt || "").trim();
  const respuestas = (body.respuestas || "").trim();
  const contexto = (body.contexto || "").trim();
  const instruccion = (body.instruccion || "").trim();
  const textoActual = (body.textoActual || "").trim();
  if (!sec) return json({ ok: false, error: "bad_section" }, 400, cors);
  if (!prompt || !respuestas) return json({ ok: false, error: "missing_fields" }, 400, cors);
  if (prompt.length > 20000 || respuestas.length > 30000 || contexto.length > 30000 || textoActual.length > 30000 || instruccion.length > 2000) {
    return json({ ok: false, error: "too_long" }, 413, cors);
  }

  const ejemplo = env.ESTRATEGIAS ? await env.ESTRATEGIAS.get("ejemplo:" + body.seccion) : null;
  let sistema = prompt
    + `\n\nAhora escribes SOLO esta sección de la estrategia: "${sec.titulo}". Empieza con el título exacto en una línea "## ${sec.titulo}". Usa Markdown: "### " para subtítulos, ** para negritas, "- " para listas y tablas con barras verticales (| col | col |) donde la estructura las pide.`
    + `\n\nEstructura obligatoria de la sección:\n${sec.estructura}`;
  if (ejemplo) {
    sistema += `\n\nEjemplo real de cómo Gianie escribió esta misma sección para OTRA alumna. Imita su nivel de detalle, su formato (tablas incluidas) y su tono. NO copies sus datos, frases ni casos: todo lo que escribas debe salir de las respuestas de esta alumna.\n<ejemplo>\n${ejemplo}\n</ejemplo>`;
  }
  let usuario = "Respuestas del formulario de la alumna:\n\n" + respuestas;
  if (contexto) usuario += "\n\nSecciones ya escritas de esta misma estrategia (mantén coherencia con ellas):\n\n" + contexto;
  if (textoActual && instruccion) {
    usuario += "\n\nTexto actual de esta sección:\n\n" + textoActual
      + "\n\nInstrucción de Gianie para esta versión: " + instruccion
      + "\nReescribe la sección completa aplicando la instrucción y conservando lo que no se pidió cambiar.";
  } else if (instruccion) {
    usuario += "\n\nIndicación extra de Gianie para esta sección: " + instruccion;
  }

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1",
      messages: [
        { role: "system", content: sistema },
        { role: "user", content: usuario },
      ],
    }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) {
    return json({ ok: false, error: "openai_error", status: r.status, detail: data?.error?.message || "" }, 502, cors);
  }
  const texto = data?.choices?.[0]?.message?.content || "";
  return json({ ok: true, seccion: body.seccion, texto }, 200, cors);
}

// --- Registro al webinar (landing webinar.html) -----------------------------
// Guarda a cada inscripta como contacto de GHL con la etiqueta del webinar y
// la fuente, sin crear oportunidades (no ensucia las métricas del funnel).
// Después la landing la manda al grupo de WhatsApp: si este endpoint falla,
// igual la dejan pasar y se reintenta después desde el navegador.
const EVENTO_WEBINAR = { tag: "webinar-21-oct", fuente: "Webinar 21 oct" };

function slugTag(prefijo: string, valor: unknown, largo = 40): string | null {
  const v = String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, largo);
  return v ? `${prefijo}-${v}` : null;
}

// ===== Atribución (UTMs) =====
// Cada lead lleva las UTMs del link por el que entró (landing → formulario →
// calendario). Se guardan en su ficha de GHL como etiquetas: src-<fuente>,
// med-<medio>, camp-<campaña>, cont-<anuncio o setter>. El dashboard cuenta
// agendas, shows y cierres por esas etiquetas. Gana el PRIMER toque: si el
// contacto ya tiene src-/camp-, no se le suman otras (así no cuenta doble).
type UtmPayload = { utm_source?: unknown; utm_medium?: unknown; utm_campaign?: unknown; utm_content?: unknown };

function utmTags(p: UtmPayload): string[] {
  return [
    slugTag("src", p.utm_source, 40),
    slugTag("med", p.utm_medium, 40),
    slugTag("camp", p.utm_campaign, 70),
    slugTag("cont", p.utm_content, 70),
  ].filter(Boolean) as string[];
}

async function etiquetarAtribucion(env: Env, contactId: string, p: UtmPayload): Promise<string> {
  const tags = utmTags(p);
  if (!tags.length) return "sin_utm";
  const actual = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders(env) });
  if (actual.ok) {
    const cuerpo = (await actual.json()) as { contact?: { tags?: string[] } };
    if ((cuerpo.contact?.tags || []).some((t) => /^(src|camp)-/.test(t))) return "ya_tenia";
  }
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ tags }),
  });
  return res.ok ? "etiquetado" : `error_${res.status}`;
}

// Etiqueta a un lead apenas pasa por la landing (aunque todavía no agende).
async function handleAtribucion(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let p: Record<string, unknown>;
  try {
    p = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }
  const nombre = String(p.nombre || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(p.email || "").trim().toLowerCase().slice(0, 120);
  const telefono = String(p.telefono || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (!utmTags(p).length || (!email && !telefono)) return json({ ok: true, resultado: "nada_para_hacer" }, 200, cors);
  const partes = (nombre || "Lead").split(" ");
  try {
    const id = await upsertContact(env, { firstName: partes[0], lastName: partes.slice(1).join(" "), email, phone: telefono });
    return json({ ok: true, resultado: await etiquetarAtribucion(env, id, p) }, 200, cors);
  } catch (err) {
    return json({ ok: false, error: "atribucion_failed", detail: String(err).slice(0, 200) }, 502, cors);
  }
}

// ===== Rastreo de clics (para cuando el funnel va dentro de un iframe de
// ClickFunnels, que no le pasa las UTMs del link a la página embebida).
// Los links de anuncios/DMs apuntan a /go?utm_...: se guarda de qué UTM
// vino la visita (con una huella irreconocible de IP + navegador, 6 horas)
// y se la manda a la landing. Cuando la landing carga dentro del iframe, le
// pregunta a /click-match con la misma huella y recupera las UTMs. =====
const DESTINO_FUNNEL = "https://class.stepherup.com/step-her-up-c";
const UTM_CLAVES = ["utm_source", "utm_medium", "utm_campaign", "utm_content"] as const;

async function huellaVisita(request: Request): Promise<string> {
  const ip = request.headers.get("CF-Connecting-IP") || "";
  const ua = request.headers.get("User-Agent") || "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`shu|${ip}|${ua}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

// Anota de qué UTM vino esta visita (misma huella IP + navegador).
async function registrarClic(request: Request, url: URL, env: Env): Promise<URL> {
  const utm: Record<string, string> = {};
  const destino = new URL(DESTINO_FUNNEL);
  for (const k of UTM_CLAVES) {
    const v = (url.searchParams.get(k) || "").trim().slice(0, 150);
    if (v) { utm[k] = v; destino.searchParams.set(k, v); }
  }
  // Los robots de vista previa (Meta, WhatsApp...) también abren el link: no cuentan.
  const ua = request.headers.get("User-Agent") || "";
  const esRobot = /bot|crawler|spider|facebookexternalhit|facebot|preview|slurp|whatsapp|telegram/i.test(ua);
  if (!esRobot && Object.keys(utm).length) {
    await env.ESTRATEGIAS.put(`click:${await huellaVisita(request)}`, JSON.stringify(utm), { expirationTtl: 21600 });
  }
  return destino;
}

// Link directo (con el dominio del Worker): anota y redirige.
async function handleGo(request: Request, url: URL, env: Env): Promise<Response> {
  const destino = await registrarClic(request, url, env);
  return new Response(null, { status: 302, headers: { Location: destino.toString(), "Cache-Control": "no-store" } });
}

// La página dash.stepherup.com/go lo llama desde el navegador y después redirige ella.
async function handleClic(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  await registrarClic(request, url, env);
  return new Response(null, { status: 204, headers: { ...cors, "Cache-Control": "no-store" } });
}

async function handleClickMatch(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const guardado = await env.ESTRATEGIAS.get(`click:${await huellaVisita(request)}`);
  let utm: Record<string, string> | null = null;
  try { utm = guardado ? JSON.parse(guardado) : null; } catch { utm = null; }
  return json({ ok: true, utm }, 200, { ...cors, "Cache-Control": "no-store" });
}

// Cuenta por etiquetas de atribución: { fuente, medio, campana, contenido }.
function atribucionDeTags(tags: string[] | undefined): { src: string; med: string; camp: string; cont: string } {
  const out = { src: "", med: "", camp: "", cont: "" };
  for (const t of tags || []) {
    const m = /^(src|med|camp|cont)-(.+)$/.exec(t);
    if (m && !out[m[1] as "src"]) out[m[1] as "src"] = m[2];
  }
  return out;
}

async function handleWebinarRegistro(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let p: Record<string, unknown>;
  try {
    p = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }
  // Campo trampa para bots: las personas no lo ven ni lo completan.
  if (p.website) return json({ ok: true }, 200, cors);

  const nombre = String(p.nombre || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(p.email || "").trim().toLowerCase().slice(0, 120);
  const telefono = String(p.telefono || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (nombre.length < 2) return json({ ok: false, error: "nombre_invalido" }, 400, cors);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: "email_invalido" }, 400, cors);
  if (telefono.replace(/\D/g, "").length < 7) return json({ ok: false, error: "telefono_invalido" }, 400, cors);

  const partes = nombre.split(" ");
  const tags = [EVENTO_WEBINAR.tag, ...utmTags(p)];
  const pedir = (timezone?: string) =>
    fetch(`${GHL_BASE}/contacts/upsert`, {
      method: "POST",
      headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        locationId: env.GHL_LOCATION_ID,
        firstName: partes[0],
        lastName: partes.slice(1).join(" "),
        email,
        phone: telefono,
        tags,
        source: EVENTO_WEBINAR.fuente,
        timezone,
      }),
    });
  const tz = zonaValida(typeof p.timezone === "string" ? p.timezone : undefined);
  let res = await pedir(tz);
  if (!res.ok && tz) res = await pedir(undefined);
  if (!res.ok) {
    return json({ ok: false, error: "ghl_failed", detail: (await res.text()).slice(0, 300) }, 502, cors);
  }
  const body = (await res.json()) as { contact?: { id?: string } };
  return json({ ok: true, id: body.contact?.id || null }, 200, cors);
}

// --- Recursos privados (presentaciones) ---------------------------------------
// Se guardan en el KV (no en el repo, que es público) y solo se entregan a
// quien manda la contraseña de la plataforma en el header X-Site-Key.
async function handleRecurso(request: Request, env: Env, id: string, cors: HeadersInit): Promise<Response> {
  if (!env.SITE_KEY) return json({ ok: false, error: "not_configured" }, 503, cors);
  const clave = request.headers.get("X-Site-Key") || "";
  if (!igualesSeguro(clave, env.SITE_KEY)) return json({ ok: false, error: "unauthorized" }, 401, cors);
  if (!/^[a-z0-9-]{1,40}$/.test(id)) return json({ ok: false, error: "not_found" }, 404, cors);
  const html = await env.ESTRATEGIAS.get("recurso:" + id);
  if (!html) return json({ ok: false, error: "not_found" }, 404, cors);
  return new Response(html, {
    status: 200,
    headers: { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
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
      if (url.pathname === "/geo" && request.method === "GET") {
        return handleGeo(request, cors);
      }
      if (url.pathname === "/leads-por-dia" && request.method === "GET") {
        return await handleLeadsPorDia(url, env, cors);
      }
      if (url.pathname === "/funnel-por-dia" && request.method === "GET") {
        return await handleFunnelPorDia(url, env, cors);
      }
      if (url.pathname.startsWith("/recursos/") && request.method === "GET") {
        return await handleRecurso(request, env, decodeURIComponent(url.pathname.slice("/recursos/".length)), cors);
      }
      if (url.pathname === "/go" && (request.method === "GET" || request.method === "HEAD")) {
        return await handleGo(request, url, env);
      }
      if (url.pathname === "/click" && request.method === "GET") {
        return await handleClic(request, url, env, cors);
      }
      if (url.pathname === "/click-match" && request.method === "GET") {
        return await handleClickMatch(request, env, cors);
      }
      if (url.pathname === "/atribucion" && request.method === "POST") {
        return await handleAtribucion(request, env, cors);
      }
      if (url.pathname === "/webinar-registro" && request.method === "POST") {
        return await handleWebinarRegistro(request, env, cors);
      }
      if (url.pathname === "/estrategia/generar" && request.method === "POST") {
        return await handleEstrategiaGenerar(request, env, cors);
      }
      if (url.pathname.startsWith("/videos/") && (request.method === "GET" || request.method === "HEAD")) {
        return await handleVideoGet(request, env, decodeURIComponent(url.pathname.slice("/videos/".length)), cors);
      }
    } catch (err) {
      return json({ ok: false, error: "unexpected", detail: String(err) }, 500, cors);
    }

    return json({ ok: false, error: "not_found" }, 404, cors);
  },
};
