// Backend chico para las pestañas de lecciones del Sheet — maneja
// agregar, eliminar y reordenar filas (el título y el módulo se definen
// al agregar; video y descripción se siguen cargando a mano en el
// Sheet). Se pega en Extensiones → Apps Script DEL MISMO Sheet (queda
// "bound", así SpreadsheetApp.getActiveSpreadsheet() ya apunta solo).
//
// Soporta varias pistas de onboarding (Setters, Closers, etc.), cada
// una en su propia pestaña del Sheet — el cliente manda qué pestaña
// tocar en body.sheetName. Si no lo manda, usa "Lecciones" (la pista
// general de siempre), así los llamados viejos sin ese campo siguen
// funcionando igual.

function getSheet(nombre) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nombre);
  if (!sheet) throw new Error('No existe la pestaña "' + nombre + '"');
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
    } else {
      throw new Error('Acción desconocida: ' + body.action);
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

// Lee las filas actuales con sus índices REALES de fila del sheet (1-based,
// incluyendo el header) — hace falta para poder editar/borrar la fila
// correcta después. idx.modulo puede ser -1 en pestañas que todavía no
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
  if (!titulo) throw new Error('Falta el título de la lección');
  var data = leerFilas(sheet);
  var maxOrden = data.filas.reduce(function (m, f) { return Math.max(m, Number(f.orden) || 0); }, 0);
  sheet.appendRow([maxOrden + 1, titulo, '', '', modulo]);
  return {};
}

function deleteLesson(sheet, titulo) {
  titulo = String(titulo || '').trim();
  var data = leerFilas(sheet);
  var fila = data.filas.filter(function (f) { return String(f.titulo).trim() === titulo; })[0];
  if (!fila) throw new Error('No se encontró la lección "' + titulo + '"');
  sheet.deleteRow(fila.rowIndex);
  renumerar(sheet);
  return {};
}

// El cliente manda el ARRAY COMPLETO de títulos en el orden nuevo —
// se reescribe la columna Orden 1..N siguiendo ese orden, evitando
// depender de números de fila que puedan haber cambiado. moduloCambiado
// (opcional) es { titulo, modulo } cuando arrastrar la lección también
// la movió a otro módulo/capítulo — así el drag-and-drop sirve para
// reordenar Y para cambiar de módulo en un solo gesto.
function reorderLessons(sheet, ordenTitulos, moduloCambiado) {
  if (!Array.isArray(ordenTitulos) || !ordenTitulos.length) throw new Error('Orden inválido');
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

// Lee UNA fila completa por título, con sus campos por NOMBRE de
// columna (no por posición) — así no importa si el orden de columnas
// difiere entre la pestaña de origen y la de destino al mover una
// lección de pista.
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

// Muda una lección de una pestaña a otra preservando su video y
// descripción ya cargados (borrar+addLesson los perdería, ya que
// addLesson no los recibe). moduloNuevo es opcional — si no se manda,
// conserva el módulo que ya tenía.
function moveLesson(sheetOrigen, sheetDestino, titulo, moduloNuevo) {
  var fila = leerFilaCompleta(sheetOrigen, titulo);
  if (!fila) throw new Error('No se encontró la lección "' + titulo + '" en la pestaña de origen');
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
