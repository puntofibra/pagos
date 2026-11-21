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

  var VIEWS = ['vLogin', 'vPay', 'vAdmin'];
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
        adminPass = pass;
        try { sessionStorage.setItem('fm_admin', pass); } catch (e) {}
        entrarAdmin();
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

  $('shareBtn').addEventListener('click', function () {
    var url = location.origin + location.pathname;
    var dicho = function (t) {
      $('shareTxt').textContent = t;
      setTimeout(function () { $('shareTxt').textContent = 'Compartir'; }, 2200);
    };
    if (navigator.share) {                                  // móvil: abre WhatsApp, correo, etc.
      var datos = { title: 'Datáfono · FuturMovil', text: 'Paga aquí con tarjeta a FuturMovil', url: url };
      var conFoto = { title: datos.title, text: datos.text + '\n' + url, files: [fotoCompartir] };
      var sinFoto = function (e) { if (!e || e.name !== 'AbortError') navigator.share(datos).catch(function () {}); };
      if (fotoCompartir && navigator.canShare && navigator.canShare(conFoto)) navigator.share(conFoto).catch(sinFoto);
      else sinFoto();
      return;
    }
    var copiar = function () {                              // ordenador: copia el enlace
      var t = document.createElement('textarea');
      t.value = url; t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t); t.select();
      try { document.execCommand('copy'); dicho('¡Copiado!'); } catch (e) { dicho(url); }
      document.body.removeChild(t);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { dicho('¡Copiado!'); }, copiar);
    } else copiar();
  });

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
  if (guardada) {
    adminPass = guardada;
    api('list', { admin: adminPass }).then(function (res) {
      if (res.ok) { show('vAdmin'); items = res.items; renderList(); }
      else { logout(''); }
    }).catch(function () { logout(''); });
  } else {
    foco();
  }
})();
