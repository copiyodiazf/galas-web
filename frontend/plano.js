// Plano de butacas: lo usan la compra (elegir dónde sentarse) y el panel (ver la sala, guardar butacas,
// cortesías, boletería). El plano viene de la ficha (sitio.json → sala); el estado de cada butaca lo da
// quien lo usa. Con el escenario arriba, el asiento 1 queda del lado que diga "asiento1".
//   const p = Plano.crear(contenedor, { sala, estado: id => 'libre' | 'ocupada' | 'elegida' | ..., alTocar: id => {} })
//   p.refrescar()   → vuelve a pedir el estado de cada butaca (sin redibujar ni mover el plano)
window.Plano = (() => {
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TAMANOS = [14, 18, 22, 26, 30, 36];

  function filasDe(sala) {
    return sala.filas.map(f => {
      const items = [];
      for (const b of f.bloques) {
        if (b.hueco) items.push({ hueco: true, texto: b.texto, ancho: b.ancho });
        else for (let n = b.desde; n <= b.hasta; n++) items.push({ id: `${f.fila}-${n}`, n });
      }
      if (sala.asiento1 === 'derecha') items.reverse();
      return { ...f, items };
    });
  }

  function crear(el, { sala, estado, alTocar, extra = () => '' }) {
    let guardado = 0;
    try { guardado = Number(localStorage.getItem('plano_tam')) || 0; } catch {}
    let tam = guardado || 26;
    const filas = filasDe(sala);
    // Butacas + huecos de la fila más ancha: para ver si la sala entra entera a lo ancho.
    const columnas = Math.max(...sala.filas.map(f => f.bloques.reduce((a, b) => a + (b.hueco ? b.ancho : b.hasta - b.desde + 1), 0)));
    el.innerHTML = `<div class="plano-caja">
      <div class="plano-zoom"><span class="plano-deslizar"></span>
        <button type="button" data-z="-1" aria-label="Achicar el plano">−</button><button type="button" data-z="1" aria-label="Agrandar el plano">+</button></div>
      <div class="plano" role="group" aria-label="Plano de la sala"><div class="plano-sala">
        <div class="plano-escenario">${esc(sala.escenario || 'Escenario')}</div>
        ${filas.map(f => `${f.zona && !filas[filas.indexOf(f) - 1]?.zona ? `<div class="pf-zona">${esc(f.zona)}</div>` : ''}
          <div class="pf${f.zona ? ' zona' : ''}"><span class="pf-n izq">${esc(f.fila)}</span><div class="pf-asientos">
          ${f.items.map(i => i.hueco
            ? `<span class="hueco${i.texto ? ' cabina' : ''}" style="width:calc(var(--b) * ${i.ancho} + var(--g) * ${i.ancho - 1})">${esc(i.texto || '')}</span>`
            : `<button type="button" class="bu" data-id="${esc(i.id)}" aria-label="Fila ${esc(f.fila)}, asiento ${i.n}">${i.n}</button>`).join('')}
          </div><span class="pf-n der">${esc(f.fila)}</span></div>`).join('')}
      </div></div>
      ${sala.nota ? `<p class="plano-nota">${esc(sala.nota)}</p>` : ''}
    </div>`;
    const caja = el.querySelector('.plano');
    const botones = [...el.querySelectorAll('.bu')];
    const ajustar = () => {
      caja.style.setProperty('--b', tam + 'px'); caja.style.setProperty('--g', Math.max(2, Math.round(tam / 7)) + 'px');
      el.querySelector('.plano-deslizar').textContent = caja.scrollWidth > caja.clientWidth + 4 ? 'Deslizá el plano para ver toda la fila' : '';
    };
    // Sin un tamaño elegido antes: si la sala entra entera con butacas de 20 px o más, ese; si no (celular), 26 px y se desliza.
    if (!guardado) {
      const entra = Math.floor((caja.clientWidth - 24) / (columnas + 2 + (columnas + 1) / 7));
      tam = entra >= 20 ? Math.min(entra, 30) : 26;
    }
    ajustar();
    el.querySelectorAll('[data-z]').forEach(b => b.onclick = () => {
      // El tamaño siguiente (más grande o más chico) de la lista, aunque el de ahora haya sido el que entraba justo.
      const sig = Number(b.dataset.z) > 0 ? TAMANOS.find(x => x > tam) : [...TAMANOS].reverse().find(x => x < tam);
      if (!sig) return;
      const centro = (caja.scrollLeft + caja.clientWidth / 2) / caja.scrollWidth;
      tam = sig;
      try { localStorage.setItem('plano_tam', tam); } catch {}
      ajustar();
      caja.scrollLeft = centro * caja.scrollWidth - caja.clientWidth / 2;
    });
    caja.addEventListener('click', ev => {
      const b = ev.target.closest('.bu');
      if (b) alTocar?.(b.dataset.id, b);
    });
    function refrescar() {
      for (const b of botones) {
        const e = estado(b.dataset.id);
        const clases = Array.isArray(e) ? e : [e];
        b.className = 'bu ' + clases.filter(Boolean).join(' ');
        b.disabled = clases.includes('ocupada');
        const titulo = extra(b.dataset.id);
        if (titulo) b.title = titulo; else b.removeAttribute('title');
      }
    }
    refrescar();
    // Arranca centrado: el pasillo del medio a la vista.
    requestAnimationFrame(() => { caja.scrollLeft = (caja.scrollWidth - caja.clientWidth) / 2; });
    return { refrescar, caja };
  }

  const leyenda = items => `<div class="plano-leyenda">${items.map(([clase, txt]) => `<span><i class="bu ${clase}"></i>${esc(txt)}</span>`).join('')}</div>`;

  // "Fila 5 · Asiento 12" y "Fila 5: 11, 12 · Fila 6: 3", igual que el servidor.
  function etiqueta(sala, id) {
    const [fila, n] = String(id).split('-');
    const f = sala.filas.find(x => x.fila === fila);
    return `Fila ${fila}${f?.zona ? ` (${f.zona})` : ''} · Asiento ${n}`;
  }
  function resumen(ids) {
    const por = new Map();
    for (const id of ids) { const [f, n] = String(id).split('-'); if (!por.has(f)) por.set(f, []); por.get(f).push(Number(n)); }
    return [...por].map(([f, ns]) => `Fila ${f}: ${ns.sort((a, b) => a - b).join(', ')}`).join(' · ');
  }
  // De qué tipo de entrada es una butaca en un evento (tipos = ids de los tipos del evento, en orden).
  function tipoDe(sala, tiposIds, id) {
    const f = sala.filas.find(x => x.fila === String(id).split('-')[0]);
    return (f?.tipo && tiposIds.includes(f.tipo)) ? f.tipo : tiposIds[0];
  }
  return { crear, leyenda, etiqueta, resumen, tipoDe };
})();
