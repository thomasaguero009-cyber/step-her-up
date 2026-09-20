// Backend chico para la pestaña "Lecciones" del Sheet — solo maneja
// agregar, eliminar y reordenar filas (el título se define al agregar;
// video y descripción se siguen cargando a mano en el Sheet). Se pega
// en Extensiones → Apps Script DEL MISMO Sheet (queda "bound", así
// SpreadsheetApp.getActiveSpreadsheet() ya apunta solo).

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Lecciones');
    if (!sheet) throw new Error('No existe la pestaña "Lecciones"');

    var resultado;
    if (body.action === 'addLesson') {
      resultado = addLesson(sheet, body.titulo);
    } else if (body.action === 'deleteLesson') {
      resultado = deleteLesson(sheet, body.titulo);
    } else if (body.action === 'reorderLessons') {
      resultado = reorderLessons(sheet, body.orden);
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
// correcta después.
function leerFilas(sheet) {
  var values = sheet.getDataRange().getValues();
  var header = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
  var idx = {
    orden: header.indexOf('orden'),
    titulo: header.indexOf('titulo'),
  };
  var filas = [];
  for (var i = 1; i < values.length; i++) {
    var r = values[i];
    if (!r[idx.titulo]) continue;
    filas.push({ rowIndex: i + 1, orden: r[idx.orden], titulo: r[idx.titulo] });
  }
  return { idx: idx, filas: filas };
}

function addLesson(sheet, titulo) {
  titulo = String(titulo || '').trim();
  if (!titulo) throw new Error('Falta el título de la lección');
  var data = leerFilas(sheet);
  var maxOrden = data.filas.reduce(function (m, f) { return Math.max(m, Number(f.orden) || 0); }, 0);
  sheet.appendRow([maxOrden + 1, titulo, '', '']);
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
// depender de números de fila que puedan haber cambiado.
function reorderLessons(sheet, ordenTitulos) {
  if (!Array.isArray(ordenTitulos) || !ordenTitulos.length) throw new Error('Orden inválido');
  var data = leerFilas(sheet);
  ordenTitulos.forEach(function (titulo, i) {
    var fila = data.filas.filter(function (f) { return String(f.titulo).trim() === String(titulo).trim(); })[0];
    if (fila) sheet.getRange(fila.rowIndex, data.idx.orden + 1).setValue(i + 1);
  });
  return {};
}

function renumerar(sheet) {
  var data = leerFilas(sheet);
  var ordenadas = data.filas.slice().sort(function (a, b) { return (Number(a.orden) || 0) - (Number(b.orden) || 0); });
  ordenadas.forEach(function (f, i) {
    sheet.getRange(f.rowIndex, data.idx.orden + 1).setValue(i + 1);
  });
}
