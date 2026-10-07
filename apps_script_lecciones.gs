// Backend chico para las pestanas de lecciones del Sheet - maneja
// agregar, eliminar y reordenar filas (el titulo y el modulo se definen
// al agregar; video y descripcion se siguen cargando a mano en el
// Sheet). Se pega en Extensiones -> Apps Script DEL MISMO Sheet (queda
// "bound", asi SpreadsheetApp.getActiveSpreadsheet() ya apunta solo).
//
// Soporta varias pistas de onboarding (Setters, Closers, etc.), cada
// una en su propia pestana del Sheet - el cliente manda que pestana
// tocar en body.sheetName. Si no lo manda, usa "Lecciones" (la pista
// general de siempre), asi los llamados viejos sin ese campo siguen
// funcionando igual.

function getSheet(nombre) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!sheet) throw new Error('No existe la pesta\u00f1a "' + nombre + '"');
  return sheet;
}

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var resultado;
    if (body.action === 'addLesson') {
      resultado = addLesson(getSheet(body.sheetName || 'Lecciones'), body.titulo, body.modulo);
    } else if (body.action === 'deleteLesson') {
      resultado = deleteLesson(getSheet(body.sheetName || 'Lecciones'), body.titulo);
    } else if (body.action === 'reorderLessons') {
      resultado = reorderLessons(getSheet(body.sheetName || 'Lecciones'), body.orden, body.moduloCambiado);
    } else if (body.action === 'moveLesson') {
      resultado = moveLesson(getSheet(body.sheetNameOrigen), getSheet(body.sheetNameDestino), body.titulo, body.modulo);
    } else if (body.action === 'addMetricas') {
      resultado = addMetricas(body);
    } else {
      throw new Error('Acci\u00f3n desconocida: ' + body.action);
    }
    return responder(resultado);
  } catch (err) {
    return responder({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
  return responder({ status: 'ok', message: 'Lecciones API viva' });
}

function responder(data) {
  var out = Object.assign({ status: 'ok' }, data || {});
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

// Lee las filas actuales con sus indices REALES de fila del sheet (1-based,
// incluyendo el header) - hace falta para poder editar/borrar la fila
// correcta despues. idx.modulo puede ser -1 en pestanas que todavia no
// tengan esa columna (no rompe nada, simplemente no se usa).
function leerFilas(sheet) {
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = {
    orden: header.indexOf('orden'),
    titulo: header.indexOf('titulo'),
    modulo: header.indexOf('modulo'),
  };
  var filas = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[idx.titulo]) continue;
    filas.push({
      rowIndex: i + 1,
      orden: r[idx.orden],
      titulo: r[idx.titulo],
      modulo: idx.modulo > -1 ? r[idx.modulo] : '',
    });
  }
  return { idx: idx, filas: filas };
}

function addLesson(sheet, titulo, modulo) {
  titulo = String(titulo || '').trim();
  modulo = String(modulo || '').trim();
  if (!titulo) throw new Error('Falta el t\u00edtulo de la lecci\u00f3n');
  var data = leerFilas(sheet);
  var maxOrden = data.filas.reduce(function (m, f) { return Math.max(m, Number(f.orden) || 0); }, 0);
  sheet.appendRow([maxOrden + 1, titulo, '', '', modulo]);
  return {};
}

function deleteLesson(sheet, titulo) {
  titulo = String(titulo || '').trim();
  var data = leerFilas(sheet);
  var fila = data.filas.filter(function (f) { return String(f.titulo).trim() === titulo; })[0];
  if (!fila) throw new Error('No se encontr\u00f3 la lecci\u00f3n "' + titulo + '"');
  sheet.deleteRow(fila.rowIndex);
  renumerar(sheet);
  return {};
}

// El cliente manda el ARRAY COMPLETO de titulos en el orden nuevo -
// se reescribe la columna Orden 1..N siguiendo ese orden, evitando
// depender de numeros de fila que puedan haber cambiado. moduloCambiado
// (opcional) es { titulo, modulo } cuando arrastrar la leccion tambien
// la movio a otro modulo/capitulo - asi el drag-and-drop sirve para
// reordenar Y para cambiar de modulo en un solo gesto.
function reorderLessons(sheet, ordenTitulos, moduloCambiado) {
  if (!Array.isArray(ordenTitulos) || !ordenTitulos.length) throw new Error('Orden inv\u00e1lido');
  var data = leerFilas(sheet);
  ordenTitulos.forEach(function (titulo, i) {
    var fila = data.filas.filter(function (f) { return String(f.titulo).trim() === String(titulo).trim(); })[0];
    if (fila) sheet.getRange(fila.rowIndex, data.idx.orden + 1).setValue(i + 1);
  });
  if (moduloCambiado && data.idx.modulo > -1) {
    var filaMod = data.filas.filter(function (f) { return String(f.titulo).trim() === String(moduloCambiado.titulo).trim(); })[0];
    if (filaMod) sheet.getRange(filaMod.rowIndex, data.idx.modulo + 1).setValue(moduloCambiado.modulo || '');
  }
  return {};
}

// Lee UNA fila completa por titulo, con sus campos por NOMBRE de
// columna (no por posicion) - asi no importa si el orden de columnas
// difiere entre la pestana de origen y la de destino al mover una
// leccion de pista.
function leerFilaCompleta(sheet, titulo) {
  titulo = String(titulo || '').trim();
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = {
    titulo: header.indexOf('titulo'),
    video: header.indexOf('videourl'),
    descripcion: header.indexOf('descripcion'),
    modulo: header.indexOf('modulo'),
  };
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idx.titulo]).trim() === titulo) {
      return {
        rowIndex: i + 1,
        titulo: values[i][idx.titulo],
        videoUrl: idx.video > -1 ? values[i][idx.video] : '',
        descripcion: idx.descripcion > -1 ? values[i][idx.descripcion] : '',
        modulo: idx.modulo > -1 ? values[i][idx.modulo] : '',
      };
    }
  }
  return null;
}

