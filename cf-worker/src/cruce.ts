// Cruce de las hojas (ventas de Gianie y sesiones de Johanna) con los contactos de GHL, por correo, teléfono y nombre.
// Función pura: la usa el panel Fulfillment (handleEntrega) con las filas que manda el Apps Script a POST /hojas.

export interface VentaFila { nombre: string; correo?: string; telefono?: string; producto: string; fecha: string; pago: string; closer?: string; mes?: string }
export interface JohannaFila { nombre: string; correo?: string; telefono?: string; sesiones: number; fechas: string[]; nota?: string }
export interface ContactoCruce { id: string; nombre: string; email: string; telefono: string }
export interface CruceContacto {
  compras: { producto: string; fecha: string }[]; tier: "high" | "low" | null; pago: string; closer: string; vence: string | null; venceOpc?: string[];
  johanna?: { sesiones: number; fechas: string[]; nota: string };
}
export interface CruceResultado { generado: string; porContacto: Record<string, CruceContacto>; sinTarjeta: any[] }

const nn = (t: string) => t.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
const toks = (t: string) => { const h: string[] = []; for (const w of nn(t).split(" ").filter(Boolean)) if (!h.length || h[h.length - 1] !== w) h.push(w); return h; };
const ph = (t?: string) => { const d = (t || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };
const PRODUCTO_CLAVE = /premium|coaching|shu program|shu mp/i;
const mesesDeAcceso = (f: string) => (f < "2026-10-01" ? 12 : 6);
const sumarMeses = (f: string, m: number) => {
  let [y, mo, d] = f.split("-").map(Number);
  mo += m; y += Math.floor((mo - 1) / 12); mo = ((mo - 1) % 12) + 1;
  d = Math.min(d, new Date(Date.UTC(y, mo, 0)).getUTCDate());
  return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
};

export function calcularCruce(ventas: VentaFila[], johanna: JohannaFila[], contactos: ContactoCruce[]): CruceResultado {
  const C = contactos.map((c) => ({ id: c.id, nombre: c.nombre, email: (c.email || "").toLowerCase(), tel: ph(c.telefono), t: toks(c.nombre) }));
  const casar = (r: { nombre?: string; correo?: string; telefono?: string }): string[] => {
    const em = (r.correo || "").toLowerCase(), tl = ph(r.telefono);
    let ids = C.filter((c) => em && c.email === em).map((c) => c.id); if (ids.length) return ids;
    ids = C.filter((c) => tl && c.tel === tl).map((c) => c.id); if (ids.length) return ids;
    const a = toks(r.nombre || "");
    ids = C.filter((c) => c.t.join(" ") === a.join(" ")).map((c) => c.id); if (ids.length) return ids;
    if (a.length >= 2) {
      for (const c of C) {
        const sa = new Set(a), sb = new Set(c.t);
        const comunes = [...sa].filter((x) => sb.has(x)).length;
        if (comunes >= 2 && ([...sa].every((x) => sb.has(x)) || [...sb].every((x) => sa.has(x)))) ids.push(c.id);
      }
    }
    return ids;
  };

  const por = new Map<string, VentaFila[]>(); const sin: VentaFila[] = [];
  for (const r of ventas) {
    const ids = casar(r);
    if (!ids.length) { if (PRODUCTO_CLAVE.test(r.producto || "") && (r.fecha || "") >= "2025-11-01") sin.push(r); continue; }
    for (const i of ids) por.set(i, [...(por.get(i) || []), r]);
  }

  const out: Record<string, CruceContacto> = {};
  for (const [i, filas] of por) {
    const fs = [...filas].sort((a, b) => (a.fecha || "").localeCompare(b.fecha || ""));
    const compras = fs.map((r) => ({ producto: r.producto || "Sin producto", fecha: r.fecha })).reverse();   // la más reciente primero
    const ult = fs.filter((r) => PRODUCTO_CLAVE.test(r.producto || ""));
    const ultima = ult[ult.length - 1];
    const tier: "high" | "low" | null = ultima ? (/premium|coaching/i.test(ultima.producto) ? "high" : "low") : null;   // por el producto de la compra más reciente
    const pagoTxt = fs.map((r) => r.pago).join(" | ");
    let pago = "";
    if (/charge ?back/i.test(pagoTxt)) pago = "Contracargo";
    else {
      const l = fs[fs.length - 1].pago || "";
      const pen = l.match(/pendiente \$([\d,\.]+)/), cob = l.match(/cobrado \$([\d,\.]+)/);
      if (pen && parseFloat(pen[1].replace(/,/g, "")) > 0) pago = `En cuotas: cobrado $${cob ? cob[1] : "?"}, pendiente $${pen[1]}`;
      else if (cob) pago = `Al día (cobrado $${cob[1]})`;
    }
    const closer = [...fs].reverse().find((r) => r.closer)?.closer || "";
    const vence = ultima?.fecha ? sumarMeses(ultima.fecha, mesesDeAcceso(ultima.fecha)) : null;
    const venceOpc = ultima?.fecha ? [...new Set([sumarMeses(ultima.fecha, 3), sumarMeses(ultima.fecha, mesesDeAcceso(ultima.fecha))])].sort() : [];
    out[i] = { compras, tier, pago, closer, vence, venceOpc };
  }

  for (const r of johanna) {
    for (const i of casar(r)) {
      out[i] = out[i] || { compras: [], tier: null, pago: "", closer: "", vence: null };
      out[i].johanna = { sesiones: r.sesiones, fechas: r.fechas, nota: (r.nota || "").slice(0, 160) };
      if (/stop|deuda|no ha pagado/i.test(JSON.stringify(r))) out[i].pago = (out[i].pago ? out[i].pago + " · " : "") + "Deuda (según Johanna)";
    }
  }

  const vistos = new Map<string, VentaFila>();
  for (const r of sin) vistos.set(nn(r.nombre), r);
  const sinTarjeta = [...vistos.values()].map((r) => ({ nombre: r.nombre, producto: r.producto, fecha: r.fecha, correo: r.correo || "", telefono: r.telefono || "" }));
  return { generado: new Date().toISOString(), porContacto: out, sinTarjeta };
}

// ===== Hoja "Control de vencimientos – Clientas Step Her Up" (Gianie, sale de los contratos): una fila por clienta con sus 4 plazos. =====
export interface VencFila {
  nombre: string; programa: string; version: string; inicio: string;
  grupVence: string; grupEstatus: string; unoVence: string; unoEstatus: string; psicoVence: string; psicoEstatus: string;
  grabado: string; contrato: string; notas: string;
}
// Apodos de GHL -> nombre en la hoja de Gianie (clave: nombre del contacto normalizado). Se agregan acá los que aparezcan.
export const ALIAS_VENC: Record<string, string> = {
  "ginnny": "Ginny Narváez", "lia cosmeticchemist": "Liannette Villanueva", "anil": "Anill Méndez",
  "symar": "Jossymar Álamo", "nei": "Neishlyann Ramírez", "lemi": "Lemishka D. Rodríguez Acevedo", "amanda madrigal": "Dinia Miranda Redondo",
  "gis ter": "Gisela Terrón",
  // Confirmados por la sesión de Fulfillment (6-nov-2026), a partir de su cruce con GHL.
  "lashes wax by julyanet": "Julyanet Aldea", "marycel rodriguez": "Marycel Cintrón", "vivi diaz": "Viviannette Díaz", "𝓥𝓲𝓿𝓲 𝓓𝓲́𝓪𝔃⛭": "Viviannette Díaz",
  "yamilette santana": "Yamilet Santana", "juliana": "Juliana Hernández", "johanna": "Johana Ortiz", "chanayska otero": "Chanayska Virella",
  "kelymar melendez nieves": "Kellymar Meléndez", "lesly ann": "Lesly Serrano", "dra virnalis santiago pharmd": "Virnalís Santiago", "lelis lelis": "Lelis Sabatier",
  "sangelines": "Sangelinés Navedo García", "yeslian gisselle": "Yeslian Marrero Pagán", "mialexa": "Mialexa (Mia) Matos", "claryssa claryssa": "Claryssa Cartagena",
  "genesis j olmo gonzalez": "Génesis Olmo", "sole cruz": "Sole Cruz", "sol cruz": "Sole Cruz", "angela malespin entrenadora de perros": "Ángela Malespín Hernández",
  // Dudosos (no activados hasta que Gianie o Thomas confirmen): mari carmen = Mari Alvarado, sel = Selmarie, fabi = Fabiola Itzel Morales, marynel huertas = Marynel Maldonado, pao = Paola Irizarry.
};
const sinParentesis = (t: string) => t.replace(/\([^)]*\)/g, " ");

