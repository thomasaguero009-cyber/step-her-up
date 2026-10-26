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
  STRIPE_WEBHOOK_SECRET?: string; // clave de firma del webhook de Stripe (whsec_...)
  OPENAI_MODEL: string;
  ESTRATEGIAS: KVNamespace; // ejemplos reales de estrategias (privados)
  EMAIL_HOOK_KEY?: string; // clave del webhook de eventos de email de GHL (secret)
  SLACK_BOT_TOKEN?: string; // bot de Slack para el recordatorio diario de #setters (secret)
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
  // Si vino con UTMs, la oportunidad nace con el origen legible: "facebook · cpc · campaña · anuncio".
  const origenTxt = [payload.utm_source, payload.utm_medium, payload.utm_campaign, payload.utm_content]
    .map((v) => String(v || "").trim().slice(0, 60)).filter(Boolean).join(" · ");
  const oportunidad = await ponerEnAutoBooked(env, contactId, `${firstName} ${lastName || ""}`.trim(), origenTxt || "Calendario landing");
  // Si venía del webinar (tiene la etiqueta), también avanza en el pipeline del webinar.
  let webinar: { accion: string; detail?: string } | null = null;
  if (await contactoTieneTag(env, contactId, EVENTO_WEBINAR.tag)) {
    webinar = await oportunidadWebinar(env, contactId, `${firstName} ${lastName || ""}`.trim(), "agendo");
  }
  return json({ ok: true, appointment: appt, opportunity: oportunidad, atribucion, webinar }, 200, cors);
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

async function ponerEnAutoBooked(env: Env, contactId: string, nombre: string, origen = "Calendario landing"): Promise<{ accion: string; detail?: string }> {
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
          source: origen,
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
  createdAt?: string;
  contact?: { tags?: string[] };
}

// Monto de ajuste manual del webinar para el mes que empieza en `inicio` (ms). null = sin ajuste.
async function ajusteWebinar(env: Env, inicio: number): Promise<number | null> {
  const mes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" }).format(new Date(inicio)).slice(0, 7);
  try {
    const v = await env.ESTRATEGIAS.get(`ajuste:webinar:${mes}`, "json") as { ventas?: number } | null;
    return v && typeof v.ventas === "number" ? v.ventas : null;
  } catch { return null; }
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

// ===== Resumen del webinar (pestaña "Webinar" del dashboard) — sale del pipeline
// "STEP HER UP - WEBINAR": una oportunidad por inscripta, la etapa dice si asistió, no asistió o agendó, y
// las etiquetas del contacto dicen por cuál landing (lp-) y de qué fuente (src-) llegó. =====
async function handleWebinarResumen(env: Env, cors: HeadersInit): Promise<Response> {
  const pw = await pipelineWebinar(env);
  if (!pw) return json({ ok: false, error: "pipeline_not_found" }, 404, cors);
  let ops: OpportunityGHL[];
  try {
    ops = await traerOportunidadesDePipeline(env, pw.id);
  } catch (err) {
    return json({ ok: false, error: "opportunities_failed", detail: String(err) }, 502, cors);
  }
  const nombreEtapa = new Map(pw.etapas.map((e) => [e.id, e.name]));
  const etapas = pw.etapas.map((e) => ({ nombre: e.name, cantidad: 0 }));
  const landings: Record<string, number> = {};
  const porFuente: Record<string, number> = {};
  const porDia: Record<string, number> = {};
  const diaPR = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" });
  for (const o of ops) {
    const e = etapas.find((x) => x.nombre === nombreEtapa.get(o.pipelineStageId));
    if (e) e.cantidad++;
    const tags = o.contact?.tags || [];
    const lp = tags.find((t) => t.startsWith("lp-"));
    const clave = lp ? lp.slice(3) : "";
    landings[clave] = (landings[clave] || 0) + 1;
    const src = atribucionDeTags(tags).src;
    porFuente[src] = (porFuente[src] || 0) + 1;
    const creada = Date.parse(o.createdAt || "");
    if (creada) {
      const d = diaPR.format(new Date(creada));
      porDia[d] = (porDia[d] || 0) + 1;
    }
  }
  return json({ ok: true, total: ops.length, etapas, landings, porFuente, porDia }, 200, cors);
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

  const totales = { llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0, noShows: 0, descartados: 0, cierresWebinar: 0, ventasWebinar: 0 };
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

  // Ventas del webinar ($997 y upsell): viven en el pipeline "STEP HER UP - WEBINAR", que no está en
  // PIPELINES_LEADS. Solo se suman los cierres (etapas "Closed ..."), no llamadas ni agendadas, y se
  // pide cada etapa Closed por separado para no paginar las ~900 oportunidades del pipeline.
  try {
    const pw = await pipelineWebinar(env);
    if (pw) {
      const fu = (porFuente["Webinar"] = { llamadas: 0, agendadas: 0, shows: 0, cierres: 0, ventas: 0 });
      for (const etapa of pw.etapas.filter((e) => /^closed/i.test(e.name.trim()))) {
        const res = await fetch(`${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${pw.id}&pipeline_stage_id=${etapa.id}&limit=100`, { headers: ghlHeaders(env) });
        if (!res.ok) continue;
        const lote = ((await res.json()) as { opportunities?: OpportunityGHL[] }).opportunities || [];
        for (const o of lote) {
          const cambio = Date.parse(o.lastStageChangeAt);
          if (!cambio || cambio < start || cambio >= end) continue;
          const monto = o.monetaryValue || 0;
          const atr = atribucionDeTags(o.contact?.tags);
          if (o.contact?.tags) conTags++; else sinTags++;
          (["src", "med", "camp", "cont"] as const).forEach((d) => sumar(d, atr[d], { ll: false, ag: false, sh: false, ci: true, monto }));
          totales.cierresWebinar++; fu.cierres++; totales.ventasWebinar += monto; fu.ventas += monto;
        }
      }
    }
  } catch { /* si falla el webinar, el resto del resumen sigue igual */ }

  // Ajuste manual de lo cobrado en el webinar (KV "ajuste:webinar:AAAA-MM", {"ventas": número}). Se usa mientras GHL
  // tenga montos que no coinciden con Stripe; si no existe la clave, manda lo que diga GHL.
  const ajuste = await ajusteWebinar(env, start);
  if (ajuste !== null) {
    totales.ventasWebinar = ajuste;
    if (porFuente["Webinar"]) porFuente["Webinar"].ventas = ajuste;
  }

  return json({ ok: true, totales, porFuente, utm, utmDiagnostico: { conTags, sinTags }, ajusteWebinar: ajuste !== null }, 200, cors);
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

  // Ventas del webinar (pipeline "STEP HER UP - WEBINAR", etapas Closed): van aparte para no mezclarse con las tasas de llamadas.
  try {
    const pw = await pipelineWebinar(env);
    if (pw) {
      for (const etapa of pw.etapas.filter((e) => /^closed/i.test(e.name.trim()))) {
        const res = await fetch(`${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${pw.id}&pipeline_stage_id=${etapa.id}&limit=100`, { headers: ghlHeaders(env) });
        if (!res.ok) continue;
        const lote = ((await res.json()) as { opportunities?: OpportunityGHL[] }).opportunities || [];
        for (const o of lote) {
          const cambio = Date.parse(o.lastStageChangeAt);
          if (!cambio || cambio < start || cambio >= end) continue;
          const dia = diaPR.format(new Date(cambio));
          if (!dias[dia]) dias[dia] = { ...filaVacia(), porFuente: {} };
          const d = dias[dia] as any;
          d.cierresWebinar = (d.cierresWebinar || 0) + 1;
          d.ventasWebinar = (d.ventasWebinar || 0) + (o.monetaryValue || 0);
        }
      }
    }
  } catch { /* si falla el webinar, el resto sigue igual */ }

  // Ajustes manuales por mes (ver ajusteWebinar) para las barras de facturación.
  const ajustesWebinar: Record<string, number> = {};
  try {
    const d0 = new Date(start);
    for (let k = 0; k < 8; k++) {
      const ini = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + k, 1, 12);
      if (ini >= end) break;
      const mes = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Puerto_Rico" }).format(new Date(ini)).slice(0, 7);
      const v = await env.ESTRATEGIAS.get(`ajuste:webinar:${mes}`, "json") as { ventas?: number } | null;
      if (v && typeof v.ventas === "number") ajustesWebinar[mes] = v.ventas;
    }
  } catch { /* sin ajustes */ }

  return json({ ok: true, dias, totales, ajustesWebinar, fuentes: PIPELINES_LEADS.map(p => p.fuente) }, 200, cors);
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
  // Contactos nuevos del rango según la landing del webinar por la que entraron (etiqueta lp-<variante>). Solo conteos.
  const landings: Record<string, number> = {};
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
      for (const tag of c.tags || []) if (tag.startsWith("lp-")) landings[tag.slice(3)] = (landings[tag.slice(3)] || 0) + 1;
      total++;
    }
    const ultimo = lote.length ? Date.parse(lote[lote.length - 1].dateAdded) : 0;
    if (!lote.length || !body.meta?.startAfter || ultimo < start) break;
    if (pagina === 24) cortadoPorLimite = true;
    startAfter = String(body.meta.startAfter);
    startAfterId = String(body.meta.startAfterId);
  }

  return json({ ok: true, total, dias, origenes: [...origenes].sort(), utmLeads, landings, cortadoPorLimite }, 200, cors);
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

// Pipeline "STEP HER UP - WEBINAR". Se busca por NOMBRE (y sus etapas por nombre) en cada uso, así sigue
// funcionando aunque se rehaga o se duplique el pipeline en GHL. Reglas, iguales a las del pipeline de
// ClickFunnels: al registrarse entra en "New Lead"; al reservar pasa a "Auto Booked" solo si seguía en
// "New Lead" (si una setter ya la trabajó, no se toca). Mientras el pipeline tenga las 4 etapas
// provisorias, se usa la primera para registrarse y "Agendó llamada" para reservar.
const NOMBRE_PIPELINE_WEBINAR = "STEP HER UP - WEBINAR";

async function pipelineWebinar(env: Env): Promise<{ id: string; etapas: { id: string; name: string }[] } | null> {
  const r = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!r.ok) return null;
  const b = (await r.json()) as { pipelines?: { id: string; name: string; stages?: { id: string; name: string; position?: number }[] }[] };
  const p = (b.pipelines || []).find((x) => x.name.trim().toUpperCase() === NOMBRE_PIPELINE_WEBINAR);
  if (!p) return null;
  const etapas = [...(p.stages || [])].sort((x, y) => (x.position ?? 0) - (y.position ?? 0)).map((e) => ({ id: e.id, name: e.name }));
  return etapas.length ? { id: p.id, etapas } : null;
}

