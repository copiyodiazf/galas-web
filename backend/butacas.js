// Butacas numeradas: el plano de la sala (sitio.json → "sala", ya normalizado por sitio.js) y las cuentas
// que no tocan la base: qué butacas existen, de qué tipo de entrada es cada una, cómo se nombran y cuáles
// son las mejores libres. Lo que está vendido o reservado lo cuenta server.js (butacasTomadas).

// El plano con un índice por butaca: "5-12" → { fila, numero, idx (0 = la más cerca del escenario), zona, tipo }
export function crearSala(sala) {
  if (!sala) return null
  const porId = new Map()
  sala.filas.forEach((f, idx) => {
    for (const b of f.bloques) {
      if (b.hueco) continue
      for (let n = b.desde; n <= b.hasta; n++) porId.set(`${f.fila}-${n}`, { id: `${f.fila}-${n}`, fila: f.fila, numero: n, idx, zona: f.zona, tipo: f.tipo, desde: b.desde, hasta: b.hasta, asientos: f.asientos })
    }
  })
  return { ...sala, porId }
}

// Las butacas de una compra, en el orden en que se eligieron.
export const butacasDe = o => String(o?.butacas || '').split(',').map(s => s.trim()).filter(Boolean)

// Lo que manda la página (lista o texto con comas), limpio y sin repetidas. null si viene algo raro.
export function leerButacas(x, sala) {
  const lista = (Array.isArray(x) ? x : String(x || '').split(',')).map(s => String(s).trim()).filter(Boolean)
  if (lista.length > 60) return null
  if (new Set(lista).size !== lista.length) return null
  if (lista.some(id => !sala.porId.has(id))) return null
  return lista
}

// De qué tipo de entrada es una butaca en ESTE evento: el de su fila si el evento lo tiene, si no el primero.
export function tipoDeButaca(sala, ev, id) {
  const b = sala.porId.get(id)
  if (!b || !ev?.tipos?.length) return null
  return ev.tipos.find(t => t.id === b.tipo)?.id || ev.tipos[0].id
}

// "Fila 5 · Asiento 12" (con la zona si la fila tiene una: "Fila 14 (Zona verde) · Asiento 3")
export function etiquetaButaca(sala, id) {
  const b = sala?.porId.get(id)
  if (!b) return id ? String(id) : ''
  return `Fila ${b.fila}${b.zona ? ` (${b.zona})` : ''} · Asiento ${b.numero}`
}

// "Fila 5: 11, 12 · Fila 6: 3" — para el panel, la planilla y el mail.
export function resumenButacas(sala, ids) {
  const porFila = new Map()
  for (const id of ids) {
    const b = sala?.porId.get(id)
    const fila = b ? b.fila : String(id).split('-')[0]
    const num = b ? b.numero : String(id).split('-')[1]
    if (!porFila.has(fila)) porFila.set(fila, [])
    porFila.get(fila).push(Number(num))
  }
  return [...porFila].map(([f, ns]) => `Fila ${f}: ${ns.sort((a, b) => a - b).join(', ')}`).join(' · ')
}

// Cuántas butacas de cada tipo tiene la sala para este evento, sin las que el organizador se guardó.
export function cupoDeSala(sala, ev) {
  const bloq = new Set(ev?.bloqueadas || [])
  const cupo = {}
  for (const id of sala.porId.keys()) {
    if (bloq.has(id)) continue
    const t = tipoDeButaca(sala, ev, id)
    if (t) cupo[t] = (cupo[t] || 0) + 1
  }
  return cupo
}

// Las n mejores butacas libres de un tipo: juntas en la misma fila y sin hueco en el medio, lo más cerca
// del escenario y del centro de la fila. Si no hay n juntas, las n sueltas mejor ubicadas. null si no alcanzan.
// Sirve para reubicar a quien pagó tarde cuando sus butacas ya se vendieron.
export function elegirMejores(sala, ev, tipo, n, libre) {
  const candidatas = [...sala.porId.values()].filter(b => tipoDeButaca(sala, ev, b.id) === tipo && libre(b.id))
  if (candidatas.length < n) return null
  const centro = b => Math.abs(b.numero - (b.asientos + 1) / 2)
  let mejor = null, puntaje = Infinity
  for (const b of candidatas) {
    // Una tanda de n que arranca en b, dentro del mismo bloque y toda libre.
    if (b.numero + n - 1 > b.hasta) continue
    const tanda = []
    for (let k = 0; k < n; k++) {
      const id = `${b.fila}-${b.numero + k}`
      if (!libre(id) || tipoDeButaca(sala, ev, id) !== tipo) break
      tanda.push(id)
    }
    if (tanda.length < n) continue
    const p = b.idx * 1000 + Math.abs(b.numero + (n - 1) / 2 - (b.asientos + 1) / 2)
    if (p < puntaje) { puntaje = p; mejor = tanda }
  }
  if (mejor) return mejor
  return candidatas.sort((a, b) => a.idx - b.idx || centro(a) - centro(b)).slice(0, n).map(b => b.id)
}
