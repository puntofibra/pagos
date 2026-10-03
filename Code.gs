/**
 * Pagos FuturMovil — API en Apps Script
 * Guarda las contraseñas de pago (código + importe) en la hoja "Codigos".
 * La contraseña de administrador se comprueba aquí, en el servidor,
 * y no aparece en ningún archivo de GitHub.
 */

// Cambia aquí la contraseña de administrador cuando quieras.
const ADMIN_PASS = 'f7777';

const HOJA = 'Codigos';
const MAX_FALLOS = 20;   // fallos seguidos permitidos...
const VENTANA = 600;     // ...dentro de estos segundos (10 min)

function doGet() {
  return salida_({ ok: true, servicio: 'Pagos FuturMovil' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return salida_({ ok: false, error: 'Petición no válida' });
  }
  try {
    switch (req.action) {
      case 'login':  return salida_(login_(req));
      case 'list':   return salida_(admin_(req, function () { return { ok: true, items: leer_() }; }));
      case 'save':   return salida_(admin_(req, function () { return guardar_(req); }));
      case 'remove': return salida_(admin_(req, function () { return borrar_(req); }));
      default:       return salida_({ ok: false, error: 'Acción desconocida' });
    }
  } catch (err) {
    return salida_({ ok: false, error: 'Error del servidor' });
  }
}

/* ---------- Acceso ---------- */

function login_(req) {
  if (bloqueado_()) return { ok: false, error: 'Demasiados intentos. Espera unos minutos.' };
  const p = norm_(req.pass);
  if (!p) return { ok: false, error: 'Escribe la contraseña' };
  if (p === norm_(ADMIN_PASS)) return { ok: true, role: 'admin' };
  const fila = leer_().filter(function (x) { return norm_(x.code) === p; })[0];
  if (fila) return { ok: true, role: 'user', amount: fila.amount };
  fallo_();
  return { ok: false, error: 'Contraseña incorrecta' };
}

function admin_(req, fn) {
  if (bloqueado_()) return { ok: false, error: 'Demasiados intentos. Espera unos minutos.' };
  if (norm_(req.admin) !== norm_(ADMIN_PASS)) {
    fallo_();
    return { ok: false, auth: false, error: 'Sin permiso' };
  }
  return fn();
}

/* ---------- Contraseñas con importe ---------- */

function guardar_(req) {
  const code = String(req.code == null ? '' : req.code).trim();
  const amount = Math.round(Number(req.amount) * 100) / 100;
  if (!code) return { ok: false, error: 'Escribe la contraseña' };
  if (code.length > 40) return { ok: false, error: 'La contraseña es demasiado larga (máximo 40)' };
  if (norm_(code) === norm_(ADMIN_PASS)) return { ok: false, error: 'Esa contraseña está reservada' };
  if (!(amount > 0) || amount > 100000) return { ok: false, error: 'Importe no válido' };

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = hoja_();
    const filas = filas_(sh);
    const original = req.original == null ? '' : norm_(req.original);
    const propia = original ? filas.filter(function (f) { return norm_(f.code) === original; })[0] : null;
    const choque = filas.filter(function (f) {
      return norm_(f.code) === norm_(code) && (!propia || f.row !== propia.row);
    })[0];
    if (choque) return { ok: false, error: 'Ya existe esa contraseña' };

    const ahora = new Date();
    if (propia) {
      sh.getRange(propia.row, 1, 1, 2).setValues([[code, amount]]);
      sh.getRange(propia.row, 4).setValue(ahora);
    } else {
      sh.appendRow([code, amount, ahora, ahora]);
    }
    return { ok: true, items: leer_() };
  } finally {
    lock.releaseLock();
  }
}

function borrar_(req) {
  const objetivo = norm_(req.code);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const sh = hoja_();
    const f = filas_(sh).filter(function (x) { return norm_(x.code) === objetivo; })[0];
    if (!f) return { ok: false, error: 'No existe esa contraseña' };
    sh.deleteRow(f.row);
    return { ok: true, items: leer_() };
  } finally {
    lock.releaseLock();
  }
}

/* ---------- Hoja ---------- */

function hoja_() {
  let ss = null;
  try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; }
  if (!ss) {
    const props = PropertiesService.getScriptProperties();
    const id = props.getProperty('SHEET_ID');
    if (id) {
      ss = SpreadsheetApp.openById(id);
    } else {
      ss = SpreadsheetApp.create('Pagos FuturMovil');
      props.setProperty('SHEET_ID', ss.getId());
    }
  }
  let sh = ss.getSheetByName(HOJA);
  if (!sh) {
    sh = ss.insertSheet(HOJA);
    sh.getRange('A:A').setNumberFormat('@'); // las contraseñas siempre como texto (007 no pasa a 7)
    sh.appendRow(['Codigo', 'Importe', 'Creado', 'Modificado']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function filas_(sh) {
  const n = sh.getLastRow();
  if (n < 2) return [];
  const datos = sh.getRange(2, 1, n - 1, 2).getValues();
  const out = [];
  for (let i = 0; i < datos.length; i++) {
    const code = String(datos[i][0]);
    if (code !== '') out.push({ row: i + 2, code: code, amount: Number(datos[i][1]) });
  }
  return out;
}

function leer_() {
  return filas_(hoja_()).map(function (f) { return { code: f.code, amount: f.amount }; });
}

/* ---------- Utilidades ---------- */

function norm_(s) {
  return String(s == null ? '' : s).trim().toLowerCase();
}

function bloqueado_() {
  return Number(CacheService.getScriptCache().get('fallos') || 0) >= MAX_FALLOS;
}

function fallo_() {
  const c = CacheService.getScriptCache();
  c.put('fallos', String(Number(c.get('fallos') || 0) + 1), VENTANA);
}

function salida_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
