// Lógica común de pago-exitoso y pago-pendiente: pregunta por la orden (lo que además
// verifica el pago contra Chytapay y emite las entradas si el aviso no había llegado)
// y muestra los QR apenas están.
(() => {
  const $ = s => document.querySelector(s);
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const orden = new URLSearchParams(location.search).get('orden');
  let intentos = 0;

  function exito(d) {
    try { sessionStorage.removeItem('gala_compra'); } catch {}
    const qrs = d.qrs.map(q => `<div class="qr"><b>${esc(d.tipoNombre)}</b><small>${q.indice} de ${d.qrs.length}</small>${q.butaca ? `<span class="butaca">${esc(q.butaca)}</span>` : ''}
      <img src="${esc(q.url)}" width="250" height="250" alt="Código QR ${q.indice}"></div>`).join('');
    $('#contenido').innerHTML = `
      <h1>¡Listo, <em>${esc(d.nombre)}</em>!</h1>
      <p class="bajada">Tu compra para <b style="color:var(--crema)">${esc(d.eventoNombre)}</b> (${esc(d.cuando)}) se confirmó. Las entradas también te llegaron a <b style="color:var(--crema)">${esc(d.email)}</b>.</p>
      <div class="aviso" style="margin-top:16px;"><b>Hacé una captura de pantalla de cada QR.</b> En el lugar puede no haber señal. Cada QR sirve una sola vez, solo esa fecha.</div>
      <div class="qrs">${qrs}</div>
      <p style="margin-top:18px;"><a class="btn" href="/mis-entradas">Ver mis entradas</a></p>
      <p style="margin-top:10px;"><a class="btn linea" href="/">Volver al evento</a></p>`;
    festejar(d.evento);
  }

  // Confeti al confirmarse la compra, solo si la gala lo pide (sitio.json → festejo) y una vez por compra.
  // canvas-confetti (ISC, frontend/vendor) se carga recién acá; con "reducir movimiento" no sale.
  async function festejar(evento) {
    try {
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      const clave = 'festejo_' + orden;
      if (sessionStorage.getItem(clave)) return;
      const sitio = window.SITIO || (await fetch('/api/config').then(r => r.json())).sitio || {};
      const colores = sitio.festejo?.[evento] || sitio.festejo?.['*'];
      if (!colores) return;
      sessionStorage.setItem(clave, '1');
      await new Promise((ok, mal) => { const s = document.createElement('script'); s.src = '/vendor/canvas-confetti-1.9.4.js'; s.onload = ok; s.onerror = mal; document.head.appendChild(s); });
      const tiro = (x, angulo) => window.confetti({ particleCount: 70, spread: 62, startVelocity: 42, angle: angulo, origin: { x, y: .35 }, colors: colores, disableForReducedMotion: true, ticks: 220 });
      tiro(.2, 60); setTimeout(() => tiro(.8, 120), 180);
    } catch { /* sin confeti: las entradas ya están en pantalla */ }
  }

  async function revisar() {
    if (!orden) { $('#msg').textContent = 'No pudimos identificar la compra. Revisá tu correo o entrá a Mis entradas.'; return; }
    intentos++;
    try {
      const r = await fetch('/api/orders/' + encodeURIComponent(orden) + '/confirmar', { method: 'POST' });
      const d = await r.json();
      if (d.estado === 'pagada' && (d.qrs || []).length) return exito(d);
    } catch (e) { /* se sigue intentando */ }
    // Rápido al principio (una transferencia se acredita en segundos) y después más espaciado.
    const espera = intentos < 30 ? 2500 : intentos < 45 ? 10000 : 60000;
    $('#reloj').textContent = intentos < 30 ? 'Esperando la confirmación de la transferencia…' : `Revisado ${intentos} veces · próxima revisión en ${espera / 1000} s`;
    setTimeout(revisar, espera);
  }
  revisar();
})();