async function oportunidadWebinar(
  env: Env,
  contactId: string,
  nombre: string,
  evento: "registro" | "agendo" | "ingreso"
): Promise<{ accion: string; detail?: string }> {
  try {
    const pipe = await pipelineWebinar(env);
    if (!pipe) return { accion: "pipeline_no_encontrado" };
    const porNombre = (n: string) => pipe.etapas.find((e) => e.name.trim().toLowerCase() === n);
    const primera = pipe.etapas[0];
    const nuevoLead = porNombre("new lead") || primera;
    const sinTilde = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    // "ingreso": entró a la página previa al Zoom. Pasa a la etapa "Asistió" (cualquier nombre que empiece con "asisti").
    const destino =
      evento === "registro" ? nuevoLead
      : evento === "ingreso" ? pipe.etapas.find((e) => sinTilde(e.name).startsWith("asisti"))
      : porNombre("auto booked") || porNombre("agendó llamada");
    if (!destino) return { accion: "sin_etapa_destino" };

    // Una oportunidad existente solo se mueve al reservar y solo si seguía en la primera etapa.
    const alExistir = async (id: string, etapaActual: string): Promise<{ accion: string; detail?: string }> => {
      if (evento === "registro" || etapaActual !== nuevoLead.id || etapaActual === destino.id) return { accion: "sin_cambios" };
      const mover = await fetch(`${GHL_BASE}/opportunities/${id}`, {
        method: "PUT",
        headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
        body: JSON.stringify({ pipelineStageId: destino.id }),
      });
      return mover.ok ? { accion: "movida" } : { accion: "error", detail: `move ${mover.status}: ${(await mover.text()).slice(0, 200)}` };
    };

    const buscar = await fetch(
      `${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${pipe.id}&contact_id=${contactId}`,
      { headers: ghlHeaders(env) }
    );
    if (!buscar.ok) return { accion: "error", detail: `search ${buscar.status}` };
    const { opportunities = [] } = (await buscar.json()) as { opportunities?: { id: string; pipelineStageId: string }[] };
    if (opportunities.length) return await alExistir(opportunities[0].id, opportunities[0].pipelineStageId);

    const crear = await fetch(`${GHL_BASE}/opportunities/`, {
      method: "POST",
      headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({
        pipelineId: pipe.id,
        locationId: env.GHL_LOCATION_ID,
        pipelineStageId: destino.id,
        contactId,
        name: nombre || "Registro webinar",
        status: "open",
        source: EVENTO_WEBINAR.fuente,
      }),
    });
    if (crear.ok) return { accion: "creada" };
    const texto = await crear.text();
    // La búsqueda de GHL a veces tarda en ver una oportunidad recién creada; GHL no permite duplicados
    // y devuelve el id de la existente: se usa esa.
    const existente = /"existingId":"([^"]+)"/.exec(texto)?.[1];
    if (existente) {
      const r = await fetch(`${GHL_BASE}/opportunities/${existente}`, { headers: ghlHeaders(env) });
      if (r.ok) {
        const o = (await r.json()) as { opportunity?: { pipelineStageId?: string } };
        return await alExistir(existente, o.opportunity?.pipelineStageId || "");
      }
    }
    return { accion: "error", detail: `create ${crear.status}: ${texto.slice(0, 200)}` };
  } catch (err) {
    return { accion: "error", detail: String(err).slice(0, 200) };
  }
}

async function contactoTieneTag(env: Env, contactId: string, tag: string): Promise<boolean> {
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders(env) });
    if (!r.ok) return false;
    const c = (await r.json()) as { contact?: { tags?: string[] } };
    return (c.contact?.tags || []).includes(tag);
  } catch {
    return false;
  }
}

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
  if (!utmTags(p).length || (!email && !telefono)) {
    await anotarDiagnostico(env, "atribucion", { resultado: "nada_para_hacer", utm: utmTags(p) });
    return json({ ok: true, resultado: "nada_para_hacer" }, 200, cors);
  }
  try {
    // Mismo criterio que el webhook del funnel: el nombre completo va en firstName
    // (si se separaba acá, el workflow lo volvía a escribir y el apellido salía duplicado).
    const id = await upsertContact(env, { firstName: nombre || "Lead", lastName: "", email, phone: telefono });
    const resultado = await etiquetarAtribucion(env, id, p);
    await anotarDiagnostico(env, "atribucion", { resultado, utm: utmTags(p) });
    return json({ ok: true, resultado }, 200, cors);
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
    const huella = await huellaVisita(request);
    await env.ESTRATEGIAS.put(`click:${huella}`, JSON.stringify(utm), { expirationTtl: 21600 });
    await anotarDiagnostico(env, "clic", { huella: huella.slice(0, 8), utm });
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

// Registro corto (2 días) de qué pasó en cada paso, para poder diagnosticar.
async function anotarDiagnostico(env: Env, evento: string, datos: Record<string, unknown>): Promise<void> {
  try {
    await env.ESTRATEGIAS.put(`dbg:${evento}:${Date.now()}`, JSON.stringify(datos), { expirationTtl: 172800 });
  } catch { /* nunca debe romper el flujo */ }
}

// Webhook de una automatización de GHL ("Email Events"). DESACTIVADO el 19-oct-2026: GHL solo manda los datos del
// contacto (sin tipo de evento ni nombre del envío) y cada evento escribía en el KV, lo que agotó el límite diario
// gratuito de escrituras. Ahora responde sin guardar nada.
async function handleEmailEvento(request: Request, url: URL, env: Env): Promise<Response> {
  if (!env.EMAIL_HOOK_KEY || url.searchParams.get("k") !== env.EMAIL_HOOK_KEY) {
    return new Response("no autorizado", { status: 401 });
  }
  return new Response("ok", { status: 200 });
}

async function handleClickMatch(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const huella = await huellaVisita(request);
  const guardado = await env.ESTRATEGIAS.get(`click:${huella}`);
  await anotarDiagnostico(env, "match", { encontrado: !!guardado, huella: huella.slice(0, 8), origen: request.headers.get("Origin") });
  let utm: Record<string, string> | null = null;
  try { utm = guardado ? JSON.parse(guardado) : null; } catch { utm = null; }
  return json({ ok: true, utm }, 200, { ...cors, "Cache-Control": "no-store" });
}

// Diagnóstico (solo admin): pipelines con sus etapas e ids, para conectar el funnel.
async function handlePipelinesAdmin(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }
  const res = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!res.ok) return json({ ok: false, error: "pipelines_failed", detail: (await res.text()).slice(0, 200) }, 502, cors);
  const body = (await res.json()) as { pipelines?: { id: string; name: string; stages?: { id: string; name: string; [k: string]: unknown }[] }[] };
  return json({ ok: true, pipelines: (body.pipelines || []).map((p) => ({ id: p.id, name: p.name, etapas: (p.stages || []).map((e) => ({ ...e })) })) }, 200, cors);
}

// Diagnóstico (solo admin): cuántas oportunidades hay en una etapa (p. ej. "Follow Up") en los pipelines
// de leads, cuántas tienen email y qué tan recientes son. Solo devuelve conteos, nunca datos personales.
async function handleSegmentoAdmin(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }
  const etapa = (url.searchParams.get("etapa") || "").trim().toLowerCase();
  if (!etapa) return json({ ok: false, error: "missing_etapa" }, 400, cors);
  const pipeRes = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!pipeRes.ok) return json({ ok: false, error: "pipelines_failed" }, 502, cors);
  const pipeBody = (await pipeRes.json()) as { pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] };
  const ahora = Date.now(), DIA = 86400000;
  const porPipeline: Record<string, { total: number; conEmail: number; ult30: number; ult90: number; masDe90: number; conEmailUlt90: number }> = {};
  for (const p of PIPELINES_LEADS) {
    const meta = (pipeBody.pipelines || []).find((x) => x.id === p.id);
    const ids = new Set((meta?.stages || []).filter((st) => st.name.trim().toLowerCase() === etapa).map((st) => st.id));
    const fila = (porPipeline[p.fuente] = { total: 0, conEmail: 0, ult30: 0, ult90: 0, masDe90: 0, conEmailUlt90: 0 });
    if (!ids.size) continue;
    const opps = (await traerOportunidadesDePipeline(env, p.id)) as (OpportunityGHL & { status?: string; contact?: { email?: string | null } })[];
    for (const o of opps) {
      if (!ids.has(o.pipelineStageId)) continue;
      const dias = (ahora - (Date.parse(o.lastStageChangeAt) || 0)) / DIA;
      const conEmail = !!(o.contact && o.contact.email);
      fila.total++; if (conEmail) fila.conEmail++;
      if (dias <= 30) fila.ult30++; else if (dias <= 90) fila.ult90++; else fila.masDe90++;
      if (conEmail && dias <= 90) fila.conEmailUlt90++;
    }
  }
  const total = Object.values(porPipeline).reduce((a, f) => ({ total: a.total + f.total, conEmail: a.conEmail + f.conEmail, conEmailUlt90: a.conEmailUlt90 + f.conEmailUlt90 }), { total: 0, conEmail: 0, conEmailUlt90: 0 });
  return json({ ok: true, etapa, total, porPipeline }, 200, { ...cors, "Cache-Control": "no-store" });
}

// Admin: pone (o con ?quitar=1 quita) una etiqueta a los contactos de una etapa (p. ej. "Follow Up" -> "follow up") en UN pipeline
// de leads, de a lotes chicos (los Workers gratis permiten ~50 pedidos externos por llamada). Se llama varias
// veces con ?desde= hasta que "siguiente" sea null. Con ?probar=1 solo cuenta, no escribe. ?contacto=<id> etiqueta
// solo ese contacto (para pruebas). Agregar una etiqueta no borra nada y se puede quitar desde GHL.
async function handleEtiquetarEtapa(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }
  // La etiqueta lleva el mismo nombre que la columna (etapa) del pipeline, p. ej. "follow up" (GHL las guarda en minúsculas).
  const tag = (url.searchParams.get("tag") || "").trim().replace(/\s+/g, " ").toLowerCase();
  if (!/^[a-z0-9][a-z0-9 _-]{1,60}$/.test(tag)) return json({ ok: false, error: "tag_invalida" }, 400, cors);
  const quitar = url.searchParams.get("quitar") === "1";
  const ponerTag = async (id: string) => {
    const r = await fetch(`${GHL_BASE}/contacts/${id}/tags`, {
      method: quitar ? "DELETE" : "POST", headers: { ...ghlHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify({ tags: [tag] }),
    });
    return r.ok ? null : `${r.status} ${(await r.text()).slice(0, 160)}`;
  };
  const uno = url.searchParams.get("contacto");
  if (uno) { const err = await ponerTag(uno); return json({ ok: !err, error: err }, err ? 502 : 200, cors); }

  const etapa = (url.searchParams.get("etapa") || "").trim().toLowerCase();
  const fuente = url.searchParams.get("pipeline") || "";
  const pipe = PIPELINES_LEADS.find((p) => p.fuente.toLowerCase() === fuente.toLowerCase());
  if (!etapa || !pipe) return json({ ok: false, error: "falta_etapa_o_pipeline", pipelines: PIPELINES_LEADS.map((p) => p.fuente) }, 400, cors);
  const pipeRes = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!pipeRes.ok) return json({ ok: false, error: "pipelines_failed" }, 502, cors);
  const pipeBody = (await pipeRes.json()) as { pipelines?: { id: string; stages?: { id: string; name: string }[] }[] };
  const ids = new Set(((pipeBody.pipelines || []).find((x) => x.id === pipe.id)?.stages || []).filter((st) => st.name.trim().toLowerCase() === etapa).map((st) => st.id));
  const opps = (await traerOportunidadesDePipeline(env, pipe.id)) as (OpportunityGHL & { contactId?: string; contact?: { id?: string } })[];
  // ?dias=90 deja solo las oportunidades que cambiaron de columna en los últimos N días (segmentos de email recientes).
  const dias = parseInt(url.searchParams.get("dias") || "0", 10) || 0;
  const limite = dias > 0 ? Date.now() - dias * 86400000 : 0;
  const contactos = [...new Set(opps.filter((o) => ids.has(o.pipelineStageId) && (!limite || (Date.parse(o.lastStageChangeAt) || 0) >= limite))
    .map((o) => o.contactId || o.contact?.id).filter(Boolean) as string[])];
  const desde = Math.max(0, parseInt(url.searchParams.get("desde") || "0", 10) || 0);
  if (url.searchParams.get("probar")) return json({ ok: true, pipeline: pipe.fuente, etapa, total: contactos.length }, 200, cors);
  const LOTE = 20;
  const errores: string[] = [];
  for (const id of contactos.slice(desde, desde + LOTE)) { const e = await ponerTag(id); if (e) errores.push(e); }
  const siguiente = desde + LOTE < contactos.length ? desde + LOTE : null;
  return json({ ok: errores.length === 0, pipeline: pipe.fuente, etapa, tag, total: contactos.length, hechos: Math.min(contactos.length, desde + LOTE), siguiente, errores: errores.slice(0, 3) }, 200, cors);
}

// ===== Etiquetas automáticas por columna y por pipeline =====
// Cada contacto lleva una etiqueta con el nombre de la columna (etapa) donde está su oportunidad y otra con el
// nombre del pipeline, en minúsculas (así las guarda GHL): p. ej. "follow up" + "step her up - clickfunnels".
// Un cron revisa todos los pipelines cada 30 min ("calcular") y otro va aplicando los cambios ("aplicar"):
// pone las etiquetas nuevas y quita las de la columna anterior. Solo quita etiquetas que puso este sistema
// (las guarda en KV), nunca toca etiquetas de UTM, del webinar ni las que el equipo pone a mano.
const ETQ_APLICADO = "etq:aplicado";   // { contactId: string[] } lo que ya está puesto en GHL
const ETQ_PEND = "etq:pendientes";     // { contactId: { add: string[]; del: string[] } }
const ETQ_ESTADO = "etq:estado";       // resumen de la última pasada
const nombreTag = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();