// Muda una leccion de una pestana a otra preservando su video y
// descripcion ya cargados (borrar+addLesson los perderia, ya que
// addLesson no los recibe). moduloNuevo es opcional - si no se manda,
// conserva el modulo que ya tenia.
function moveLesson(sheetOrigen, sheetDestino, titulo, moduloNuevo) {
  var fila = leerFilaCompleta(sheetOrigen, titulo);
  if (!fila) throw new Error('No se encontr\u00f3 la lecci\u00f3n "' + titulo + '" en la pesta\u00f1a de origen');
  var dataDestino = leerFilas(sheetDestino);
  var maxOrden = dataDestino.filas.reduce(function (m, f) { return Math.max(m, Number(f.orden) || 0); }, 0);
  var modulo = moduloNuevo != null ? moduloNuevo : fila.modulo;
  sheetDestino.appendRow([maxOrden + 1, fila.titulo, fila.videoUrl, fila.descripcion, modulo]);
  sheetOrigen.deleteRow(fila.rowIndex);
  renumerar(sheetOrigen);
  return {};
}

function renumerar(sheet) {
  var data = leerFilas(sheet);
  var ordenadas = data.filas.slice().sort(function (a, b) { return (Number(a.orden) || 0) - (Number(b.orden) || 0); });
  ordenadas.forEach(function (f, i) {
    sheet.getRange(f.rowIndex, data.idx.orden + 1).setValue(i + 1);
  });
}


// ===== Metricas del dia (formulario "Metricas" del dashboard) ===========
// El formulario manda un rol: "setter" o "closer".
//  - Setter -> UNA fila en el tracker (pestana con las columnas Fecha y Setter);
//    si le faltan las columnas "No califica" y "No respondio", se agregan solas.
//  - Closer -> UNA fila en la pestana de closers (la que tiene Fecha y Closer,
//    "Ranking"): Closer, Monto (= cash collected), Agendas, Shows, No shows y
//    Cierres. Si a esa pestana le faltan las columnas Agendas / Shows /
//    No shows / Cierres, se agregan solas a la derecha (no mueve las que ya hay).
// Cada dato se ubica por el NOMBRE de la columna, asi no importa el orden ni
// si dice "Leads" o "Llamadas", "Agendas" o "Agendadas".
function encontrarPestana(tipo) {
  var hojas = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < hojas.length; i++) {
    if (tipoDePestana(encabezados(hojas[i])) === tipo) return hojas[i];
  }
  throw new Error('No encontr\u00e9 la pesta\u00f1a de ' + tipo + ' (revis\u00e1 que tenga la fila de encabezados)');
}