// contactId -> filas de la hoja que le corresponden (puede haber 2: p. ej. "Chanayska Virella (premium enero)" y "(webinar)").
export function casarVencimientos(filas: VencFila[], contactos: { id: string; nombre: string; email?: string }[], alias: Record<string, string> = ALIAS_VENC): Map<string, VencFila[]> {
  const out = new Map<string, VencFila[]>();
  const F = filas.map((f) => ({ f, t: toks(sinParentesis(f.nombre)), t2: toks(f.nombre.replace(/[()]/g, " ")) }));   // t2 = con el apodo entre paréntesis: "Mialexa (Mia) Matos"
  const aliasN = new Map(Object.entries(alias).map(([k, v]) => [nn(k), nn(v)]));
  const poner = (id: string, f: VencFila) => { const l = out.get(id) || []; if (!l.includes(f)) l.push(f); out.set(id, l); };
  for (const c of contactos) {
    const ct = toks(c.nombre), cn = ct.join(" ");
    const via = aliasN.get(nn(c.nombre));
    for (const { f, t, t2 } of F) {
      const fn = t.join(" ");
      if (via && (fn === via || t2.join(" ") === via)) { poner(c.id, f); continue; }
      if (!t.length) continue;
      if (fn === cn) { poner(c.id, f); continue; }
      if (t.length >= 2) {
        const sb = new Set(ct);
        const casa = (ta: string[]) => { const sa = new Set(ta); const comunes = [...sa].filter((x) => sb.has(x)).length; return comunes >= 2 && ([...sa].every((x) => sb.has(x)) || [...sb].every((x) => sa.has(x))); };
        if (casa(t) || casa(t2)) poner(c.id, f);
      }
    }
  }
  // Filas con un solo nombre ("Beatriz", "Selmarie"): solo si UN contacto empieza con ese nombre y todavía no se casó con otra fila.
  for (const { f, t } of F) {
    if (t.length !== 1) continue;
    const posibles = contactos.filter((c) => toks(c.nombre)[0] === t[0] && !(out.get(c.id) || []).length);
    if (posibles.length === 1) poner(posibles[0].id, f);
  }
  return out;
}
