// Lógica común de pago-exitoso y pago-pendiente: pregunta por la orden (lo que además
// verifica el pago contra Chytapay y emite las entradas si el aviso no había llegado)
// y muestra los QR apenas están.
(() => {
  const $ = s => document.querySelector(s);
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const orden = new URLSearchParams(location.search).get('orden');
  let intentos = 0;

  function exito(d) {
    const qrs = d.qrs.map(q => `<div class="qr"><b>${esc(d.tipoNombre)}</b><small>${q.indice} de ${d.qrs.length}</small>
      <img src="${esc(q.url)}" width="250" height="250" alt="Código QR ${q.indice}"></div>`).join('');
    $('#contenido').innerHTML = `
      <h1>¡Listo, <em>${esc(d.nombre)}</em>!</h1>
      <p class="bajada">Tu compra para <b style="color:var(--crema)">${esc(d.eventoNombre)}</b> (${esc(d.cuando)}) se confirmó. Las entradas también te llegaron a <b style="color:var(--crema)">${esc(d.email)}</b>.</p>
      <div class="aviso" style="margin-top:16px;"><b>Hacé una captura de pantalla de cada QR.</b> En el lugar puede no haber señal. Cada QR sirve una sola vez, solo esa fecha.</div>
      <div class="qrs">${qrs}</div>
      <p style="margin-top:18px;"><a class="btn" href="/mis-entradas">Ver mis entradas</a></p>
      <p style="margin-top:10px;"><a class="btn linea" href="/">Volver al evento</a></p>`;
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