// Agrega al final del encabezado las columnas que falten (devuelve los encabezados actualizados).
function asegurarColumnas(sheet, nombres) {
  var h = encabezados(sheet);
  nombres.forEach(function (n) {
    if (h.indexOf(n.toLowerCase()) === -1) {
      var ultima = h.length;
      while (ultima > 0 && h[ultima - 1] === '') ultima--;
      sheet.getRange(1, ultima + 1).setValue(n);
      h = encabezados(sheet);
    }
  });
  return h;
}

function filaPorEncabezado(h, valores) {
  var fila = new Array(h.length).fill('');
  Object.keys(valores).forEach(function (k) {
    var opciones = k.split('|');
    for (var i = 0; i < opciones.length; i++) {
      var c = h.indexOf(opciones[i]);
      if (c > -1) { fila[c] = valores[k]; return; }
    }
  });
  return fila;
}

function addMetricas(body) {
  var esCloser = body.rol === 'closer';
  var nombre = String(esCloser ? (body.closer || body.setter) : (body.setter || body.closer) || '').trim();
  if (!nombre) throw new Error('Falta el nombre');
  var fecha = String(body.fecha || '');
  var cash = Number(body.ventas) || 0;
  if (esCloser) {
    var sheetC = encontrarPestana('closers');
    repararEncabezados(sheetC);
    var hC = asegurarColumnas(sheetC, ['Agendas', 'Shows', 'No shows', 'Cierres']);
    sheetC.appendRow(filaPorEncabezado(hC, {
      'fecha': fecha,
      'closer': nombre,
      'monto': cash,
      'agendas': Number(body.agendas) || 0,
      'shows': Number(body.shows) || 0,
      'no shows|noshows|no show': Number(body.noShows) || 0,
      'cierres': Number(body.cierres) || 0,
    }));
  } else {
    var sheet = encontrarPestana('tracker');
    repararEncabezados(sheet);
    var h = asegurarColumnas(sheet, ['No califica', 'No respondi\u00f3']);
    sheet.appendRow(filaPorEncabezado(h, {
      'fecha': fecha,
      'setter': nombre,
      'llamadas|leads': Number(body.llamadas) || 0,
      'agendadas|agendas|llamadas agendadas': Number(body.agendadas) || 0,
      'no califica|nocalifica': Number(body.noCalifica) || 0,
      'no respondi\u00f3|no respondio|norespondio': Number(body.noRespondio) || 0,
      'shows': Number(body.shows) || 0,
      'cierres': Number(body.cierres) || 0,
      'ventas': cash,
    }));
  }
  return {};
}

// ===== Ordenar la hoja ===================================================
// Menu "Step Her Up -> Ordenar hoja". Es SEGURO para el dashboard: no mueve
// ni renombra columnas, no cambia los nombres de las pestanas ni los
// formatos de fecha/numero (el dashboard lee los valores tal como se ven).
// Solo: limpia espacios, unifica nombres, ordena el tracker por fecha,
// completa numeros de "orden" vacios, agrega listas desplegables, da
// formato a los encabezados y ordena/colorea las pestanas. Se puede correr
// las veces que haga falta. Lo que no puede arreglar solo lo avisa al final.
var SETTERS = ['Paula', 'Paola', 'Mia'];
var COLOR_VINO = '#5a1626';
var COLOR_ROSA = '#e88aa8';

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Step Her Up')
    .addItem('Ordenar hoja ahora', 'ordenarHoja')
    .addItem('Activar orden autom\u00e1tico', 'activarOrdenAutomatico')
    .addItem('Desactivar orden autom\u00e1tico', 'desactivarOrdenAutomatico')
    .addToUi();
}

