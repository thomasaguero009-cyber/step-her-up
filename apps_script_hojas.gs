/**
 * Step Her Up · Lee las hojas de ventas (Gianie) y de sesiones (Johanna) y las manda al panel Fulfillment.
 *
 * SOLO LEE: no escribe nada en ninguna hoja. Corre cada hora (después de ejecutar instalarDisparador una vez).
 * Es un script SUELTO en la cuenta de Thomas (no va dentro de la hoja de Gianie): alcanza con que esa cuenta pueda abrir las dos hojas.
 *
 * Antes de usarlo: Configuración del proyecto > Propiedades del script > agregar HOJAS_KEY con la clave que se cargó en el Worker.
 */

var WORKER_HOJAS_URL = 'https://step-her-up-calendar.thomasaguero009.workers.dev/hojas';
var VENTAS_ID = '1w9-Qh0a9Oj0YLBSiHB3cyDnZigtWEDRhaPWqEN8tHwE';   // Oficial STEPHERUP Sales & Collection Tracksheet (una pestaña por mes)
var JOHANNA_ID = '1X9oRgLxg4vlWPw8ijzqD8udqMth2CpOvOd3uZG-a4gg';  // Sesiones con Johanna (pestañas Fechas de servicio, Hoja de venta, Contactos)

// ---------- Ejecución ----------

function sincronizarHojas() {
  var clave = PropertiesService.getScriptProperties().getProperty('HOJAS_KEY');
  if (!clave) throw new Error('Falta la propiedad HOJAS_KEY (Configuración del proyecto > Propiedades del script).');
  var ventas = leerVentas_(SpreadsheetApp.openById(VENTAS_ID));
  var johanna = leerJohanna_(SpreadsheetApp.openById(JOHANNA_ID));
  var r = UrlFetchApp.fetch(WORKER_HOJAS_URL, {
    method: 'post', contentType: 'application/json', headers: { 'X-Hojas-Key': clave },
    payload: JSON.stringify({ ventas: ventas, johanna: johanna }), muteHttpExceptions: true
  });
  Logger.log('Worker respondió ' + r.getResponseCode() + ': ' + r.getContentText());
  if (r.getResponseCode() !== 200) throw new Error('El Worker no aceptó las hojas: ' + r.getContentText());
}

/** Se ejecuta UNA vez a mano: deja la sincronización corriendo cada hora. */
function instalarDisparador() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'sincronizarHojas') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sincronizarHojas').timeBased().everyHours(1).create();
}

/** Para ver qué leería, sin mandar nada. */
function probarLectura() {
  var v = leerVentas_(SpreadsheetApp.openById(VENTAS_ID)), j = leerJohanna_(SpreadsheetApp.openById(JOHANNA_ID));
  Logger.log('Ventas: ' + v.length + ' filas · Johanna: ' + j.length + ' alumnas');
  Logger.log(JSON.stringify(v.slice(0, 2))); Logger.log(JSON.stringify(j.slice(0, 2)));
}

// ---------- Ventas de Gianie ----------

function leerVentas_(ss) {
  var filas = [];
  ss.getSheets().forEach(function (hoja) {
    var nombre = hoja.getName();
    if (!esPestanaVentas_(nombre)) return;
    filas = filas.concat(filasVentas_(nombre, hoja.getDataRange().getValues()));
  });
  return enriquecerContactos_(filas);
}

/** Pestañas mensuales de octubre 2025 en adelante ("OCTUBRE 2026 - STEP HER UP", "NOVEMBER 2025 - ...", "Diciembre 2025"...). */
function esPestanaVentas_(nombre) {
  return /20(25|26)/.test(nombre) && /(ene|feb|mar|abr|may|jun|jul|ago|sep|oct|nov|dic)/i.test(sinTildes_(nombre)) && !/desembolso|expenses|projection|cost|payment/i.test(nombre);
}

function sinTildes_(t) { return String(t == null ? '' : t).normalize('NFD').replace(/[̀-ͯ]/g, ''); }

var MESES_ = { ene: 1, jan: 1, feb: 2, mar: 3, abr: 4, acr: 4, apr: 4, may: 5, jun: 6, jul: 7, ago: 8, aug: 8, sep: 9, set: 9, oct: 10, nov: 11, dic: 12, dec: 12 };