async function etiquetasCalcular(env: Env): Promise<{ contactos: number; pendientes: number; oportunidades: number }> {
  const pipeRes = await fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
  if (!pipeRes.ok) throw new Error("pipelines_failed " + pipeRes.status);
  const pipeBody = (await pipeRes.json()) as { pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] };
  const etapa = new Map<string, string>();
  for (const p of pipeBody.pipelines || []) for (const st of p.stages || []) etapa.set(st.id, st.name);
  const deseado = new Map<string, Set<string>>();
  let oportunidades = 0;
  for (const p of pipeBody.pipelines || []) {
    const opps = (await traerOportunidadesDePipeline(env, p.id)) as (OpportunityGHL & { contactId?: string; contact?: { id?: string } })[];
    for (const o of opps) {
      const cid = o.contactId || o.contact?.id;
      const col = etapa.get(o.pipelineStageId);
      if (!cid || !col) continue;
      oportunidades++;
      if (!deseado.has(cid)) deseado.set(cid, new Set());
      deseado.get(cid)!.add(nombreTag(col)).add(nombreTag(p.name));
    }
  }
  const aplicado = ((await env.ESTRATEGIAS.get(ETQ_APLICADO, "json")) || {}) as Record<string, string[]>;
  const pend: Record<string, { add: string[]; del: string[] }> = {};
  for (const cid of new Set([...deseado.keys(), ...Object.keys(aplicado)])) {
    const quiero = deseado.get(cid) || new Set<string>();
    const tengo = new Set(aplicado[cid] || []);
    const add = [...quiero].filter((t) => !tengo.has(t));
    const del = [...tengo].filter((t) => !quiero.has(t));
    if (add.length || del.length) pend[cid] = { add, del };
  }
  await env.ESTRATEGIAS.put(ETQ_PEND, JSON.stringify(pend));
  const r = { contactos: deseado.size, pendientes: Object.keys(pend).length, oportunidades };
  await env.ESTRATEGIAS.put(ETQ_ESTADO, JSON.stringify({ ...r, calculado: new Date().toISOString() }));
  return r;
}

// Aplica en GHL hasta `maxPedidos` cambios (los Workers gratis permiten ~50 pedidos externos por llamada).
async function etiquetasAplicar(env: Env, maxPedidos = 44): Promise<{ hechos: number; quedan: number; errores: string[] }> {
  const pend = ((await env.ESTRATEGIAS.get(ETQ_PEND, "json")) || {}) as Record<string, { add: string[]; del: string[] }>;
  const ids = Object.keys(pend);
  if (!ids.length) return { hechos: 0, quedan: 0, errores: [] };
  const aplicado = ((await env.ESTRATEGIAS.get(ETQ_APLICADO, "json")) || {}) as Record<string, string[]>;
  let pedidos = 0, hechos = 0;
  const errores: string[] = [];
  for (const cid of ids) {
    const { add, del } = pend[cid];
    const necesita = (add.length ? 1 : 0) + (del.length ? 1 : 0);
    if (pedidos + necesita > maxPedidos) break;
    let ok = true;
    for (const [metodo, tags] of [["POST", add], ["DELETE", del]] as [string, string[]][]) {
      if (!tags.length) continue;
      pedidos++;
      const r = await fetch(`${GHL_BASE}/contacts/${cid}/tags`, { method: metodo, headers: { ...ghlHeaders(env), "Content-Type": "application/json" }, body: JSON.stringify({ tags }) });
      if (r.status === 404) break;                        // contacto borrado: se descarta
      if (!r.ok) { ok = false; errores.push(`${metodo} ${r.status}`); if (r.status === 429) break; }
    }
    if (!ok) { if (errores.some((e) => e.endsWith("429"))) break; continue; }
    const quedan = new Set(aplicado[cid] || []);
    del.forEach((t) => quedan.delete(t)); add.forEach((t) => quedan.add(t));
    if (quedan.size) aplicado[cid] = [...quedan]; else delete aplicado[cid];
    delete pend[cid];
    hechos++;
  }
  await env.ESTRATEGIAS.put(ETQ_PEND, JSON.stringify(pend));
  await env.ESTRATEGIAS.put(ETQ_APLICADO, JSON.stringify(aplicado));
  return { hechos, quedan: Object.keys(pend).length, errores: errores.slice(0, 5) };
}

async function handleEtiquetasAdmin(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) return json({ ok: false, error: "unauthorized" }, 401, cors);
  const accion = url.pathname.split("/").pop();
  try {
    if (accion === "calcular") return json({ ok: true, ...(await etiquetasCalcular(env)) }, 200, cors);
    if (accion === "aplicar") return json({ ok: true, ...(await etiquetasAplicar(env, Math.min(44, parseInt(url.searchParams.get("max") || "44", 10) || 44))) }, 200, cors);
    const pend = ((await env.ESTRATEGIAS.get(ETQ_PEND, "json")) || {}) as Record<string, unknown>;
    const aplicado = ((await env.ESTRATEGIAS.get(ETQ_APLICADO, "json")) || {}) as Record<string, string[]>;
    const conteo: Record<string, number> = {};
    Object.values(aplicado).forEach((ts) => ts.forEach((t) => (conteo[t] = (conteo[t] || 0) + 1)));
    return json({ ok: true, estado: await env.ESTRATEGIAS.get(ETQ_ESTADO, "json"), pendientes: Object.keys(pend).length, contactosEtiquetados: Object.keys(aplicado).length, porEtiqueta: conteo }, 200, cors);
  } catch (e) {
    return json({ ok: false, error: String(e) }, 502, cors);
  }
}

// ===== Recordatorio diario en Slack (#setters) =====
// Lunes a viernes 1:00 PM AST: recuerda enviar los números con el formato de Paula y menciona solo a quienes
// todavía no los enviaron ese día. No menciona a Thomas ni a Gianie. "Enviado" = un mensaje de hoy (hora de
// Puerto Rico) en #setters que diga "llamadas" y "agend".
const SLACK_CANAL = "setters";
const SLACK_EXCLUIDOS = /thomas|gianie/i;
// Setters activas (por primer nombre). Solo a ellas se las menciona. Para sumar o sacar a alguien, cambiar esta lista.
const SLACK_ACTIVAS = ["mia", "paula", "belen"];
const PLANTILLA_NUMEROS = "Llamadas:\nNo contestaron:\nColgaron:\nLlamar más tarde:\nAgendé:\nCitas confirmadas:\nNo show:";