// Texto con tildes que quedo danado al copiar/pegar el script (por ejemplo
// "No respondi\u221a\u2265" en vez de "No respondi\u00f3"): se vuelve a su forma correcta.
var MOJIBAKE = [['\u221a\u00b0', '\u00e1'], ['\u221a\u00a9', '\u00e9'], ['\u221a\u2260', '\u00ed'],
                ['\u221a\u2265', '\u00f3'], ['\u221a\u222b', '\u00fa'], ['\u221a\u00b1', '\u00f1']];
function repararTexto(t) {
  MOJIBAKE.forEach(function (par) { t = t.split(par[0]).join(par[1]); });
  return t;
}

// Arregla los encabezados danados que ya estan escritos en la hoja.
function repararEncabezados(sheet) {
  var n = sheet.getLastColumn();
  if (n < 1) return false;
  var rango = sheet.getRange(1, 1, 1, n);
  var cambio = false;
  var nuevos = rango.getValues()[0].map(function (x) {
    if (typeof x !== 'string') return x;
    var y = repararTexto(x);
    if (y !== x) cambio = true;
    return y;
  });
  if (cambio) rango.setValues([nuevos]);
  return cambio;
}

function encabezados(sheet) {
  if (sheet.getLastColumn() < 1) return [];
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function (x) { return repararTexto(String(x)).trim().toLowerCase(); });
}

function tipoDePestana(h) {
  if (h.indexOf('orden') > -1 && h.indexOf('titulo') > -1) return 'lecciones';
  if (h.indexOf('fecha') > -1 && h.indexOf('setter') > -1) return 'tracker';
  if (h.indexOf('fecha') > -1 && h.indexOf('closer') > -1) return 'closers';
  if (h.indexOf('fecha') > -1 && h.indexOf('gasto') > -1) return 'ads';
  return 'otra';
}

function parseFechaSheet(v) {
  if (v instanceof Date) return v.getTime();
  var m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1])).getTime() : null;
}