/** "11/ OCTUBRE/2026 (pod)", "19/10/2026", "6/mayo/20226", "7/octubre 2025" → 2026-10-11. Año: el que trae si es 2025 o 2026, si no el de la pestaña. */
function fechaVenta_(valor, anioPestana) {
  if (valor instanceof Date) return Utilities.formatDate(valor, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = sinTildes_(valor).toLowerCase();
  var m = s.match(/(\d{1,2})\s*[\/\-\s]\s*([a-z]{3,}|\d{1,2})/);
  if (!m) return '';
  var d = parseInt(m[1], 10), mes = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : MESES_[m[2].slice(0, 3)];
  if (!mes || mes > 12 || d > 31) return '';
  var ys = s.match(/\b(20\d\d)\b/), y = ys && (ys[1] === '2025' || ys[1] === '2026') ? parseInt(ys[1], 10) : anioPestana;
  return y + '-' + ('0' + mes).slice(-2) + '-' + ('0' + d).slice(-2);
}

function numero_(v) {
  if (typeof v === 'number') return v;
  var t = String(v == null ? '' : v).replace(/[^\d.\-]/g, '');
  return t === '' || t === '-' || t === '.' ? null : parseFloat(t);
}
function dinero_(n) { return '$' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function filasVentas_(nombrePestana, valores) {
  var anio = parseInt((nombrePestana.match(/20(2\d)/) || [0, '26'])[1], 10) + 2000;
  var h = -1;
  for (var i = 0; i < Math.min(valores.length, 6); i++) if (valores[i].some(function (c) { return /^nombre/i.test(sinTildes_(c).trim()); })) { h = i; break; }
  if (h < 0) return [];
  var cab = valores[h].map(function (c) { return sinTildes_(c).toLowerCase().replace(/\s+/g, ' ').trim(); });
  var col = function (re) { for (var i = 0; i < cab.length; i++) if (re.test(cab[i])) return i; return -1; };
  var C = {
    fecha: col(/^fecha de (inicio|venta)/), nombre: col(/^nombre/), tel: col(/^telefono/), correo: col(/^correo/), producto: col(/^tipo de producto/),
    tipoPago: col(/^tipo de pago/), cobrado: col(/cash collected|cantidad pagada/), pendiente: col(/receivable|adeudada/), total: col(/booked|monto total/),
    detalles: col(/^detalles de pago/), contrato: col(/^estado de contrato/), closer: col(/^closer 1/)
  };
  var g = function (f, k) { return C[k] >= 0 && f[C[k]] != null ? f[C[k]] : ''; };
  var salida = [];
  for (var r = h + 1; r < valores.length; r++) {
    var f = valores[r], nombre = String(g(f, 'nombre')).replace(/\s+/g, ' ').trim();
    var fecha = fechaVenta_(g(f, 'fecha'), anio);
    if (!nombre || !fecha) continue;
    var cob = String(g(f, 'cobrado')).trim(), pen = numero_(g(f, 'pendiente')), tot = numero_(g(f, 'total')), partes = [];
    if (/charge ?back/i.test(cob)) partes.push('CONTRACARGO (charge back)');
    var tp = String(g(f, 'tipoPago')).trim(); if (tp) partes.push(tp);
    var cobN = /charge ?back/i.test(cob) ? null : numero_(cob);
    if (cobN !== null) partes.push('cobrado ' + dinero_(cobN));
    if (pen) partes.push('pendiente ' + dinero_(pen));
    if (tot) partes.push('total ' + dinero_(tot));
    var ct = String(g(f, 'contrato')).trim(); if (ct) partes.push('contrato: ' + ct);
    var det = String(g(f, 'detalles')).replace(/\s+/g, ' ').trim(); if (det) partes.push(det);
    salida.push({
      nombre: nombre, correo: String(g(f, 'correo')).trim().toLowerCase(), telefono: String(g(f, 'tel')).replace(/[^\d+]/g, ''),
      producto: String(g(f, 'producto')).replace(/\s+/g, ' ').trim(), fecha: fecha, pago: partes.join('; '),
      closer: String(g(f, 'closer')).trim(), mes: nombrePestana.trim()
    });
  }
  return salida;
}

/** Si una misma clienta tiene correo o teléfono en otra fila, se lo presta a la que no lo tiene. */
function enriquecerContactos_(filas) {
  var clave = function (n) { return n.toLowerCase().replace(/\./g, ''); }, idx = {};
  filas.forEach(function (o) {
    var k = clave(o.nombre);
    if (k.split(' ').length < 2) return;
    var d = idx[k] = idx[k] || { correo: '', telefono: '' };
    if (o.correo && !d.correo) d.correo = o.correo;
    if (o.telefono && !d.telefono) d.telefono = o.telefono;
  });
  filas.forEach(function (o) {
    var d = idx[clave(o.nombre)];
    if (!d) return;
    if (!o.correo && d.correo) o.correo = d.correo;
    if (!o.telefono && d.telefono) o.telefono = d.telefono;
  });
  return filas;
}

// ---------- Sesiones con Johanna ----------

function leerJohanna_(ss) {
  var pestana = function (re) { var h = ss.getSheets().filter(function (s) { return re.test(sinTildes_(s.getName()).toLowerCase()); })[0]; return h ? h.getDataRange().getValues() : []; };
  return filasJohanna_(pestana(/fechas de servicio/), pestana(/contactos/), pestana(/hoja de venta/));
}

var NO_ES_SESION_ = /msj|mnj|mensaje|llamada|canc|stop|solicit|adicional|gestion|dispon|posible|nunca|\*\*\*|---/;

/** "22 oct", "5 dic 25", "27 febrero 26", "13/07/2026 5:15", "8/diciembre" → {mes, dia, anio|null}. Si no es una fecha de sesión, null. */
function fechaSesion_(valor) {
  if (valor instanceof Date) return { d: valor.getDate(), m: valor.getMonth() + 1, y: valor.getFullYear() };
  var s = sinTildes_(valor).toLowerCase().trim();
  if (!s || NO_ES_SESION_.test(s)) return null;
  var m = s.match(/^(\d{1,2})\s*[\/\s\-]\s*([a-z]{3,}|\d{1,2})\b\s*[\/\s]?\s*(\d{4}|\d{2})?(?!\d)/);
  if (!m) return null;
  var mes = /^\d+$/.test(m[2]) ? parseInt(m[2], 10) : MESES_[m[2].slice(0, 3)];
  if (!mes || mes > 12) return null;
  var y = null;
  if (m[3] && m[3].length === 4) y = parseInt(m[3], 10); else if (m[3] && m[3].length === 2 && /^2\d$/.test(m[3]) && !/:/.test(m[3])) y = 2000 + parseInt(m[3], 10);
  return { d: parseInt(m[1], 10), m: mes, y: y };
}

function iso_(y, m, d) { return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2); }

/** Inicio de la alumna: "7/octubre 2025" o "22/noviembre" (sin año: se deduce del vencimiento dd/mm/aaaa, que es inicio + 6 meses). */
function inicioAlumna_(inicio, vence) {
  var f = fechaSesion_(inicio);
  if (!f) return '';
  var y = f.y;
  if (!y) {
    var v = fechaSesion_(vence);
    if (v && v.y) y = v.m - 6 > 0 ? v.y : v.y - 1;     // el vencimiento cae 6 meses después del inicio
    else y = 2026;
  }
  return iso_(y, f.m, f.d);
}

function filasJohanna_(fechas, contactos, hojaVenta) {
  var tel = {}, extras = {};   // por nombre normalizado: teléfono, correo y notas de la hoja
  var nombreN = function (t) { return sinTildes_(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim(); };
  contactos.forEach(function (f, i) {
    if (i === 0 || !String(f[2]).trim()) return;
    tel[nombreN(f[2])] = { telefono: String(f[7] || '').replace(/[^\d+]/g, ''), correo: String(f[8] || '').trim().toLowerCase() };
  });
  hojaVenta.forEach(function (f) { var k = nombreN(f[0]); if (k && String(f[7] || '').trim()) extras[k] = String(f[7]).trim(); });

  var buscar = function (tabla, n) {
    if (tabla[n]) return tabla[n];
    var a = n.split(' ');
    for (var k in tabla) { var b = k.split(' '); if (a[0] === b[0] && (a.every(function (x) { return b.indexOf(x) >= 0; }) || b.every(function (x) { return a.indexOf(x) >= 0; }))) return tabla[k]; }
    return null;
  };

  var salida = [];
  fechas.forEach(function (f) {
    var nombre = String(f[0] == null ? '' : f[0]).replace(/\s+/g, ' ').trim();
    var paquete = String(f[1] == null ? '' : f[1]).replace(/\s+/g, ' ').trim();
    if (!nombre || /^nombre/i.test(nombre) || (!paquete && f.slice(7).every(function (c) { return !String(c).trim(); }))) return;
    var inicio = inicioAlumna_(f[5], f[6]), celdas = f.slice(7), fechasIso = [], otras = [], ant = inicio ? { y: parseInt(inicio.slice(0, 4), 10), m: parseInt(inicio.slice(5, 7), 10) } : null;
    celdas.forEach(function (c) {
      var txt = String(c == null ? '' : c).replace(/\s+/g, ' ').trim();
      if (!txt || /^[\*\-\s]+$/.test(txt)) return;
      var s = fechaSesion_(c);
      if (!s) { otras.push(txt); return; }
      var y = s.y || (ant ? ant.y : 2026);
      if (!s.y && ant && s.m < ant.m) y = ant.y + 1;    // las sesiones van en orden: si el mes retrocede, es el año siguiente
      ant = { y: y, m: s.m };
      fechasIso.push(iso_(y, s.m, s.d));
    });
    var n = nombreN(nombre), c = buscar(tel, n) || {}, extra = buscar(extras, n) || '';
    var nota = (paquete ? 'Paquete: ' + paquete + '; ' : '') + (inicio ? 'Inicio ' + inicio + '; ' : '') + (extra ? extra + '; ' : '') + otras.join(', ');
    salida.push({ nombre: nombre, correo: c.correo || '', telefono: c.telefono || '', sesiones: fechasIso.length, fechas: fechasIso, nota: nota.replace(/[;,\s]+$/, '') });
  });
  return salida;
}