async function slack(env: Env, metodo: string, params: Record<string, string> = {}, cuerpo?: unknown): Promise<any> {
  const url = `https://slack.com/api/${metodo}` + (cuerpo ? "" : "?" + new URLSearchParams(params).toString());
  const r = await fetch(url, {
    method: cuerpo ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, ...(cuerpo ? { "Content-Type": "application/json; charset=utf-8" } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const d = (await r.json()) as { ok: boolean; error?: string };
  if (!d.ok) throw new Error(`slack ${metodo}: ${d.error}`);
  return d;
}

// Lo llama el cron. Solo publica de lunes a viernes (día de Puerto Rico) y una sola vez por día y tipo:
// Cloudflare puede disparar el mismo cron dos veces, así que un candado en KV evita el mensaje doble.
async function recordatorioProgramado(env: Env, tipo: "numeros" | "metas" | "cierre", cuando: number): Promise<void> {
  const pr = new Date(cuando - 4 * 3600 * 1000);
  const dia = pr.getUTCDay();
  if (dia === 0 || dia === 6) return;
  const clave = `slack:${tipo}:${pr.toISOString().slice(0, 10)}`;
  if (await env.ESTRATEGIAS.get(clave)) return;
  await env.ESTRATEGIAS.put(clave, "1", { expirationTtl: 86400 });
  try { await recordatorioSetters(env, true, tipo); }
  catch (e) { await env.ESTRATEGIAS.delete(clave); throw e; }
}


// ===== Avisos y resumen semanal por Slack: llegan SOLO por mensaje directo a Thomas (U0C210N8PR8), no al equipo. =====
const SLACK_THOMAS = "U0C210N8PR8";
const META_INSCRIPTAS = 1000;

async function avisarThomas(env: Env, texto: string): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  const dm = await slack(env, "conversations.open", {}, { users: SLACK_THOMAS });
  await slack(env, "chat.postMessage", {}, { channel: dm.channel.id, text: texto });
}

const fmtDinero = (n: number) => "$" + Math.round(n || 0).toLocaleString("en-US");
function variacion(ahora: number, antes: number): string {
  if (!antes) return ahora ? " (nuevo)" : "";
  const p = Math.round(((ahora - antes) / antes) * 100);
  return ` (${p >= 0 ? "+" : ""}${p}% vs la anterior)`;
}

// Lunes 9:00 AM de Puerto Rico: números de la semana que terminó contra la anterior.
async function resumenSemanal(env: Env, cuando: number): Promise<void> {
  const ini = cuando - 7 * 86400000, antes = ini - 7 * 86400000;
  const pedir = async (a: number, b: number): Promise<Record<string, number>> => {
    const r = await handleLeadsSummary(new URL(`https://x/leads-summary?start=${a}&end=${b}`), env, {});
    const d = (await r.json()) as { totales?: Record<string, number> };
    return d.totales || {};
  };
  const [t, ta] = await Promise.all([pedir(ini, cuando), pedir(antes, ini)]);
  const w = (await (await handleWebinarResumen(env, {})).json()) as { total?: number; etapas?: { nombre: string; cantidad: number }[] };
  const sinTilde = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asistieron = (w.etapas || []).find((e) => sinTilde(e.nombre).startsWith("asisti"))?.cantidad || 0;
  const dia = (ms: number) => new Date(ms - 4 * 3600 * 1000).toLocaleDateString("es-PR", { day: "numeric", month: "short", timeZone: "UTC" });
  const linea = (nom: string, k: string) => `• ${nom}: *${t[k] || 0}*${variacion(t[k] || 0, ta[k] || 0)}`;
  const texto = [
    `📊 *Resumen de la semana* (${dia(ini)} al ${dia(cuando)})`,
    linea("Llamadas", "llamadas"), linea("Agendadas", "agendadas"), linea("Shows", "shows"), linea("Cierres", "cierres"),
    `• Cash cobrado: *${fmtDinero(t.ventas || 0)}*${variacion(t.ventas || 0, ta.ventas || 0)}`,
    `• Webinar: *${w.total || 0}* inscritas en total, *${asistieron}* asistieron`,
    "Más detalle en https://dash.stepherup.com",
  ].join("\n");
  await avisarThomas(env, texto);
}

async function resumenSemanalProgramado(env: Env, cuando: number): Promise<void> {
  const dia = new Date(cuando - 4 * 3600 * 1000).toISOString().slice(0, 10);
  const clave = `slack:semanal:${dia}`;
  if (await env.ESTRATEGIAS.get(clave)) return;
  await env.ESTRATEGIAS.put(clave, "1", { expirationTtl: 86400 });
  try { await resumenSemanal(env, cuando); } catch (e) { await env.ESTRATEGIAS.delete(clave); throw e; }
}

// Avisos de lo que pide atención. Solo escribe cuando hay algo que decir.
async function avisosParaThomas(env: Env): Promise<void> {
  if (!env.SLACK_BOT_TOKEN) return;
  if (!(await env.ESTRATEGIAS.get("avisos:activo"))) {
    await env.ESTRATEGIAS.put("avisos:activo", "1");
    await avisarThomas(env, "✅ *Avisos activados.* Te escribo por aquí, solo a ti, cuando una asistente al webinar no tenga responsable o se llegue a la meta de inscriptas.");
  }
  const pw = await pipelineWebinar(env);
  if (!pw) return;
  const sinTilde = (x: string) => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const asist = pw.etapas.find((e) => sinTilde(e.name).startsWith("asisti"));
  const ops = (await traerOportunidadesDePipeline(env, pw.id)) as unknown as { pipelineStageId: string; assignedTo?: string; name?: string; contact?: { name?: string; phone?: string } }[];
  if (asist) {
    const sin = ops.filter((o) => o.pipelineStageId === asist.id && !o.assignedTo);
    if (sin.length) {
      const lista = sin.slice(0, 6).map((o) => `• ${o.contact?.name || o.name || "Sin nombre"}${o.contact?.phone ? " · " + o.contact.phone : ""}`).join("\n");
      await avisarThomas(env, `⚠️ *${sin.length}* ${sin.length === 1 ? "asistente al webinar sigue" : "asistentes al webinar siguen"} sin responsable en la etapa Asistió:\n${lista}${sin.length > 6 ? `\n…y ${sin.length - 6} más` : ""}`);
    }
  }
  if (ops.length >= META_INSCRIPTAS && !(await env.ESTRATEGIAS.get("avisos:meta-inscriptas"))) {
    await env.ESTRATEGIAS.put("avisos:meta-inscriptas", "1");
    await avisarThomas(env, `🎉 ¡Se llegó a la meta! Ya hay *${ops.length}* inscritas en el webinar (la meta era ${META_INSCRIPTAS}).`);
  }
}

async function recordatorioSetters(env: Env, enviar: boolean, tipo: "numeros" | "metas" | "cierre" = "numeros"): Promise<{ canal: string; pendientes: string[]; enviaron: string[]; publicado: boolean }> {
  if (!env.SLACK_BOT_TOKEN) throw new Error("falta SLACK_BOT_TOKEN");
  const canales = await slack(env, "conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" });
  const canal = (canales.channels || []).find((c: { name: string }) => c.name === SLACK_CANAL);
  if (!canal) throw new Error(`no encuentro #${SLACK_CANAL} (¿invitaste al bot al canal?)`);
  const miembros: string[] = (await slack(env, "conversations.members", { channel: canal.id, limit: "200" })).members || [];
  const usuarios = (await slack(env, "users.list", { limit: "500" })).members || [];
  const info = new Map<string, any>(usuarios.map((u: any) => [u.id, u]));
  const nombre = (id: string) => { const u = info.get(id); return u ? u.real_name || u.profile?.real_name || u.name : id; };
  const primerNombre = (u: any) => (u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || "").trim().split(/\s+/)[0].toLowerCase();
  const equipo = miembros.filter((id) => {
    const u = info.get(id);
    if (!u || u.is_bot || u.deleted || id === "USLACKBOT") return false;
    if (SLACK_EXCLUIDOS.test(`${u.real_name || ""} ${u.name || ""} ${u.profile?.display_name || ""}`)) return false;
    return SLACK_ACTIVAS.includes(primerNombre(u));
  });
  // Medianoche de hoy en Puerto Rico (UTC-4, sin horario de verano).
  const ahoraPR = new Date(Date.now() - 4 * 3600000);
  const inicioDia = Date.UTC(ahoraPR.getUTCFullYear(), ahoraPR.getUTCMonth(), ahoraPR.getUTCDate()) / 1000 + 4 * 3600;
  // Para el cierre solo cuentan los mensajes desde las 5:00 PM de hoy (el reporte de fin de día).
  const desde = tipo === "cierre" ? inicioDia + 17 * 3600 : inicioDia;
  const historial = (await slack(env, "conversations.history", { channel: canal.id, oldest: String(desde), limit: "200" })).messages || [];
  // "numeros": mensaje con "llamadas" y "agend" (formato de Paula). "metas": cualquier mensaje de hoy que hable de "meta".
  // Números y cierre usan el formato de Paula; para el cierre solo cuentan los enviados desde las 5:00 PM.
  const cuenta = (t: string) => (tipo === "metas" ? /meta/i.test(t) : /llamadas/i.test(t) && /agend/i.test(t));
  const enviaron = new Set<string>(historial.filter((m: any) => m.user && cuenta(m.text || "")).map((m: any) => m.user));
  const pendientes = equipo.filter((id) => !enviaron.has(id));
  let publicado = false;
  if (enviar && tipo === "metas") {
    if (pendientes.length) {
      await slack(env, "chat.postMessage", {}, { channel: canal.id, text: `☀️ ¡Buenos días, equipo! Recuerden enviar sus metas de hoy. ${pendientes.map((id) => `<@${id}>`).join(" ")}` });
      publicado = true;
    }
  } else if (enviar) {
    const cierre = tipo === "cierre";
    const texto = pendientes.length
      ? (cierre
          ? `🌙 *Cierre del día*: ¿cómo terminaron hoy? Envíen sus números finales en este formato 👇\n\n${PLANTILLA_NUMEROS}\n\nFaltan: `
          : `⏰ *Recordatorio de la 1:00 PM*: envíen sus números del día en este formato 👇\n\n${PLANTILLA_NUMEROS}\n\nFaltan: `) + pendientes.map((id) => `<@${id}>`).join(" ")
      : cierre ? "✅ Todas enviaron su cierre de hoy. ¡Gracias, equipo!" : "✅ Todas enviaron sus números de hoy. ¡Gracias, equipo!";
    await slack(env, "chat.postMessage", {}, { channel: canal.id, text: texto });
    publicado = true;
  }
  return { canal: `#${canal.name}`, pendientes: pendientes.map(nombre), enviaron: [...enviaron].map(nombre), publicado };
}

// Diagnóstico (solo admin): últimos contactos con sus etiquetas de UTM, para
// comprobar que la atribución llegó. ?q= busca por email/teléfono/nombre.
async function handleContactosRecientes(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) {
    return json({ ok: false, error: "unauthorized" }, 401, cors);
  }
  // ?id=<contacto>: lectura directa de un contacto con TODAS sus etiquetas (el buscador de GHL tarda en reflejar cambios).
  const id = (url.searchParams.get("id") || "").trim();
  if (/^[A-Za-z0-9]{10,40}$/.test(id)) {
    const r = await fetch(`${GHL_BASE}/contacts/${id}`, { headers: ghlHeaders(env) });
    if (!r.ok) return json({ ok: false, error: "contact_failed", status: r.status }, 502, cors);
    const c = ((await r.json()) as { contact?: { contactName?: string; firstName?: string; lastName?: string; email?: string; phone?: string; timezone?: string; dateAdded?: string; source?: string; tags?: string[] } }).contact || {};
    // Oportunidades del contacto, con el nombre del pipeline y de la columna (para comprobar dónde quedó guardado).
    const [ro, rp] = await Promise.all([
      fetch(`${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&contact_id=${id}`, { headers: ghlHeaders(env) }),
      fetch(`${GHL_BASE}/opportunities/pipelines?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) }),
    ]);
    const ops = ro.ok ? ((await ro.json()) as { opportunities?: { name?: string; status?: string; source?: string; pipelineId: string; pipelineStageId: string; createdAt?: string }[] }).opportunities || [] : [];
    const pipes = rp.ok ? ((await rp.json()) as { pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] }).pipelines || [] : [];
    const oportunidades = ops.map((o) => {
      const pp = pipes.find((x) => x.id === o.pipelineId);
      return { nombre: o.name, estado: o.status, origen: o.source, creada: o.createdAt, pipeline: pp?.name || o.pipelineId, columna: pp?.stages?.find((s) => s.id === o.pipelineStageId)?.name || o.pipelineStageId };
    });
    const tapar = (v?: string) => (v ? v.slice(0, 3) + "…" + v.slice(-4) : "");
    return json({ ok: true, contacto: { nombre: c.contactName || `${c.firstName || ""} ${c.lastName || ""}`.trim(), email: tapar(c.email), telefono: tapar(c.phone), zona: c.timezone, creado: c.dateAdded, origen: c.source, tags: c.tags || [], oportunidades } }, 200, cors);
  }
  const q = (url.searchParams.get("q") || "").trim();
  let u = `${GHL_BASE}/contacts/?locationId=${env.GHL_LOCATION_ID}&limit=8`;
  if (q) u += `&query=${encodeURIComponent(q)}`;
  const res = await fetch(u, { headers: ghlHeaders(env) });
  if (!res.ok) return json({ ok: false, error: "contacts_failed", detail: (await res.text()).slice(0, 200) }, 502, cors);
  const body = (await res.json()) as { contacts?: { id: string; contactName?: string; email?: string; dateAdded?: string; source?: string; tags?: string[] }[] };
  const contactos = (body.contacts || []).map((c) => ({
    nombre: c.contactName, email: c.email, creado: c.dateAdded, origen: c.source,
    tags: (c.tags || []).filter((t) => /^(src|med|camp|cont|lp)-/.test(t) || t === "webinar-21-oct"),
  }));
  return json({ ok: true, contactos }, 200, cors);
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

// ===== Ingreso al Zoom (página previa a la clase): la persona deja nombre, correo y teléfono antes de entrar.
// Se le pone la etiqueta webinar-asistio y su oportunidad pasa a la etapa "Asistió" del pipeline del webinar,
// para que las setters llamen primero a quienes sí entraron. Si no estaba registrada, queda con la etiqueta ingreso-sin-registro. =====
// Las personas que pagaron: su oportunidad del pipeline del webinar pasa a "Closed $997" (Won, con valor)
// y se les pone la etiqueta compro-skool. Lo usan /webinar-compra (rutina que lee Skool) y /stripe-webhook.
async function cerrarVentas(env: Env, emails: string[], valor: number, simular: boolean): Promise<{ error?: string; resultados: { email: string; accion: string; detail?: string }[] }> {
  const pipe = await pipelineWebinar(env);
  if (!pipe) return { error: "pipeline_no_encontrado", resultados: [] };
  const cerrada = pipe.etapas.find((e) => /^closed\s*\$?\s*997/i.test(e.name.trim())) || pipe.etapas.find((e) => e.name.trim().toLowerCase() === "closed");
  if (!cerrada) return { error: "sin_etapa_closed", resultados: [] };
  const cab = { ...ghlHeaders(env), "Content-Type": "application/json" };
  const resultados: { email: string; accion: string; detail?: string }[] = [];
  for (const email of emails) {
    try {
      const up = await fetch(`${GHL_BASE}/contacts/upsert`, { method: "POST", headers: cab, body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, email }) });
      if (!up.ok) { resultados.push({ email, accion: "error", detail: `contacto ${up.status}` }); continue; }
      const id = ((await up.json()) as { contact?: { id?: string } }).contact?.id;
      if (!id) { resultados.push({ email, accion: "sin_contacto" }); continue; }
      const bus = await fetch(`${GHL_BASE}/opportunities/search?location_id=${env.GHL_LOCATION_ID}&pipeline_id=${pipe.id}&contact_id=${id}`, { headers: ghlHeaders(env) });
      const ops = bus.ok ? (((await bus.json()) as { opportunities?: { id: string; pipelineStageId: string; status?: string }[] }).opportunities || []) : [];
      const op = ops[0];
      if (op && op.pipelineStageId === cerrada.id && op.status === "won") { resultados.push({ email, accion: "ya_cerrada" }); continue; }
      if (simular) { resultados.push({ email, accion: op ? "se_movería" : "se_crearía" }); continue; }
      let r: Response;
      if (op) {
        r = await fetch(`${GHL_BASE}/opportunities/${op.id}`, { method: "PUT", headers: cab, body: JSON.stringify({ pipelineStageId: cerrada.id, status: "won", monetaryValue: valor }) });
      } else {
        r = await fetch(`${GHL_BASE}/opportunities/`, { method: "POST", headers: cab, body: JSON.stringify({ pipelineId: pipe.id, locationId: env.GHL_LOCATION_ID, pipelineStageId: cerrada.id, contactId: id, name: email.split("@")[0], status: "won", monetaryValue: valor, source: EVENTO_WEBINAR.fuente }) });
      }
      if (!r.ok) { resultados.push({ email, accion: "error", detail: `opp ${r.status}: ${(await r.text()).slice(0, 150)}` }); continue; }
      await fetch(`${GHL_BASE}/contacts/${id}/tags`, { method: "POST", headers: cab, body: JSON.stringify({ tags: ["compro-skool"] }) }).catch(() => null);
      resultados.push({ email, accion: op ? "movida" : "creada" });
    } catch (err) {
      resultados.push({ email, accion: "error", detail: String(err).slice(0, 150) });
    }
  }
  return { resultados };
}

// POST /webinar-compra (header X-Site-Key). Body: { emails: string[], valor?: number, simular?: boolean }
async function handleWebinarCompra(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  if (!env.SITE_KEY) return json({ ok: false, error: "not_configured" }, 503, cors);
  if (!igualesSeguro(request.headers.get("X-Site-Key") || "", env.SITE_KEY)) return json({ ok: false, error: "unauthorized" }, 401, cors);
  let p: { emails?: unknown; valor?: unknown; simular?: unknown };
  try {
    p = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }
  const valor = Number(p.valor) > 0 ? Number(p.valor) : 997;
  const emails = [...new Set((Array.isArray(p.emails) ? p.emails : []).map((e) => String(e).trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)))].slice(0, 40);
  if (!emails.length) return json({ ok: false, error: "sin_emails" }, 400, cors);
  const r = await cerrarVentas(env, emails, valor, p.simular === true);
  if (r.error) return json({ ok: false, error: r.error }, 502, cors);
  return json({ ok: true, simular: p.simular === true, valor, resultados: r.resultados }, 200, cors);
}

// Firma de Stripe: header "t=...,v1=..." con HMAC-SHA256 de "t.payload" (tolerancia de 5 minutos).
async function firmaStripeValida(payload: string, header: string, secreto: string): Promise<boolean> {
  const partes = header.split(",").map((x) => x.trim().split("="));
  const t = partes.find((x) => x[0] === "t")?.[1] || "";
  const v1 = partes.filter((x) => x[0] === "v1").map((x) => x[1] || "");
  if (!t || !v1.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const clave = await crypto.subtle.importKey("raw", new TextEncoder().encode(secreto), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await crypto.subtle.sign("HMAC", clave, new TextEncoder().encode(`${t}.${payload}`));
  const hex = [...new Uint8Array(firma)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return v1.some((v) => igualesSeguro(v, hex));
}

// POST /stripe-webhook. Stripe avisa cada pago ("checkout.session.completed"). Solo cuentan los links de la oferta
// ($997 y la primera cuota de $397); cualquier otro monto se ignora.
async function handleStripeWebhook(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ ok: false, error: "not_configured" }, 503, cors);
  const payload = await request.text();
  if (!(await firmaStripeValida(payload, request.headers.get("Stripe-Signature") || "", env.STRIPE_WEBHOOK_SECRET))) return json({ ok: false, error: "firma_invalida" }, 400, cors);
  let ev: { type?: string; data?: { object?: { payment_status?: string; amount_total?: number; customer_email?: string; customer_details?: { email?: string } } } };
  try {
    ev = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }
  if (ev.type !== "checkout.session.completed") return json({ ok: true, ignorado: ev.type || "sin_tipo" }, 200, cors);
  const s = ev.data?.object || {};
  if (s.payment_status && s.payment_status !== "paid") return json({ ok: true, ignorado: "no_pagado" }, 200, cors);
  const monto = (s.amount_total || 0) / 100;
  if (![997, 397, 250].includes(monto)) return json({ ok: true, ignorado: `monto_${monto}` }, 200, cors);
  const email = String(s.customer_details?.email || s.customer_email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: true, ignorado: "sin_email" }, 200, cors);
  const r = await cerrarVentas(env, [email], monto, false); // monto real que cobró Stripe (997, 397 o 250), no siempre 997
  return json({ ok: !r.error, error: r.error, resultados: r.resultados }, r.error ? 502 : 200, cors);
}

async function handleWebinarIngreso(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  let p: Record<string, unknown>;
  try {
    p = await request.json();
  } catch {
    return json({ ok: false, error: "invalid_json" }, 400, cors);
  }
  if (p.website) return json({ ok: true }, 200, cors);

  const nombre = String(p.nombre || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const email = String(p.email || "").trim().toLowerCase().slice(0, 120);
  const telefono = String(p.telefono || "").replace(/[^\d+]/g, "").slice(0, 20);
  if (nombre.length < 2) return json({ ok: false, error: "nombre_invalido" }, 400, cors);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return json({ ok: false, error: "email_invalido" }, 400, cors);
  if (telefono.replace(/\D/g, "").length < 7) return json({ ok: false, error: "telefono_invalido" }, 400, cors);

  const partes = nombre.split(" ");
  const res = await fetch(`${GHL_BASE}/contacts/upsert`, {
    method: "POST",
    headers: { ...ghlHeaders(env), "Content-Type": "application/json" },
    body: JSON.stringify({ locationId: env.GHL_LOCATION_ID, firstName: partes[0], lastName: partes.slice(1).join(" "), email, phone: telefono }),
  });
  if (!res.ok) return json({ ok: false, error: "ghl_failed", detail: (await res.text()).slice(0, 300) }, 502, cors);
  const body = (await res.json()) as { contact?: { id?: string } };
  const id = body.contact?.id || null;
  if (!id) return json({ ok: true, id: null, oportunidad: { accion: "sin_contacto" } }, 200, cors);

  const cabeceras = { ...ghlHeaders(env), "Content-Type": "application/json" };
  const yaRegistrada = await contactoTieneTag(env, id, EVENTO_WEBINAR.tag);
  const tags = ["webinar-asistio", ...(yaRegistrada ? [] : ["ingreso-sin-registro"])];
  const rt = await fetch(`${GHL_BASE}/contacts/${id}/tags`, { method: "POST", headers: cabeceras, body: JSON.stringify({ tags }) }).catch(() => null);
  await etiquetarAtribucion(env, id, p).catch(() => "error");
  const oportunidad = await oportunidadWebinar(env, id, nombre, "ingreso");
  return json({ ok: true, id, registrada: yaRegistrada, etiquetas: rt?.ok ? "ok" : "error", oportunidad }, 200, cors);
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
  // Qué versión de la landing registró a la persona: etiqueta "lp-<variante>" (p. ej. lp-sistema-marca).
  const variante = String(p.variante || "").trim().toLowerCase();
  const tags = [EVENTO_WEBINAR.tag, ...(/^[a-z0-9][a-z0-9-]{1,39}$/.test(variante) ? [`lp-${variante}`] : [])];
  // Las etiquetas y el origen NO van en el upsert: GHL reemplaza TODAS las etiquetas del contacto por las que se le
  // mandan, y una persona que ya estaba en el CRM perdía las suyas (columna, pipeline, UTM del primer toque).
  // Se agregan después con la llamada que suma etiquetas sin tocar las existentes.
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
        timezone,
      }),
    });
  const tz = zonaValida(typeof p.timezone === "string" ? p.timezone : undefined);
  let res = await pedir(tz);
  if (!res.ok && tz) res = await pedir(undefined);
  if (!res.ok) {
    return json({ ok: false, error: "ghl_failed", detail: (await res.text()).slice(0, 300) }, 502, cors);
  }
  const body = (await res.json()) as { new?: boolean; contact?: { id?: string; dateAdded?: string } };
  const idContacto = body.contact?.id || null;
  let etiquetas = "sin_contacto";
  if (idContacto) {
    const cabeceras = { ...ghlHeaders(env), "Content-Type": "application/json" };
    const sumar = () => fetch(`${GHL_BASE}/contacts/${idContacto}/tags`, { method: "POST", headers: cabeceras, body: JSON.stringify({ tags }) });
    let rt = await sumar();
    if (!rt.ok) rt = await sumar();   // la etiqueta dispara la confirmación: se reintenta una vez
    etiquetas = rt.ok ? "ok" : `error_${rt.status}`;
    // UTMs: gana el primer toque (si ya tiene src-/camp- no se pisan), igual que en el resto del funnel.
    await etiquetarAtribucion(env, idContacto, p).catch(() => "error");
    // El origen "Webinar 21 oct" solo se escribe en contactos nuevos: a los que ya existían se les respeta el suyo.
    const esNuevo = body.new === true || Date.now() - (Date.parse(body.contact?.dateAdded || "") || 0) < 120000;
    if (esNuevo) {
      await fetch(`${GHL_BASE}/contacts/${idContacto}`, { method: "PUT", headers: cabeceras, body: JSON.stringify({ source: EVENTO_WEBINAR.fuente }) }).catch(() => null);
    }
  }
  const oportunidad = idContacto ? await oportunidadWebinar(env, idContacto, nombre, "registro") : { accion: "sin_contacto" };
  return json({ ok: true, id: idContacto, oportunidad, etiquetas }, 200, cors);
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

// --- Auditoría de perfil de Instagram con IA (página /auditoria-perfil/) -----
// La persona escribe su @ y sube capturas; la IA revisa los 40 puntos del
// "Checklist de auditoría de perfil SHU" y devuelve el informe. Las imágenes
// no se guardan: solo se anota el @ y el puntaje (90 días) para el equipo.
const AUDIT_SECCIONES = [
  "1. Foto de perfil",
  "2. Nombre y username",
  "3. Bio",
  "4. Enlace y categoría",
  "5. Historias destacadas",
  "6. Las 3 publicaciones pineadas",
];
const AUDIT_ITEMS: { s: number; t: string }[] = [
  { s: 0, t: "La cara ocupa del 60 al 70 % del círculo." },
  { s: 0, t: "Se te ve la cara de frente, con buena luz y sin gafas oscuras." },
  { s: 0, t: "El fondo es limpio y no compite con la cara." },
  { s: 0, t: "La ropa y el estilo van con el nivel de lo que vendes (si cobras premium, se ve premium)." },
  { s: 0, t: "Es una foto tuya, no un logo (si eres marca personal)." },
  { s: 0, t: "Es la misma foto en Instagram, TikTok, Facebook, LinkedIn, WhatsApp Business y la cuenta de tu negocio." },
  { s: 1, t: "Incluye tu nombre + la palabra clave que tu clienta escribiría en el buscador (ej. \"Dra. Rivera | Dermatóloga\", \"Ana | Bienes Raíces PR\")." },
  { s: 1, t: "La palabra clave es lo que la gente busca, no un título rebuscado (\"Dermatóloga\" sí; \"Visionaria de la piel\" no)." },
  { s: 1, t: "Si eres negocio local, incluye el pueblo o \"PR\"." },
  { s: 1, t: "El username es fácil de deletrear y de decir en voz alta." },
  { s: 1, t: "El username no tiene puntos, guiones bajos ni números de más." },
  { s: 1, t: "Es el mismo @ en todas las plataformas." },
  { s: 2, t: "La primera línea dice qué haces y para quién, en palabras literales (\"Dermatóloga experta en hiperpigmentación y acné\")." },
  { s: 2, t: "Tiene un diferenciador concreto, no una frase bonita que podría decir cualquiera (nada de \"transformo vidas\" o \"hacemos cambios reales\")." },
  { s: 2, t: "Tiene prueba: un número real (clientas, años, ventas, casos) o una autoridad verificable (título, medio, certificación)." },
  { s: 2, t: "Termina con un llamado a la acción claro: qué hacer y dónde (\"Escríbeme CITA por DM\", \"Reserva abajo ↓\")." },
  { s: 2, t: "No hay líneas que cierren la puerta sin dar alternativa (ej. \"Agenda cerrada\" sin lista de espera)." },
  { s: 2, t: "Si tienes cuenta de negocio activa, está mencionada con @." },
  { s: 2, t: "Se lee completa sin tocar \"más\" y cabe en 150 caracteres." },
  { s: 3, t: "Hay un enlace en el perfil." },
  { s: 3, t: "El enlace funciona y abre rápido desde el celular." },
  { s: 3, t: "Lleva a una acción de venta: agendar, comprar, lista de espera o WhatsApp." },
  { s: 3, t: "Si usas un árbol de enlaces, tiene 3 opciones o menos y la principal va primero." },
  { s: 3, t: "La categoría del perfil es específica (ej. \"Dermatólogo\", \"Agente de bienes raíces\") o está oculta; nunca la genérica \"Emprendedor(a)\" o \"Figura pública\" si no te posiciona." },
  { s: 4, t: "Hay una destacada de Resultados (testimonios, antes y después, reviews), y va de primera." },
  { s: 4, t: "Hay una destacada de Ofertas o servicios: qué vendes, para quién y cómo se compra." },
  { s: 4, t: "Si eres negocio local, hay una destacada de Cómo llegar: dirección, estacionamiento, foto de la entrada." },
  { s: 4, t: "Si aplica, hay una destacada de Políticas: cancelaciones, depósitos, métodos de pago." },
  { s: 4, t: "Hay una destacada de Preguntas frecuentes escritas para contestar objeciones reales (precio, tiempo, \"¿esto es para mí?\", ATH Móvil, estacionamiento)." },
  { s: 4, t: "Hay una destacada de Sobre mí: tu historia y por qué haces lo que haces." },
  { s: 4, t: "Los nombres de las destacadas se leen completos, sin cortarse (\"Resultados\", no \"Testimonios…\")." },
  { s: 4, t: "Ninguna destacada está sin nombre o con un emoji solo." },
  { s: 4, t: "Todas las portadas de las destacadas siguen el mismo estilo y colores de tu marca." },
  { s: 4, t: "No hay destacadas viejas o que ya no van con lo que vendes hoy." },
  { s: 5, t: "Hay 3 publicaciones fijadas arriba del perfil." },
  { s: 5, t: "Una fijada es prueba: caso de éxito, cliente importante, intercambio o review que cuenta cómo fue la experiencia comprando o usando tu producto." },
  { s: 5, t: "Una fijada es tu historia: quién eres, de dónde vienes y por qué haces esto." },
  { s: 5, t: "Una fijada es la oferta: los servicios que vendes, o los productos si vendes productos, y cómo comprarlos." },
  { s: 5, t: "Las tres fijadas tienen una portada que se entiende sin abrirlas (texto claro en la imagen)." },
  { s: 5, t: "Ninguna fijada es un post viejo de una promoción vencida o de un evento que ya pasó." },
];

const AUDIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["lectura", "items", "resumenes"],
  properties: {
    lectura: {
      type: "object",
      additionalProperties: false,
      required: ["username", "nombre", "categoria", "bio", "enlace", "publicaciones_fijadas", "destacadas", "pagina_del_enlace"],
      properties: {
        username: { type: "string" },
        nombre: { type: "string" },
        categoria: { type: "string" },
        bio: { type: "string" },
        enlace: { type: "string" },
        publicaciones_fijadas: { type: "string" },
        destacadas: { type: "string" },
        pagina_del_enlace: { type: "string" },
      },
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "estado", "observacion"],
        properties: {
          n: { type: "integer" },
          estado: { type: "string", enum: ["cumple", "no_cumple", "no_verificable"] },
          observacion: { type: "string" },
        },
      },
    },
    resumenes: { type: "array", items: { type: "string" } },
  },
};

function auditPrompt(usuario: string): string {
  const lista = AUDIT_ITEMS.map((it, i) => `${i + 1}. [${AUDIT_SECCIONES[it.s]}] ${it.t}`).join("\n");
  return `Eres la revisora de perfiles de Instagram del equipo de Step Her Up (Gianie Milet). Revisas el perfil de @${usuario} con el "Checklist de auditoría de perfil SHU", que tiene exactamente 40 puntos. Te llegan capturas del perfil: pueden ser la parte de arriba (foto, nombre, bio, enlace, categoría), las historias destacadas, las publicaciones fijadas y la página a la que lleva el enlace.

PRIMERO LEE, DESPUÉS JUZGA
Antes de calificar, llena "lectura" copiando lo que ves, letra por letra:
- username: el texto de arriba del todo en el perfil (con sus puntos, guiones bajos y números).
- nombre: el texto en negrita justo debajo de los números de publicaciones o del username (suele tener la forma "Nombre | palabra clave"). No lo confundas con el username.
- categoria: la palabra gris encima de la bio (por ejemplo "Entrepreneur"). Si no hay, escribe "no se ve".
- bio: el texto completo de la bio, línea por línea. Si se ve cortado con "más", dilo.
- enlace: el enlace que sale en el perfil.
- publicaciones_fijadas: recorre las publicaciones de la cuadrícula en orden y anota cuáles tienen el ícono de chincheta (pin) en la esquina y qué se ve en cada una (texto en la imagen, si es foto, video). Di cuántas fijadas hay. Si no hay captura de la cuadrícula, escribe "no se ve".
- destacadas: si debajo de la bio hay una fila de círculos con nombres, anota cada nombre; si en la captura se ve el espacio debajo de la bio y no hay círculos, escribe "no hay destacadas". Si no se ve esa parte, escribe "no se ve".
- pagina_del_enlace: qué es la página del enlace (página propia, árbol de enlaces, WhatsApp, agenda…), qué ofrece y qué botones tiene. Si no hay captura, escribe "no se ve".
Los puntos se juzgan con lo que escribiste en "lectura", sin contradecirlo.

REGLAS
- Responde SOLO con lo que se ve en las capturas. No inventes nada: ni seguidores, ni textos, ni colores que no estén.
- Para cada uno de los 40 puntos, en el orden de la lista, devuelve un estado:
  "cumple" solo si se ve con claridad que cumple.
  "no_cumple" si se ve con claridad que no cumple, o si la captura muestra el lugar donde debería estar y no está (por ejemplo, la fila de destacadas debajo de la bio está vacía: no hay destacadas).
  "no_verificable" si las capturas no alcanzan para saberlo o si depende de algo que no se ve desde Instagram (misma foto o mismo @ en otras plataformas, si el enlace abre rápido, si la persona tiene negocio local o cuenta de negocio y no se puede deducir). En ese caso la observación empieza con "No se puede comprobar con las capturas:" y dice qué debe confirmar la persona.
- Cuenta los caracteres de la bio si se ve completa. Cuenta cuántas publicaciones tienen el ícono de fijada (pin). Si no hay captura de la página del enlace, los puntos del enlace que dependen de ella (funciona, abre rápido, lleva a una acción de venta, árbol de enlaces) son "no_verificable".
- La prueba (números de clientas, años, premios) NO es el diferenciador. El diferenciador dice qué te hace distinta o cómo trabajas diferente. Si la bio solo tiene frases genéricas ("construye y protege tu futuro"), el punto 14 es "no_cumple".
- Punto 1: mira solo el círculo de la foto de perfil. Es "cumple" únicamente si es un primer plano: la cara (de la frente a la barbilla) ocupa más o menos la mitad o más de la altura del círculo y se ven hombros, como mucho. Si se ve el torso, la cintura o el cuerpo entero, o la cara es pequeña dentro del círculo, es "no_cumple".
- Punto 2: es "no_cumple" solo si la foto está oscura, a contraluz, borrosa, de perfil o con gafas oscuras. Que la cara se vea pequeña o lejos ya se califica en el punto 1, no aquí.
- Punto 39: solo es "cumple" si las tres fijadas existen y cada portada trae texto claro dentro de la imagen. Una foto sin texto, o menos de 3 fijadas, es "no_cumple".
- Punto 21: si hay captura de la página del enlace y se ve cargada completa, es "cumple" (la observación dice que abre y se ve completa). No exijas medir la velocidad.
- El ícono de fijada es una chincheta pequeña y es distinto del ícono de varias fotos (carrusel) y del de video (reel). Si la persona te dice cuántas fijadas tiene, usa ese número. Si no, cuenta solo las chinchetas que veas con claridad y ante la duda cuenta menos.
- Punto 10: si el username tiene abreviaturas o letras difíciles de dictar, no_cumple. Punto 11: si tiene un punto, un guion bajo o un número, no_cumple.
- Punto 23: si la página del enlace es una página propia y no una lista de enlaces tipo árbol, el punto es "cumple" y la observación dice que no usas árbol de enlaces. Solo es "no_cumple" si es un árbol con más de 3 opciones o con la principal no primero.
- Puntos 25 al 34: si "lectura.destacadas" dice que no hay destacadas, TODOS son "no_cumple", incluso los de nombres, portadas y destacadas viejas, con la observación "No tienes destacadas." (más lo que corresponda). No marques "cumple" un punto solo porque no hay nada que revisar.
- Puntos 35 al 40: usa el conteo de "lectura.publicaciones_fijadas". Si hay menos de 3 fijadas, los puntos 36 a 38 que no tengan su publicación son "no_cumple".
- Los puntos de destacadas que solo aplican a cierto negocio (cómo llegar, políticas) son "no_verificable" si no se puede saber si aplican.
- La observación habla de lo que se ve, en segunda persona (tuteo, español neutro con sabor de Puerto Rico, sin voseo): "Tu foto es de cuerpo entero…", "Tu bio dice…". Una o dos frases cortas, concretas, con lo que realmente se ve (cita textos reales entre comillas cuando ayude). No repitas la regla del checklist ni des consejos largos: los consejos ya están en el checklist. Sin guiones largos (—), sin emojis, sin frases como "es importante" o "potenciar".
- Si un punto cumple, la observación dice qué se ve bien, también corta.
- Además devuelve "resumenes": 6 textos, uno por sección en orden (foto, nombre y username, bio, enlace y categoría, destacadas, pineadas). Cada uno de 1 a 2 frases en segunda persona que resumen lo más importante de esa sección: qué está fuerte y qué falla. Si no hubo capturas suficientes de una sección, dilo con una frase.
- No pongas puntajes ni juicios generales sobre la persona.

LOS 40 PUNTOS
${lista}`;
}

function auditBanda(p: number): { nombre: string; que_hacer: string } {
  if (p >= 35) return { nombre: "Perfil que vende", que_hacer: "Mantenerlo al día cada mes." };
  if (p >= 24) return { nombre: "Perfil que informa, pero no cierra", que_hacer: "Arreglar la prioridad alta esta semana." };
  return { nombre: "Perfil que pierde clientas", que_hacer: "Rehacer bio, enlace y destacadas antes de publicar más contenido." };
}

async function handleAuditoriaIA(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const origin = request.headers.get("Origin") || "";
  const permitidos = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  if (!permitidos.includes(origin)) return json({ ok: false, error: "origen_no_permitido" }, 403, cors);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }
  const usuario = String(body.usuario || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9._]{1,30}$/.test(usuario)) return json({ ok: false, error: "usuario_invalido" }, 400, cors);
  const imgs: string[] = Array.isArray(body.imagenes) ? body.imagenes : [];
  if (imgs.length < 1 || imgs.length > 4) return json({ ok: false, error: "imagenes_1_a_4" }, 400, cors);
  for (const im of imgs) {
    if (typeof im !== "string" || !/^data:image\/(jpeg|png|webp);base64,/.test(im)) return json({ ok: false, error: "imagen_invalida" }, 400, cors);
    if (im.length > 3_000_000) return json({ ok: false, error: "imagen_muy_grande" }, 413, cors);
  }

  // Límite de uso: 5 por persona al día y 300 en total al día (cuida el gasto de OpenAI).
  const dia = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "sin-ip";
  const kIp = `rl:auditoria:${dia}:${ip}`, kAll = `rl:auditoria:${dia}:total`;
  const nIp = parseInt((await env.ESTRATEGIAS.get(kIp)) || "0", 10);
  const nAll = parseInt((await env.ESTRATEGIAS.get(kAll)) || "0", 10);
  if (nIp >= 5) return json({ ok: false, error: "limite_diario" }, 429, cors);
  if (nAll >= 300) return json({ ok: false, error: "limite_total" }, 429, cors);
  await env.ESTRATEGIAS.put(kIp, String(nIp + 1), { expirationTtl: 172800 });
  await env.ESTRATEGIAS.put(kAll, String(nAll + 1), { expirationTtl: 172800 });

  const fij = Number.isInteger(body.fijadas) && body.fijadas >= 0 && body.fijadas <= 3 ? body.fijadas : null;
  const contenido: any[] = [{ type: "text", text: `Estas son las capturas del perfil @${usuario}. Haz la auditoría de los 40 puntos.` + (fij !== null ? ` La persona indica que tiene ${fij} publicaciones fijadas.` : "") }];
  for (const im of imgs) contenido.push({ type: "image_url", image_url: { url: im, detail: "high" } });
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1",
      temperature: 0.2,
      messages: [
        { role: "system", content: auditPrompt(usuario) },
        { role: "user", content: contenido },
      ],
      response_format: { type: "json_schema", json_schema: { name: "auditoria", strict: true, schema: AUDIT_SCHEMA } },
    }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, error: "openai_error", status: r.status, detail: data?.error?.message || "" }, 502, cors);
  let out: any;
  try { out = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { return json({ ok: false, error: "respuesta_invalida" }, 502, cors); }

  const porN: Record<number, { estado: string; observacion: string }> = {};
  for (const it of out.items || []) if (it && Number.isInteger(it.n)) porN[it.n] = it;
  const secciones = AUDIT_SECCIONES.map((titulo, s) => ({ titulo, resumen: String((out.resumenes || [])[s] || ""), items: [] as any[] }));
  let puntos = 0;
  AUDIT_ITEMS.forEach((it, i) => {
    const x = porN[i + 1];
    const estado = x && ["cumple", "no_cumple", "no_verificable"].includes(x.estado) ? x.estado : "no_verificable";
    if (estado === "cumple") puntos++;
    secciones[it.s].items.push({ n: i + 1, texto: it.t, estado, observacion: x?.observacion || "No se pudo revisar este punto con las capturas." });
  });
  try {
    await env.ESTRATEGIAS.put(`auditoria-log:${Date.now()}`, JSON.stringify({ usuario, puntos }), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { /* el registro es opcional */ }
  return json({ ok: true, usuario, puntos, total: AUDIT_ITEMS.length, banda: auditBanda(puntos), lectura: out.lectura || null, secciones }, 200, cors);
}

// --- Generador de hooks a la medida (bono "Lista de hooks") -----------------
const HOOKS_GRUPOS = [
  { id: "tension", titulo: "Hooks con tensión", cuantos: 10, que: "Dos hooks por cada uno de los cinco principios de Gianie, en este orden: romper una creencia, generar incongruencia, hacer una comparación, formular una pregunta real, decir una frase disruptiva. El campo 'principio' dice cuál usa cada uno." },
  { id: "atraer", titulo: "Para atraer gente nueva", cuantos: 5, que: "Hooks pensados para que te descubra quien todavía no te sigue." },
  { id: "conectar", titulo: "Para conectar", cuantos: 5, que: "Hooks que cuentan algo personal o de bastidores y generan cercanía." },
  { id: "vender", titulo: "Para vender", cuantos: 5, que: "Hooks que llevan al servicio o a una oferta, sin sonar a anuncio." },
];
const HOOKS_SCHEMA = {
  type: "object", additionalProperties: false, required: ["grupos"],
  properties: { grupos: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "hooks"],
    properties: { id: { type: "string", enum: HOOKS_GRUPOS.map((g) => g.id) },
      hooks: { type: "array", items: { type: "object", additionalProperties: false, required: ["hook", "principio", "en_pantalla"],
        properties: { hook: { type: "string" }, principio: { type: "string" }, en_pantalla: { type: "string" } } } } } } } },
};
const HOOKS_CAMPOS: Record<string, number> = { profesion: 80, servicio: 160, clienta: 160, problema: 220, resultado: 160, extra: 300 };

function hooksPrompt(d: Record<string, string>): string {
  return `Eres la estratega de contenido de Step Her Up, la marca de Gianie Milet (Puerto Rico). Escribes los PRIMEROS segundos de videos cortos (reels) para una mujer profesional. Escribe como lo diría ella hablando a cámara.

DATOS DE LA PERSONA
- A qué se dedica: ${d.profesion}
- Servicio principal: ${d.servicio}
- A quién ayuda: ${d.clienta}
- Problema que tiene su clienta antes de comprarle: ${d.problema}
- Resultado que logra: ${d.resultado || "(no lo indicó)"}
- Algo real que le ha pasado o que le han dicho (opcional): ${d.extra || "(no lo indicó)"}

PRINCIPIOS DE GIANIE PARA UN HOOK
- Detiene a la persona, la ubica rápido en el tema y abre una pregunta en su mente.
- Cinco formas de crear tensión: romper una creencia (presentas una creencia conocida, tomas la postura contraria y prometes explicar por qué); generar incongruencia (unes dos ideas que parecen no encajar); hacer una comparación (dos situaciones con el mismo criterio para revelar una diferencia); formular una pregunta real (algo que la audiencia de verdad se pregunta); decir una frase disruptiva (postura firme, específica y defendible, no una exageración vacía).
- El hook promete algo que el video realmente puede entregar.
- En la etapa de atraer, mientras menos valor des en el hook y más te acerques a lo que ella siente, mejor.

REGLAS
1. Todo tiene que ser específico de ESTA profesión y de ESTA clienta: usa su vocabulario, sus situaciones y sus dolores. Si el hook podría servirle igual a cualquier otra profesión, está mal: reescríbelo.
2. Máximo 18 palabras por hook. Una sola idea. Se entiende en un segundo.
3. Español de Puerto Rico, tuteo, frases cortas, tono cálido y directo. Sin guiones largos (—), sin signos de exclamación seguidos, sin emojis.
4. No uses estas frases quemadas: "el error que cometen casi todas", "nadie te dice esto", "no es X, es Y", "hoy te traigo", "en este video te voy a enseñar", "¿y si te dijera que…?", "el secreto de", "esto lo cambia todo", "guarda este video".
5. NO inventes cifras, años de experiencia, resultados, nombres ni testimonios. Si un hook necesita un dato personal real (un número, una frase que dijo una clienta, un año), déjalo entre [corchetes] con una indicación corta, por ejemplo [número de clientas] o [frase que te dijo una clienta]. Usa corchetes en pocos hooks, solo cuando haga falta; el resto debe poder grabarse tal cual.
   Tampoco inventes hechos personales de la persona: historias suyas ("a mí también me pasó", "yo era…"), citas de clientas ("me dijeron…"), frecuencias ("lo veo todos los días", "mil veces"), años de experiencia ni cómo trabaja si no lo dijo. Si el dato extra de arriba no trae una historia real, los hooks de "conectar" deben ser de bastidores o de opinión que cualquiera pueda grabar tal cual (lo que haces hoy, lo que piensas, lo que le dirías a ella), o llevar corchetes como [algo que te pasó con una clienta]. Solo puedes usar como hecho lo que ella escribió en los datos.
   En el grupo "conectar" está PROHIBIDO afirmar algo que ella hizo, comió, vivió o pensó hoy, ayer o alguna vez ("hoy saqué…", "esta semana me pasó…", "yo también…", "a veces yo…", "prefiero…"). Cada hook de ese grupo debe ser una de estas tres cosas: (a) una invitación o pregunta directa a la clienta ("Cuéntame qué es lo que más te cuesta de…"); (b) un adelanto de contenido que ella pueda cumplir grabando ("Te muestro cómo [lo que vas a mostrar]"); (c) un hook con un hueco [entre corchetes] para su dato real ("Hoy [lo que hiciste hoy] y esto fue lo que aprendí").
9. Español natural de Puerto Rico: nada de frases traducidas o raras ("a las correas", "en tu mundo", "esclava de"). Si una frase no la diría una mujer boricua hablando a cámara, reescríbela.
6. No prometas resultados garantizados ni ingresos.
7. 'en_pantalla' es el texto corto (máximo 6 palabras, en mayúsculas) que va escrito en el primer cuadro del video, para que se entienda también sin sonido.
8. 'principio' en el grupo "tension" es el nombre del principio que usa (Romper una creencia, Generar incongruencia, Hacer una comparación, Formular una pregunta real, Frase disruptiva). En los demás grupos déjalo como una etiqueta de 2 a 3 palabras que diga el ángulo (por ejemplo "Historia personal", "Pregunta a tu clienta", "Bastidores").

ENTREGA los grupos con esta cantidad exacta de hooks:
${HOOKS_GRUPOS.map((g) => `- ${g.id}: ${g.cuantos}. ${g.que}`).join("\n")}`;
}

async function handleHooksIA(request: Request, env: Env, cors: HeadersInit): Promise<Response> {
  const origin = request.headers.get("Origin") || "";
  const permitidos = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim());
  if (!permitidos.includes(origin)) return json({ ok: false, error: "origen_no_permitido" }, 403, cors);
  let body: any;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }
  const d: Record<string, string> = {};
  for (const [k, max] of Object.entries(HOOKS_CAMPOS)) d[k] = String(body[k] || "").replace(/\s+/g, " ").trim().slice(0, max);
  for (const k of ["profesion", "servicio", "clienta", "problema"]) if (d[k].length < 3) return json({ ok: false, error: "faltan_datos", campo: k }, 400, cors);

  // Límite de uso: 8 por persona al día y 400 en total al día (cuida el gasto de OpenAI).
  const dia = new Date().toISOString().slice(0, 10);
  const ip = request.headers.get("CF-Connecting-IP") || "sin-ip";
  const kIp = `rl:hooks:${dia}:${ip}`, kAll = `rl:hooks:${dia}:total`;
  const nIp = parseInt((await env.ESTRATEGIAS.get(kIp)) || "0", 10);
  const nAll = parseInt((await env.ESTRATEGIAS.get(kAll)) || "0", 10);
  if (nIp >= 8) return json({ ok: false, error: "limite_diario" }, 429, cors);
  if (nAll >= 400) return json({ ok: false, error: "limite_total" }, 429, cors);
  await env.ESTRATEGIAS.put(kIp, String(nIp + 1), { expirationTtl: 172800 });
  await env.ESTRATEGIAS.put(kAll, String(nAll + 1), { expirationTtl: 172800 });

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-4.1",
      temperature: 0.8,
      messages: [
        { role: "system", content: hooksPrompt(d) },
        { role: "user", content: "Escribe los hooks." },
      ],
      response_format: { type: "json_schema", json_schema: { name: "hooks", strict: true, schema: HOOKS_SCHEMA } },
    }),
  });
  const data: any = await r.json().catch(() => ({}));
  if (!r.ok) return json({ ok: false, error: "openai_error", status: r.status, detail: data?.error?.message || "" }, 502, cors);
  let out: any;
  try { out = JSON.parse(data?.choices?.[0]?.message?.content || "{}"); } catch { return json({ ok: false, error: "respuesta_invalida" }, 502, cors); }
  const grupos = HOOKS_GRUPOS.map((g) => {
    const hallado = (out.grupos || []).find((x: any) => x?.id === g.id);
    const hooks = ((hallado?.hooks || []) as any[])
      .filter((h) => h && typeof h.hook === "string" && h.hook.trim())
      .slice(0, g.cuantos)
      .map((h) => ({ hook: h.hook.trim(), principio: String(h.principio || "").trim(), en_pantalla: String(h.en_pantalla || "").trim() }));
    return { id: g.id, titulo: g.titulo, hooks };
  }).filter((g) => g.hooks.length);
  if (!grupos.length) return json({ ok: false, error: "respuesta_vacia" }, 502, cors);
  try {
    await env.ESTRATEGIAS.put(`hooks-log:${Date.now()}`, JSON.stringify({ profesion: d.profesion }), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch { /* el registro es opcional */ }
  return json({ ok: true, grupos }, 200, cors);
}

// ===== Autoguardado de métricas (setters/closers) =====
// El formulario del dashboard sincroniza el contador de cada persona con el Worker mientras cuenta (KV, borrador).
// A las 1:30 PM y a las 8:30 PM (hora de PR) lo que quedó sin enviar con el botón se guarda en el Sheet (mismo Apps Script
// del botón) y se publica en #setters. Si la persona ya lo guardó con el botón, el borrador está vacío y no se hace nada.
const METRICAS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxPo2XCgJzs9vCt_FZJOPt2-07ERFKElBzfOmxOPaJfg4BkUWLV5nJKgxPT_lbCIge5/exec";
const METRICAS_NOMBRES = ["Paula", "Mia", "Belen"];
const METRICAS_CAMPOS: Record<"setter" | "closer", [string, string][]> = {
  setter: [["llamadas", "Llamadas"], ["agendadas", "Agendadas"], ["noCalifica", "No califica"], ["noAtendieron", "No atendieron"], ["infoWhatsapp", "Info por WhatsApp"], ["cortaron", "Cortaron/colgaron"], ["shows", "Shows"], ["cierres", "Cierres"], ["ventas", "Cash"]],
  closer: [["agendas", "Agendas"], ["shows", "Shows"], ["noShows", "No shows"], ["cierres", "Cierres"], ["ventas", "Cash"]],
};
type BorradorMetricas = { rol: "setter" | "closer"; fecha: string; valores: Record<string, number>; closerCerro: string; ts: number };

async function handleMetricasBorrador(request: Request, url: URL, env: Env, cors: HeadersInit): Promise<Response> {
  const origin = request.headers.get("Origin") || "";
  if (!env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).includes(origin)) return json({ ok: false, error: "origen_no_permitido" }, 403, cors);
  const leerMarca = async (nombre: string): Promise<number> => {
    try { return Number(JSON.parse((await env.ESTRATEGIAS.get(`metricas:auto:${nombre}`)) || "{}").ts) || 0; } catch { return 0; }
  };
  if (request.method === "GET") {
    const nombre = url.searchParams.get("nombre") || "";
    if (!METRICAS_NOMBRES.includes(nombre)) return json({ ok: false, error: "nombre" }, 400, cors);
    return json({ ok: true, ts: await leerMarca(nombre) }, 200, cors);
  }
  let b: any;
  try { b = await request.json(); } catch { return json({ ok: false, error: "bad_json" }, 400, cors); }
  const nombre = String(b.nombre || "");
  if (!METRICAS_NOMBRES.includes(nombre)) return json({ ok: false, error: "nombre" }, 400, cors);
  const marca = await leerMarca(nombre);
  const clave = `metricas:borrador:${nombre}`;
  if (b.vaciar) { await env.ESTRATEGIAS.delete(clave); return json({ ok: true, ts: marca }, 200, cors); }
  // "inicio" = cuándo empezó el navegador a contar este bloque. Si el autoguardado corrió después, esos números ya están en el Sheet: que reinicie.
  if (marca > (Number(b.inicio) || 0)) return json({ ok: true, reset: true, ts: marca }, 200, cors);
  const rol: "setter" | "closer" = b.rol === "closer" ? "closer" : "setter";
  const fecha = String(b.fecha || "");
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(fecha)) return json({ ok: false, error: "fecha" }, 400, cors);
  const valores: Record<string, number> = {};
  for (const [k] of METRICAS_CAMPOS[rol]) valores[k] = Math.min(1000000, Math.max(0, Math.round(Number(b.valores?.[k]) || 0)));
  const closerCerro = METRICAS_NOMBRES.concat(["Gianie"]).includes(String(b.closerCerro || "")) ? String(b.closerCerro) : "";
  const borrador: BorradorMetricas = { rol, fecha, valores, closerCerro, ts: Date.now() };
  await env.ESTRATEGIAS.put(clave, JSON.stringify(borrador), { expirationTtl: 3 * 86400 });
  return json({ ok: true, ts: marca }, 200, cors);
}

async function metricasAScript(body: Record<string, unknown>): Promise<void> {
  const r = await fetch(METRICAS_SCRIPT_URL, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body), redirect: "follow" });
  const d = (await r.json().catch(() => null)) as { status?: string; message?: string } | null;
  if (!d || d.status !== "ok") throw new Error(d?.message || `apps script ${r.status}`);
}

async function guardarMetricasAuto(env: Env, slot: "tarde" | "cierre", cuando: number, ejecutar = true): Promise<{ guardados: string[]; vacios: string[]; errores: string[]; texto: string }> {
  const diaPR = new Date(cuando - 4 * 3600 * 1000).toISOString().slice(0, 10);
  const lock = `metricas:autolock:${slot}:${diaPR}`;
  if (ejecutar) {
    if (await env.ESTRATEGIAS.get(lock)) return { guardados: [], vacios: [], errores: ["ya_corrio"], texto: "" };
    await env.ESTRATEGIAS.put(lock, "1", { expirationTtl: 86400 });
  }
  const guardados: string[] = [], vacios: string[] = [], errores: string[] = [], lineas: string[] = [], avisos: string[] = [];
  for (const nombre of METRICAS_NOMBRES) {
    let b: BorradorMetricas | null = null;
    try { b = JSON.parse((await env.ESTRATEGIAS.get(`metricas:borrador:${nombre}`)) || "null"); } catch { b = null; }
    if (!b || !Object.values(b.valores || {}).some((v) => v > 0)) { vacios.push(nombre); continue; }
    const v = b.valores;
    const cuerpo: Record<string, unknown> = b.rol === "closer"
      ? { action: "addMetricas", rol: "closer", closer: nombre, fecha: b.fecha, agendas: v.agendas || 0, shows: v.shows || 0, noShows: v.noShows || 0, ventas: v.ventas || 0, cierres: v.cierres || 0 }
      : { action: "addMetricas", rol: "setter", setter: nombre, fecha: b.fecha, llamadas: v.llamadas || 0, agendadas: v.agendadas || 0, noCalifica: v.noCalifica || 0, noAtendieron: v.noAtendieron || 0, infoWhatsapp: v.infoWhatsapp || 0, cortaron: v.cortaron || 0, shows: v.shows || 0, cierres: v.cierres || 0, ventas: v.ventas || 0 };
    const resumen = METRICAS_CAMPOS[b.rol].filter(([k]) => v[k] > 0).map(([k, et]) => `${et} ${k === "ventas" ? fmtDinero(v[k]) : v[k]}`).join(" · ");
    if (!ejecutar) { guardados.push(`${nombre}: ${resumen}`); lineas.push(`• *${nombre}* (${b.fecha}): ${resumen}`); continue; }
    try {
      await metricasAScript(cuerpo);
      if (b.rol === "setter" && v.cierres > 0) {
        if (b.closerCerro) await metricasAScript({ action: "addMetricas", rol: "closer", closer: b.closerCerro, fecha: b.fecha, agendas: 0, shows: 0, noShows: 0, ventas: v.ventas || 0, cierres: v.cierres });
        else avisos.push(`${nombre} anotó ${v.cierres} cierre(s) sin elegir qué closer cerró la venta: no se cargó en el Ranking.`);
      }
      await env.ESTRATEGIAS.delete(`metricas:borrador:${nombre}`);
      await env.ESTRATEGIAS.put(`metricas:auto:${nombre}`, JSON.stringify({ ts: Date.now(), fecha: b.fecha, slot }), { expirationTtl: 3 * 86400 });
      guardados.push(nombre);
      lineas.push(`• *${nombre}*: ${resumen}`);
    } catch (e) { errores.push(`${nombre}: ${String(e)}`); }
  }
  const hora = slot === "tarde" ? "1:30 PM" : "8:30 PM";
  const texto = lineas.length ? `💾 *Guardado automático de las ${hora}*: estos números no se habían enviado con el botón y ya quedaron en el Tracker 👇\n${lineas.join("\n")}` : "";
  if (ejecutar && texto && env.SLACK_BOT_TOKEN) {
    try {
      const canales = await slack(env, "conversations.list", { types: "public_channel,private_channel", limit: "500", exclude_archived: "true" });
      const canal = (canales.channels || []).find((c: { name: string }) => c.name === SLACK_CANAL);
      if (canal) await slack(env, "chat.postMessage", {}, { channel: canal.id, text: texto });
      else errores.push(`slack: no encuentro #${SLACK_CANAL}`);
    } catch (e) { errores.push(`slack: ${String(e)}`); }
  }
  if (ejecutar && (errores.length || avisos.length)) await avisarThomas(env, `⚠️ *Autoguardado de métricas (${hora})*\n${[...errores, ...avisos].map((x) => "• " + x).join("\n")}`).catch(() => undefined);
  return { guardados, vacios, errores, texto };
}

export default {
  // Cron: cada 10 min. A los :00 y :30 recalcula qué etiqueta le toca a cada contacto; el resto de las veces aplica cambios.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Recordatorios de Slack (hora de Puerto Rico, UTC-4): 00:00 UTC = cierre 8:00 PM · 14:30 = metas 10:30 AM · 17:00 = números 1:00 PM.
    // Los crons corren todos los días; el filtro lunes-viernes y el candado anti-duplicado están en recordatorioProgramado.
    if (event.cron.startsWith("0 13 ")) { ctx.waitUntil(resumenSemanalProgramado(env, event.scheduledTime).catch(() => undefined)); return; }
    if (event.cron.startsWith("0 0 ") || event.cron.startsWith("0 17 ")) ctx.waitUntil(avisosParaThomas(env).catch(() => undefined));
    const tipo = event.cron.startsWith("0 0 ") ? "cierre" : event.cron.startsWith("30 14 ") ? "metas" : event.cron.startsWith("0 17 ") ? "numeros" : null;
    if (tipo) {
      ctx.waitUntil(recordatorioProgramado(env, tipo, event.scheduledTime).catch(() => undefined));
      return;
    }
    // Autoguardado de métricas: 1:30 PM (17:30 UTC) y 8:30 PM (00:30 UTC) de PR; se cuelga del cron de cada 10 minutos.
    const hm = new Date(event.scheduledTime).getUTCHours() * 60 + new Date(event.scheduledTime).getUTCMinutes();
    if (hm === 17 * 60 + 30 || hm === 30) ctx.waitUntil(guardarMetricasAuto(env, hm === 30 ? "cierre" : "tarde", event.scheduledTime).catch(() => undefined));
    const minuto = new Date(event.scheduledTime).getUTCMinutes();
    ctx.waitUntil((minuto % 30 < 10 ? etiquetasCalcular(env) : etiquetasAplicar(env)).then(() => undefined).catch(() => undefined));
  },
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
      if (url.pathname === "/webinar-resumen" && request.method === "GET") {
        return await handleWebinarResumen(env, cors);
      }
      if (url.pathname === "/email-evento" && request.method === "POST") {
        return await handleEmailEvento(request, url, env);
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
      if (url.pathname === "/admin/pipelines" && request.method === "GET") {
        return await handlePipelinesAdmin(request, env, cors);
      }
      if (url.pathname === "/admin/etiquetar-etapa" && request.method === "POST") {
        return await handleEtiquetarEtapa(request, url, env, cors);
      }
      if (url.pathname === "/admin/workflows" && request.method === "GET") {
        if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) return json({ ok: false, error: "unauthorized" }, 401, cors);
        const r = await fetch(`${GHL_BASE}/workflows/?locationId=${env.GHL_LOCATION_ID}`, { headers: ghlHeaders(env) });
        return json({ ok: r.ok, status: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0, 300) }, 200, cors);
      }
      if (url.pathname === "/metricas-borrador" && (request.method === "POST" || request.method === "GET")) {
        return await handleMetricasBorrador(request, url, env, cors);
      }
      if (url.pathname === "/admin/metricas-auto" && request.method === "POST") {
        if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) return json({ ok: false, error: "unauthorized" }, 401, cors);
        // Sin ?ejecutar=1 solo muestra los borradores que se guardarían (no escribe ni publica).
        return json({ ok: true, ...(await guardarMetricasAuto(env, url.searchParams.get("slot") === "cierre" ? "cierre" : "tarde", Date.now(), url.searchParams.get("ejecutar") === "1")) }, 200, cors);
      }
      if (url.pathname === "/admin/slack-recordatorio" && request.method === "POST") {
        if (!igualesSeguro(request.headers.get("X-Admin-Key") || "", env.ADMIN_KEY || "")) return json({ ok: false, error: "unauthorized" }, 401, cors);
        try { return json({ ok: true, ...(await recordatorioSetters(env, url.searchParams.get("enviar") === "1", (["metas", "cierre"].includes(url.searchParams.get("tipo") || "") ? url.searchParams.get("tipo") : "numeros") as "numeros" | "metas" | "cierre")) }, 200, cors); }
        catch (e) { return json({ ok: false, error: String(e) }, 502, cors); }
      }
      if (url.pathname.startsWith("/admin/etiquetas/")) {
        return await handleEtiquetasAdmin(request, url, env, cors);
      }
      if (url.pathname === "/admin/segmento" && request.method === "GET") {
        return await handleSegmentoAdmin(request, url, env, cors);
      }
      if (url.pathname === "/admin/contactos-recientes" && request.method === "GET") {
        return await handleContactosRecientes(request, url, env, cors);
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
      if (url.pathname === "/webinar-ingreso" && request.method === "POST") {
        return await handleWebinarIngreso(request, env, cors);
      }
      if (url.pathname === "/webinar-compra" && request.method === "POST") {
        return await handleWebinarCompra(request, env, cors);
      }
      if (url.pathname === "/stripe-webhook" && request.method === "POST") {
        return await handleStripeWebhook(request, env, cors);
      }
      if (url.pathname === "/auditoria-ia" && request.method === "POST") {
        return await handleAuditoriaIA(request, env, cors);
      }
      if (url.pathname === "/hooks-ia" && request.method === "POST") {
        return await handleHooksIA(request, env, cors);
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