function letraDeColumna(n) {
  var s = '';
  while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

// Saca espacios sobrantes de las columnas de texto; devuelve cuantas celdas cambio.
function limpiarTexto(sheet, columnas) {
  var ultima = sheet.getLastRow();
  if (ultima < 2) return 0;
  var cambios = 0;
  columnas.forEach(function (c) {
    var rango = sheet.getRange(2, c + 1, ultima - 1, 1);
    var valores = rango.getValues();
    var nuevos = valores.map(function (f) {
      var v = f[0];
      if (typeof v !== 'string') return [v];
      var t = v.replace(/\s+/g, ' ').trim();
      if (t !== v) cambios++;
      return [t];
    });
    if (cambios) rango.setValues(nuevos);
  });
  return cambios;
}

// Hace todo el ordenamiento y devuelve { reporte, avisos } (sin mostrar nada).
function ejecutarOrden() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var reporte = [];
  var avisos = [];
  var hojas = ss.getSheets();

  hojas.forEach(function (sheet) {
    var nombre = sheet.getName();
    try {
      if (repararEncabezados(sheet)) reporte.push(nombre + ': arreglo encabezados con tildes danadas');
      var h = encabezados(sheet);
      if (!h.length) return;
      var tipo = tipoDePestana(h);

      // Encabezado: vino con letras blancas, fila fija.
      var cantidadEncabezados = 0;
      while (cantidadEncabezados < h.length && h[cantidadEncabezados] !== '') cantidadEncabezados++;
      var rangoHeader = sheet.getRange(1, 1, 1, Math.max(cantidadEncabezados, 1));
      rangoHeader.setBackground(COLOR_VINO).setFontColor('#ffffff').setFontWeight('bold').setVerticalAlignment('middle');
      sheet.setFrozenRows(1);

      var ultima = sheet.getLastRow();
      var hechas = [];

      if (tipo === 'tracker' || tipo === 'closers') {
        var colNombre = h.indexOf(tipo === 'tracker' ? 'setter' : 'closer');
        var limpias = limpiarTexto(sheet, [colNombre]);
        if (limpias) hechas.push('sac\u00f3 espacios sobrantes en ' + limpias + ' celdas');

        // Unifica mayusculas de los nombres conocidos (paula -> Paula).
        if (tipo === 'tracker' && ultima > 1) {
          var rN = sheet.getRange(2, colNombre + 1, ultima - 1, 1);
          var vN = rN.getValues();
          var corregidos = 0;
          vN = vN.map(function (f) {
            var v = String(f[0]);
            for (var i = 0; i < SETTERS.length; i++) {
              if (v.toLowerCase() === SETTERS[i].toLowerCase() && v !== SETTERS[i]) { corregidos++; return [SETTERS[i]]; }
            }
            return [f[0]];
          });
          if (corregidos) { rN.setValues(vN); hechas.push('unific\u00f3 ' + corregidos + ' nombres'); }
        }

        // Ordena por fecha (mas vieja arriba), salvo que haya formulas.
        if (ultima > 2) {
          var rango = sheet.getRange(2, 1, ultima - 1, h.length);
          var hayFormulas = rango.getFormulas().some(function (f) { return f.some(function (c) { return c !== ''; }); });
          var colFecha = h.indexOf('fecha');
          if (!hayFormulas && colFecha > -1) {
            var datos = rango.getValues();
            var sinFecha = datos.filter(function (f) { return parseFechaSheet(f[colFecha]) === null && f.some(function (c) { return c !== ''; }); });
            var conFecha = datos.map(function (f, i) { return { f: f, i: i, t: parseFechaSheet(f[colFecha]) }; })
              .filter(function (x) { return x.t !== null; });
            conFecha.sort(function (a, b) { return a.t - b.t || a.i - b.i; });
            var orden = conFecha.map(function (x) { return x.f; }).concat(sinFecha);
            var vacias = datos.length - orden.length;
            for (var k = 0; k < vacias; k++) orden.push(new Array(h.length).fill(''));
            var cambioOrden = orden.some(function (f, i) { return f.join('|') !== datos[i].join('|'); });
            if (cambioOrden) { rango.setValues(orden); hechas.push('orden\u00f3 las filas por fecha'); }
            if (sinFecha.length) avisos.push('"' + nombre + '": ' + sinFecha.length + ' fila(s) con la fecha mal escrita (deben ser DD/MM/AAAA); quedaron al final.');
          }
        }

        // Listas desplegables (aceptan otros valores, solo avisan).
        var filasValidar = Math.max(sheet.getMaxRows() - 1, 1);
        var lista = function (valores) {
          return SpreadsheetApp.newDataValidation().requireValueInList(valores, true).setAllowInvalid(true).build();
        };
        var existentes = function (col) {
          var vistos = [];
          if (col < 0 || ultima < 2) return vistos;
          sheet.getRange(2, col + 1, ultima - 1, 1).getValues().forEach(function (f) {
            var v = String(f[0]).trim();
            if (v && vistos.indexOf(v) === -1) vistos.push(v);
          });
          return vistos;
        };
        if (tipo === 'tracker') {
          sheet.getRange(2, colNombre + 1, filasValidar, 1).setDataValidation(lista(SETTERS));
          hechas.push('lista desplegable de setters');
        } else {
          var closers = ['Gianie'].concat(SETTERS);
          existentes(colNombre).forEach(function (v) { if (closers.indexOf(v) === -1) closers.push(v); });
          sheet.getRange(2, colNombre + 1, filasValidar, 1).setDataValidation(lista(closers));
          hechas.push('lista desplegable de closers');
        }
        // Los numeros no pueden ser negativos (solo avisa).
        ['llamadas', 'leads', 'agendadas', 'agendas', 'no califica', 'no respondi\u00f3', 'shows', 'no shows', 'cierres', 'ventas', 'monto', 'gasto'].forEach(function (n) {
          var c = h.indexOf(n);
          if (c > -1) {
            sheet.getRange(2, c + 1, filasValidar, 1).setDataValidation(
              SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(true).build());
          }
        });
        sheet.setTabColor(COLOR_VINO);
      }

      if (tipo === 'ads') sheet.setTabColor(COLOR_VINO);

      if (tipo === 'lecciones') {
        var cT = h.indexOf('titulo'), cO = h.indexOf('orden');
        var cV = h.indexOf('videourl'), cD = h.indexOf('descripcion');
        var l = limpiarTexto(sheet, [cT]);
        if (l) hechas.push('sac\u00f3 espacios sobrantes en ' + l + ' t\u00edtulos');

        // Completa los "orden" vacios con el siguiente numero libre.
        if (ultima > 1) {
          var rO = sheet.getRange(2, 1, ultima - 1, h.length);
          var vals = rO.getValues();
          var max = vals.reduce(function (m, f) { return Math.max(m, Number(f[cO]) || 0); }, 0);
          var completados = 0;
          vals.forEach(function (f, i) {
            if (f[cT] && (f[cO] === '' || f[cO] === null)) { max++; sheet.getRange(i + 2, cO + 1).setValue(max); completados++; }
          });
          if (completados) hechas.push('numer\u00f3 ' + completados + ' lecci\u00f3n(es) que no ten\u00edan orden');
        }
        // Datos que quedaron fuera de la tabla (columnas a la derecha).
        var ultimaCol = sheet.getLastColumn();
        if (ultimaCol > cantidadEncabezados && ultima > 1) {
          var fuera = sheet.getRange(2, cantidadEncabezados + 1, ultima - 1, ultimaCol - cantidadEncabezados).getValues();
          fuera.forEach(function (f, i) {
            var contenido = f.filter(function (c) { return c !== ''; });
            if (contenido.length) {
              avisos.push('"' + nombre + '": en la fila ' + (i + 2) + ', columnas ' + letraDeColumna(cantidadEncabezados + 1) + ' a ' + letraDeColumna(ultimaCol)
                + ' hay datos fuera de la tabla (' + contenido.filter(function (c) { return isNaN(Number(c)); }).join(' \u00b7 ').slice(0, 90) + '). Mov\u00e9 esa fila a la pesta\u00f1a que corresponda.');
            }
          });
        }
        [cV, cD].forEach(function (c) {
          if (c > -1 && ultima > 1) sheet.getRange(2, c + 1, ultima - 1, 1).setWrapStrategy(SpreadsheetApp.WrapStrategy.CLIP);
        });
        sheet.setTabColor(COLOR_ROSA);
      }

      // Ancho de columnas razonable (sin pasarse con los links largos).
      for (var c2 = 1; c2 <= Math.max(cantidadEncabezados, 1); c2++) {
        sheet.autoResizeColumn(c2);
        var ancho = sheet.getColumnWidth(c2);
        if (ancho > 360) sheet.setColumnWidth(c2, 360);
        else if (ancho < 90) sheet.setColumnWidth(c2, 90);
      }
      reporte.push(nombre + ' (' + tipo + '): ' + (hechas.length ? hechas.join(', ') : 'encabezado y anchos'));
    } catch (err) {
      avisos.push('"' + nombre + '": no se pudo ordenar (' + err + ')');
    }
  });

  // Orden de las pestanas: tracker, closers, ads, otras, lecciones.
  var peso = { tracker: 0, closers: 1, ads: 2, otra: 3, lecciones: 4 };
  var ordenadas = ss.getSheets().map(function (sh, i) { return { sh: sh, i: i, p: peso[tipoDePestana(encabezados(sh))] }; });
  ordenadas.sort(function (a, b) { return a.p - b.p || a.i - b.i; });
  ordenadas.forEach(function (x, pos) { ss.setActiveSheet(x.sh); ss.moveActiveSheet(pos + 1); });
  ss.setActiveSheet(ordenadas[0].sh);

  return { reporte: reporte, avisos: avisos };
}

