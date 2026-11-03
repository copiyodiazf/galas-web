// Completa la cabecera y el título de las pantallas con los datos del sitio (de /api/config),
// así ninguna pantalla tiene el nombre del lugar o de la gala escrito a mano.
fetch('/api/config').then(r => r.json()).then(c => {
  const s = c.sitio || {};
  window.SITIO = s;
  document.querySelectorAll('[data-sitio]').forEach(el => {
    const campo = el.dataset.sitio;
    el.textContent = campo === 'bajada' ? (s.lema || s.organiza || s.ciudad || '') : (s[campo] || el.textContent);
  });
  if (s.nombre && !document.title.includes(s.nombre)) document.title += ' · ' + s.nombre;
}).catch(() => {});
