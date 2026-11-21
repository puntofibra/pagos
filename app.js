(function () {
  'use strict';

  var MYPOS_BASE = 'https://mypos.com/@futurmovil/'; // solo se usa en el enlace del botón; nunca se muestra
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fmtEUR = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR' });

  function $(id) { return document.getElementById(id); }

  var adminPass = '';
  var editing = null;      // contraseña que se está editando
  var confirming = null;   // contraseña pendiente de confirmar el borrado
  var items = [];

  /* ---------- Servidor ---------- */

  // Una petición al servidor (con límite de 15 s).
  function apiUna(action, data) {
    var url = window.PAGOS_API;
    if (!url || !/^https?:\/\//.test(url)) return Promise.reject(new Error('config'));
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 15000);
    return fetch(url, {
      method: 'POST',
      body: JSON.stringify(Object.assign({ action: action }, data || {})),
      signal: ctrl.signal,
      redirect: 'follow'
    }).then(function (r) { return r.json(); })
      .then(function (j) { clearTimeout(timer); return j; },
            function (e) { clearTimeout(timer); throw e; });
  }

  // Si la conexión falla, se reintenta sola una vez antes de mostrar error.
  // El servidor acepta reintentos: guardar o borrar dos veces no duplica nada.
  function api(action, data) {
    return apiUna(action, data).catch(function (e) {
      if (e && e.message === 'config') throw e;
      return new Promise(function (r) { setTimeout(r, 700); })
        .then(function () { return apiUna(action, data); });
    });
  }

  // Despierta el servidor nada más abrir la app, mientras se escribe la contraseña.
  try { apiUna('ping').catch(function () {}); } catch (e) {}

  function textoError(err) {
    if (err && err.message === 'config') return 'Falta configurar la dirección del servidor (archivo config.js).';
    return 'No se pudo conectar. Revisa tu conexión e inténtalo de nuevo.';
  }

  /* ---------- Pantallas ---------- */

  var VIEWS = ['vLogin', 'vPay', 'vLibre', 'vNfc', 'vAdmin'];
  function show(id) {
    VIEWS.forEach(function (v) { $(v).hidden = v !== id; });
    $('pos').hidden = id === 'vAdmin';                                   // el datáfono solo se ve al meter la clave y al pagar
    $('pos').setAttribute('data-mode', id === 'vPay' ? 'pay' : 'login');
    window.scrollTo(0, 0);
  }

  // En ordenador el cursor va a la clave para escribir con el teclado; en el móvil no, para que no tape el datáfono.
  var fino = window.matchMedia('(pointer: fine)').matches;
  function foco() { if (fino) $('pass').focus(); }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function logout(msg) {
    pararNfc();
    nfcPass = ''; modoMovil = false; parMovil = '';
    try { if (/[?&]k=/.test(location.search)) history.replaceState(null, '', location.pathname); } catch (e) {}
    adminPass = '';
    editing = null;
    confirming = null;
    try { sessionStorage.removeItem('fm_admin'); } catch (e) {}
    $('pass').value = '';
    $('pass').type = 'password';
    $('eye').setAttribute('aria-pressed', 'false');
    $('loginError').textContent = msg || '';
    resetForm();
    show('vLogin');
    foco();
  }

  /* ---------- Entrar ---------- */

  $('loginForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var pass = $('pass').value.trim();
    var err = $('loginError');
    err.textContent = '';
    if (!pass) { err.textContent = 'Escribe la contraseña'; return; }
    var btn = $('loginBtn');
    btn.disabled = true;
    btn.firstElementChild.textContent = 'Conectando…';
    $('pos').classList.add('busy');
    api('login', { pass: pass }).then(function (res) {
      if (!res.ok) { fallo(res.error || 'Contraseña incorrecta'); return; }
      if (res.role === 'admin') {
        pedirLlave(pass, !!res.nueva);
      } else if (res.role === 'libre') {
        abrirLibre();
      } else {
        mostrarPago(Number(res.amount));
      }
    }).catch(function (e) { fallo(textoError(e)); })
      .then(function () {
        btn.disabled = false;
        btn.firstElementChild.textContent = 'Pulse ✓ para continuar';
        $('pos').classList.remove('busy');
      });
  });

  function fallo(msg) {
    var err = $('loginError');
    err.textContent = msg;
    var box = $('loginForm');
    box.classList.remove('shake');
    void box.offsetWidth;
    box.classList.add('shake');
    if (fino) $('pass').select(); else $('pass').value = '';
    pitido(220, 0.16);
  }

  $('eye').addEventListener('click', function () {
    var inp = $('pass');
    var visible = inp.type === 'text';
    inp.type = visible ? 'password' : 'text';
    this.setAttribute('aria-pressed', visible ? 'false' : 'true');
    this.setAttribute('aria-label', visible ? 'Mostrar contraseña' : 'Ocultar contraseña');
  });

  /* ---------- Pago ---------- */

  function mostrarPago(amount) {
    var parts = amount.toFixed(2).split('.');
    var box = $('payAmount');
    box.innerHTML = '';
    var i = document.createElement('span'); i.className = 'int'; i.textContent = parts[0];
    var d = document.createElement('span'); d.className = 'dec'; d.textContent = ',' + parts[1];
    var c = document.createElement('span'); c.className = 'cur'; c.textContent = '€';
    box.appendChild(i); box.appendChild(d); box.appendChild(c);

    $('payText').textContent = 'Pagar ' + fmtEUR.format(amount);
    $('ticketAmt').textContent = fmtEUR.format(amount);
    $('payLink').href = MYPOS_BASE + String(Number(amount));
    show('vPay');

    if (!reduce) {
      var target = Number(parts[0]);
      var start = null;
      var step = function (ts) {
        if (start === null) start = ts;
        var p = Math.min((ts - start) / 900, 1);
        i.textContent = String(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) requestAnimationFrame(step); else i.textContent = parts[0];
      };
      requestAnimationFrame(step);
      setTimeout(function () { i.textContent = parts[0]; }, 1300);
    }
  }

  $('payExit').addEventListener('click', function () { logout(''); });

  /* ---------- Importe libre ---------- */

  // Se teclea como en un datáfono: las cifras entran por la derecha y siempre quedan dos decimales (1250 = 12,50 €).
  var libreCent = 0;
  function pintaLibre() {
    var el = $('libreAmt');
    el.textContent = fmtEUR.format(libreCent / 100);
    el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
  }
  function abrirLibre() {
    libreCent = 0;
    pintaLibre();
    $('libreError').textContent = '';
    show('vLibre');
  }
  function teclaLibre(k) {
    var err = $('libreError');
    err.textContent = '';
    if (/^[0-9]$/.test(k)) {
      if (libreCent >= 10000) { err.textContent = 'Importe máximo 999,99 €'; pitido(220, 0.16); return; }
      libreCent = libreCent * 10 + Number(k);
    } else if (k === 'del') {
      libreCent = Math.floor(libreCent / 10);
    } else if (k === 'x') {
      if (libreCent > 0) libreCent = 0; else { logout(''); return; }
    } else if (k === 'ok') {
      if (libreCent < 1) { err.textContent = 'Teclee el importe, p. ej. 1250 = 12,50 €'; pitido(220, 0.16); return; }
      mostrarPago(libreCent / 100);
      return;
    }
    pintaLibre();
  }
  $('libreBtn').addEventListener('click', function () { teclaLibre('ok'); });

  /* ---------- Llave NFC del administrador ---------- */

  // En Android la llave se lee aquí mismo. En ordenador o iPhone sale un QR para pasarla con un móvil Android.
  var hayNfc = 'NDEFReader' in window;
  var nfcCtrl = null, nfcOcupado = false, nfcPass = '';
  var parCodigo = '', parTimer = null;      // QR que se enseña en este dispositivo
  var modoMovil = false, parMovil = '';     // este móvil está pasando la llave para otro dispositivo

  function nfcDi(t, cls) { $('nfcMsg').textContent = t; $('nfcIco').className = 'nfc-ico ' + (cls || ''); }
  function vibra(p) { try { if (navigator.vibrate) navigator.vibrate(p); } catch (e) {} }
  function pararNfc() {
    if (nfcCtrl) { try { nfcCtrl.abort(); } catch (e) {} nfcCtrl = null; }
    clearInterval(parTimer); parTimer = null; parCodigo = '';
    nfcOcupado = false;
  }

  function pantallaLlave(nueva) {
    $('nfcQr').hidden = true;
    $('nfcBtn').hidden = true;
    $('nfcIco').hidden = false;
    $('nfcTitle').textContent = nueva ? 'Registre su llave NFC' : 'Acerque su llave NFC';
    nfcDi('Un momento…', '');
    show('vNfc');
  }

  function pedirLlave(pass, nueva) {
    pararNfc();
    nfcPass = pass; modoMovil = false;
    pantallaLlave(nueva);
    if (hayNfc) escanear(true); else porQr();
  }

  function sinNfc() {
    if (modoMovil) nfcDi('No se puede usar el NFC. Enciéndalo y abra el QR con Chrome en un móvil Android.', 'err');
    else porQr();
  }

  function escanear(auto) {
    if (nfcCtrl) return;
    var ctrl = new AbortController(), lector;
    try { lector = new NDEFReader(); } catch (e) { sinNfc(); return; }
    lector.scan({ signal: ctrl.signal }).then(function () {
      if ($('vNfc').hidden) { try { ctrl.abort(); } catch (e) {} return; }
      nfcCtrl = ctrl;
      $('nfcBtn').hidden = true;
      nfcDi('Acerque la llave a la parte trasera del móvil', 'busca');
      lector.onreadingerror = function () { if (!nfcOcupado) nfcDi('No se ha podido leer la llave, acérquela de nuevo', 'err'); };
      lector.onreading = function (ev) { llaveLeida(String(ev.serialNumber || '')); };
    }).catch(function (err) {
      if (err && err.name === 'NotAllowedError') {
        $('nfcBtn').hidden = false;
        if (auto) nfcDi('Pulse ✓ y acerque su llave', '');
        else nfcDi('Hace falta permiso para usar el NFC. Acéptelo y pulse ✓.', 'err');
      } else sinNfc();
    });
  }
  $('nfcBtn').addEventListener('click', function () { escanear(false); });

  function llaveLeida(sn) {
    if (nfcOcupado) return;
    if (!sn) { nfcDi('La llave no tiene número de serie legible', 'err'); return; }
    nfcOcupado = true;
    nfcDi('Comprobando llave…', 'busca');
    var p = modoMovil ? api('llaveAutorizar', { codigo: parMovil, llave: sn }) : api('llave', { pass: nfcPass, llave: sn });
    p.then(function (res) {
      if (!res.ok) {
        nfcOcupado = false;
        pitido(220, 0.16); vibra([80, 60, 80]);
        nfcDi(res.error || 'Llave no autorizada', 'err');
        return;
      }
      pitido(880); vibra(60);
      if (modoMovil) {                       // se queda ocupado: ya no hay nada más que leer
        if (nfcCtrl) { try { nfcCtrl.abort(); } catch (e) {} nfcCtrl = null; }
        $('nfcTitle').textContent = res.nueva ? 'Llave guardada' : 'Llave correcta';
        nfcDi('Ya puede volver al otro dispositivo.', 'ok');
        return;
      }
      entrarCon(res.token, !!res.nueva);
    }).catch(function (e) { nfcOcupado = false; nfcDi(textoError(e), 'err'); });
  }

  function entrarCon(token, nueva) {
    pararNfc();
    nfcPass = '';
    adminPass = token;
    try { sessionStorage.setItem('fm_admin', token); } catch (e) {}
    entrarAdmin();
    toast(nueva ? 'Llave guardada: desde ahora se pedirá siempre esta' : 'Acceso concedido');
  }

  function porQr() {
    $('nfcTitle').textContent = 'Pase su llave con el móvil';
    nfcDi('Preparando código…', 'busca');
    api('llaveCodigo', { pass: nfcPass }).then(function (res) {
      if ($('vNfc').hidden || modoMovil) return;
      if (!res.ok) { nfcDi(res.error || 'No se pudo preparar el código', 'err'); return; }
      parCodigo = res.codigo;
      var url = location.origin + location.pathname + '?k=' + res.codigo;
      $('nfcQr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=0&data=' + encodeURIComponent(url);
      $('nfcQr').hidden = false;
      $('nfcIco').hidden = true;
      nfcDi('Escanee el QR con un móvil Android y acerque la llave NFC.', '');
      var n = 0, codigo = res.codigo;
      parTimer = setInterval(function () {
        if (++n > 95) { logout('Tiempo agotado. Vuelva a intentarlo.'); return; }
        apiUna('llaveEstado', { codigo: codigo }).then(function (r) {
          if (parCodigo !== codigo) return;
          if (r.ok && r.token) entrarCon(r.token, !!r.nueva);
          else if (r.caducado) logout('El código ha caducado. Vuelva a intentarlo.');
        }).catch(function () {});
      }, 3000);
    }).catch(function (e) { nfcDi(textoError(e), 'err'); });
  }

  // Este móvil ha abierto el QR de otro dispositivo: solo tiene que leer la llave.
  function abrirComoLlave(codigo) {
    modoMovil = true; parMovil = codigo;
    pantallaLlave(false);
    api('llaveInfo', { codigo: codigo }).then(function (res) {
      if (!modoMovil) return;
      if (!res.ok) { nfcDi(res.error || 'El código ha caducado. Vuelva a escanear el QR.', 'err'); return; }
      if (res.nueva) $('nfcTitle').textContent = 'Registre su llave NFC';
      if (hayNfc) escanear(true);
      else nfcDi('Este navegador no puede leer NFC. Abra el QR con Chrome en un móvil Android con el NFC encendido.', 'err');
    }).catch(function (e) { nfcDi(textoError(e), 'err'); });
  }

  /* ---------- Teclado del datáfono ---------- */

  var audio = null;
  function pitido(frec, dur) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.type = 'square'; o.frequency.value = frec;
      g.gain.setValueAtTime(0.035, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + (dur || 0.07));
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + (dur || 0.07));
    } catch (e) {}
  }

  function tecla(k) {
    var pagando = !$('vPay').hidden, inp = $('pass');
    pitido(k === 'ok' ? 880 : (k === 'x' ? 330 : 660));
    try { if (navigator.vibrate) navigator.vibrate(8); } catch (e) {}
    if (pagando) {                                   // en la pantalla del importe: verde paga, rojo cancela
      if (k === 'ok') $('payLink').click();
      else if (k === 'x') logout('');
      return;
    }
    if (!$('vLibre').hidden) { teclaLibre(k); return; }
    if (!$('vNfc').hidden) {                         // esperando la llave: rojo cancela, verde vuelve a escanear
      if (k === 'x') logout('');
      else if (k === 'ok' && !$('nfcBtn').hidden) escanear(false);
      return;
    }
    if (k === 'ok') {
      if ($('loginBtn').disabled) return;
      if ($('loginForm').requestSubmit) $('loginForm').requestSubmit(); else $('loginBtn').click();
      return;
    }
    if (k === 'x') { inp.value = ''; $('loginError').textContent = ''; return; }
    if (k === 'del') { inp.value = inp.value.slice(0, -1); return; }
    if (k === 'abc') { inp.focus(); return; }       // abre el teclado del móvil para las letras
    if (/^[0-9]$/.test(k)) { if (inp.value.length < 40) inp.value += k; $('loginError').textContent = ''; }
  }

  // Pulsar una tecla no le quita el cursor a la clave ni abre el teclado del móvil.
  $('keys').addEventListener('pointerdown', function (e) {
    if (e.target.closest('button')) e.preventDefault();
  });
  $('keys').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var k = b.getAttribute('data-k');
    if (k === 'eye') { pitido(660); return; }        // el ojo tiene su propio botón (mostrar/ocultar la clave)
    tecla(k);
  });

  // Con teclado de ordenador también se puede teclear el importe libre y cancelar la llave.
  document.addEventListener('keydown', function (e) {
    if ($('pos').hidden || e.ctrlKey || e.metaKey || e.altKey) return;
    var libre = !$('vLibre').hidden, llave = !$('vNfc').hidden;
    if (!libre && !llave) return;
    var k = /^[0-9]$/.test(e.key) ? e.key : (e.key === 'Backspace' ? 'del' : (e.key === 'Enter' ? 'ok' : (e.key === 'Escape' ? 'x' : '')));
    if (!k || (llave && k !== 'x' && k !== 'ok')) return;
    e.preventDefault();
    tecla(k);
  });

  // Reloj de la pantalla
  function reloj() {
    var d = new Date();
    $('lcdClock').textContent = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  reloj();
  setInterval(reloj, 20000);

  $('payLink').addEventListener('pointerdown', function (e) {
    if (reduce) return;
    var pay = this;
    var r = pay.getBoundingClientRect();
    var size = Math.max(r.width, r.height) / 2;
    var s = document.createElement('span');
    s.className = 'ripple';
    s.style.width = s.style.height = size + 'px';
    s.style.left = (e.clientX - r.left - size / 2) + 'px';
    s.style.top = (e.clientY - r.top - size / 2) + 'px';
    pay.appendChild(s);
    setTimeout(function () { s.remove(); }, 650);
  });

  /* ---------- Administrador ---------- */

  function entrarAdmin() {
    show('vAdmin');
    items = [];
    renderList();
    cargarLista();
  }

  function cargarLista() {
    return api('list', { admin: adminPass }).then(function (res) {
      if (res.ok) { items = res.items; renderList(); }
      else if (res.auth === false) { logout('La sesión ha caducado'); }
      else { $('formError').textContent = res.error || 'No se pudo cargar la lista'; }
    }).catch(function (e) { $('formError').textContent = textoError(e); });
  }

  function formatImporte(a) { return fmtEUR.format(a); }

  function renderList() {
    var ul = $('codes');
    ul.innerHTML = '';
    var q = $('filter').value.trim().toLowerCase();
    var sorted = items.slice().sort(function (a, b) { return a.code.localeCompare(b.code, 'es'); });
    var shown = sorted.filter(function (x) { return !q || x.code.toLowerCase().indexOf(q) !== -1; });

    $('count').textContent = String(items.length);
    $('filter').hidden = items.length <= 5;
    $('empty').hidden = items.length !== 0;

    shown.forEach(function (it) {
      var li = document.createElement('li');
      li.className = 'code-row' + (editing === it.code ? ' editing' : '');

      var name = document.createElement('span');
      name.className = 'code-name';
      name.textContent = it.code;

      var amt = document.createElement('span');
      amt.className = 'code-amount';
      amt.textContent = formatImporte(it.amount);

      var acts = document.createElement('div');
      acts.className = 'code-actions';

      if (confirming === it.code) {
        var ask = document.createElement('span');
        ask.className = 'ask';
        ask.textContent = '¿Borrar?';
        var yes = btn('Sí, borrar', 'btn btn-danger', function () { borrar(it.code); });
        var no = btn('No', 'btn btn-ghost', function () { confirming = null; renderList(); });
        acts.appendChild(ask); acts.appendChild(yes); acts.appendChild(no);
      } else {
        acts.appendChild(btn('Editar', 'btn btn-ghost', function () { editar(it); }));
        acts.appendChild(btn('Borrar', 'btn btn-ghost', function () { confirming = it.code; renderList(); }));
        acts.appendChild(btn('Compartir', 'btn btn-ghost', function () { compartirCodigo(it); }));
      }

      li.appendChild(name); li.appendChild(amt); li.appendChild(acts);
      ul.appendChild(li);
    });
  }

  function btn(text, cls, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function editar(it) {
    editing = it.code;
    confirming = null;
    $('fCode').value = it.code;
    $('fAmount').value = String(it.amount).replace('.', ',');
    $('formMode').textContent = 'Editando contraseña';
    $('cancelEdit').hidden = false;
    $('formError').textContent = '';
    renderList();
    $('fCode').focus();
    $('codeForm').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'center' });
  }

  function resetForm() {
    editing = null;
    $('fCode').value = '';
    $('fAmount').value = '';
    $('formMode').textContent = 'Nueva contraseña';
    $('cancelEdit').hidden = true;
    $('formError').textContent = '';
  }

  $('cancelEdit').addEventListener('click', function () { resetForm(); renderList(); });
  $('filter').addEventListener('input', renderList);

  $('codeForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var code = $('fCode').value.trim();
    var amount = Number(String($('fAmount').value).trim().replace(',', '.'));
    var err = $('formError');
    err.textContent = '';
    if (!code) { err.textContent = 'Escribe la contraseña'; $('fCode').focus(); return; }
    if (!(amount > 0) || amount > 100000) { err.textContent = 'Escribe un importe válido, por ejemplo 40 o 12,50'; $('fAmount').focus(); return; }

    var b = $('saveBtn');
    b.disabled = true;
    b.firstElementChild.textContent = 'Guardando…';
    api('save', { admin: adminPass, code: code, amount: amount, original: editing }).then(function (res) {
      if (res.ok) {
        items = res.items;
        var fueEdicion = editing !== null;
        resetForm();
        renderList();
        toast(fueEdicion ? 'Cambios guardados' : 'Contraseña creada');
      } else if (res.auth === false) {
        logout('La sesión ha caducado');
      } else {
        err.textContent = res.error || 'No se pudo guardar';
      }
    }).catch(function (e) { err.textContent = textoError(e); })
      .then(function () {
        b.disabled = false;
        b.firstElementChild.textContent = 'Guardar';
      });
  });

  function borrar(code) {
    api('remove', { admin: adminPass, code: code }).then(function (res) {
      confirming = null;
      if (res.ok) {
        items = res.items;
        if (editing === code) resetForm();
        renderList();
        toast('Contraseña borrada');
      } else if (res.auth === false) {
        logout('La sesión ha caducado');
      } else {
        $('formError').textContent = res.error || 'No se pudo borrar';
        renderList();
      }
    }).catch(function (e) { confirming = null; $('formError').textContent = textoError(e); renderList(); });
  }

  $('adminExit').addEventListener('click', function () { logout(''); });

  /* ---------- Instalar la app ---------- */

  var deferred = window.__bip || null;

  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function esIOS() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  function refreshInstall() {
    $('installBtn').hidden = standalone() || !(deferred || esIOS());
  }

  window.addEventListener('bip-ready', function () { deferred = window.__bip; refreshInstall(); });
  window.addEventListener('appinstalled', function () { deferred = null; window.__bip = null; refreshInstall(); });
  try { window.matchMedia('(display-mode: standalone)').addEventListener('change', refreshInstall); } catch (e) {}

  $('installBtn').addEventListener('click', function () {
    if (deferred) {
      deferred.prompt();
      deferred.userChoice.then(function () { deferred = null; window.__bip = null; refreshInstall(); });
    } else if (esIOS()) {
      $('iosSheet').hidden = false;
      $('iosClose').focus();
    }
  });
  $('iosClose').addEventListener('click', function () { $('iosSheet').hidden = true; });
  $('iosSheet').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('iosSheet').hidden = true; });
  refreshInstall();

  /* ---------- Compartir la app ---------- */

  // La imagen del datáfono se deja preparada para mandarla junto al enlace.
  var fotoCompartir = null;
  try {
    fetch('compartir.jpg').then(function (r) { return r.ok ? r.blob() : null; }).then(function (b) {
      if (b) fotoCompartir = new File([b], 'datafono-futurmovil.jpg', { type: 'image/jpeg' });
    }).catch(function () {});
  } catch (e) {}

  // En el móvil abre WhatsApp, correo, etc. (con la imagen si se puede); en el ordenador copia el texto.
  function compartir(titulo, texto, copia, alCopiar) {
    if (navigator.share) {
      var conFoto = { title: titulo, text: texto, files: [fotoCompartir] };
      var sinFoto = function (e) { if (!e || e.name !== 'AbortError') navigator.share({ title: titulo, text: texto }).catch(function () {}); };
      if (fotoCompartir && navigator.canShare && navigator.canShare(conFoto)) navigator.share(conFoto).catch(sinFoto);
      else sinFoto();
      return;
    }
    var aMano = function () {
      var t = document.createElement('textarea');
      t.value = copia; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); alCopiar(); } catch (e) {}
      document.body.removeChild(t);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(copia).then(alCopiar, aMano);
    else aMano();
  }

  function urlApp() { return location.origin + location.pathname; }

  $('shareBtn').addEventListener('click', function () {
    compartir('Datáfono · FuturMovil', 'Paga aquí con tarjeta a FuturMovil\n' + urlApp(), urlApp(), function () {
      $('shareTxt').textContent = '¡Copiado!';
      setTimeout(function () { $('shareTxt').textContent = 'Compartir'; }, 2200);
    });
  });

  // Mensaje para el cliente: el datáfono, su código y cómo pagar.
  function compartirCodigo(it) {
    var imp = fmtEUR.format(it.amount);
    var texto = '💳 *FuturMovil · Pago seguro con tarjeta*\n\n' +
      'Ya puede realizar su pago de *' + imp + '* de forma rápida y segura desde nuestro datáfono online.\n\n' +
      '🔑 Su código de pago: *' + it.code + '*\n\n' +
      '1️⃣ Abra el datáfono: ' + urlApp() + '\n' +
      '2️⃣ Introduzca el código *' + it.code + '* y pulse la tecla verde ✓\n' +
      '3️⃣ Compruebe el importe y pague con su tarjeta en la pasarela segura\n\n' +
      'Gracias por confiar en FuturMovil.';
    compartir('Pago a FuturMovil', texto, texto, function () { toast('Mensaje copiado'); });
  }

  /* ---------- Efectos ---------- */

  if (!reduce && window.matchMedia('(hover: hover)').matches) {
    Array.prototype.forEach.call(document.querySelectorAll('.tilt'), function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        var x = (e.clientX - r.left) / r.width;
        var y = (e.clientY - r.top) / r.height;
        card.style.setProperty('--ry', ((x - 0.5) * 7).toFixed(2) + 'deg');
        card.style.setProperty('--rx', ((0.5 - y) * 7).toFixed(2) + 'deg');
        card.style.setProperty('--mx', (x * 100).toFixed(1) + '%');
        card.style.setProperty('--my', (y * 100).toFixed(1) + '%');
      });
      card.addEventListener('pointerleave', function () {
        card.style.setProperty('--rx', '0deg');
        card.style.setProperty('--ry', '0deg');
      });
    });
  }

  /* ---------- Service worker ---------- */

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    });
  }

  /* ---------- Arranque: recupera la sesión de administrador si sigue abierta ---------- */

  var guardada = '';
  try { guardada = sessionStorage.getItem('fm_admin') || ''; } catch (e) {}
  var kPar = '';
  try { kPar = (new URLSearchParams(location.search).get('k') || '').trim().toUpperCase(); } catch (e) {}
  if (/^[A-Z0-9]{6}$/.test(kPar)) {
    abrirComoLlave(kPar);
  } else if (guardada) {
    adminPass = guardada;
    api('list', { admin: adminPass }).then(function (res) {
      if (res.ok) { show('vAdmin'); items = res.items; renderList(); }
      else { logout(''); }
    }).catch(function () { logout(''); });
  } else {
    foco();
  }
})();