function textoDeReporte(r) {
  var texto = 'Lo que hice:\n\n\u2022 ' + r.reporte.join('\n\u2022 ');
  if (r.avisos.length) texto += '\n\nPara revisar a mano:\n\n\u2022 ' + r.avisos.join('\n\u2022 ');
  return texto;
}

// A mano, desde el menu.
function ordenarHoja() {
  var ui = SpreadsheetApp.getUi();
  ui.alert('Hoja ordenada', textoDeReporte(ejecutarOrden()), ui.ButtonSet.OK);
}

// ===== Orden automatico ===================================================
// 1) Cada dia de madrugada (trigger de tiempo): corre todo el ordenamiento.
//    Si queda algo que no puede arreglar solo (por ejemplo datos fuera de la
//    tabla), manda UN mail con el aviso (y no repite el mismo aviso cada dia).
// 2) En el momento en que alguien escribe o pega (onEdit): limpia espacios y
//    unifica mayusculas de Setter / Closer al instante.
// 3) Las metricas que llegan del formulario ya entran limpias (addMetricas).
// Se activa UNA sola vez desde el menu: Step Her Up -> Activar orden automatico.
function ordenarHojaAutomatico() {
  var r = ejecutarOrden();
  var props = PropertiesService.getScriptProperties();
  var firma = r.avisos.join('||');
  if (r.avisos.length && props.getProperty('avisosEnviados') !== firma) {
    MailApp.sendEmail(Session.getEffectiveUser().getEmail(),
      'Step Her Up: hay cosas para revisar en el Sheet',
      'El orden autom\u00e1tico del Sheet encontr\u00f3 esto y no puede arreglarlo solo:\n\n\u2022 ' + r.avisos.join('\n\u2022 ')
      + '\n\nSheet: ' + SpreadsheetApp.getActiveSpreadsheet().getUrl());
    props.setProperty('avisosEnviados', firma);
  }
  if (!r.avisos.length) props.deleteProperty('avisosEnviados');
}

function activarOrdenAutomatico() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ordenarHojaAutomatico') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('ordenarHojaAutomatico').timeBased().everyDays(1).atHour(5).create();
  var ui = SpreadsheetApp.getUi();
  ui.alert('Orden autom\u00e1tico activado',
    'Desde ahora el Sheet se ordena solo todos los d\u00edas de madrugada, y al escribir se limpian al instante los nombres.\n\nOrden\u00e9 una vez ahora mismo:\n\n' + textoDeReporte(ejecutarOrden()),
    ui.ButtonSet.OK);
}

function desactivarOrdenAutomatico() {
  var borrados = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'ordenarHojaAutomatico') { ScriptApp.deleteTrigger(t); borrados++; }
  });
  SpreadsheetApp.getUi().alert(borrados ? 'Orden autom\u00e1tico desactivado.' : 'No hab\u00eda orden autom\u00e1tico activado.');
}

// Se ejecuta solo cada vez que alguien edita una celda (trigger simple).
function onEdit(e) {
  try {
    if (!e || !e.range || e.range.getRow() < 2 || e.range.getNumRows() * e.range.getNumColumns() > 500) return;
    var sheet = e.range.getSheet();
    var h = encabezados(sheet);
    var tipo = tipoDePestana(h);
    if (tipo !== 'tracker' && tipo !== 'closers') return;
    var valores = e.range.getValues();
    var cambio = false;
    for (var i = 0; i < valores.length; i++) {
      for (var j = 0; j < valores[i].length; j++) {
        var campo = h[e.range.getColumn() - 1 + j];
        var v = valores[i][j];
        if (['setter', 'closer'].indexOf(campo) === -1 || typeof v !== 'string') continue;
        var t = v.replace(/\s+/g, ' ').trim();
        var conocidos = campo === 'setter' ? SETTERS : SETTERS.concat(['Gianie']);
        for (var k = 0; k < conocidos.length; k++) {
          if (t.toLowerCase() === conocidos[k].toLowerCase()) t = conocidos[k];
        }
        if (t !== v) { valores[i][j] = t; cambio = true; }
      }
    }
    if (cambio) e.range.setValues(valores);
  } catch (err) {
    // un fallo aca no debe molestar a quien esta escribiendo
  }
}
