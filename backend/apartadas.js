// Butacas APARTADAS al tocarlas en el plano (Rítmica, 19/11/2026). Antes tocar una butaca solo la marcaba en la
// pantalla de cada uno, y se apartaba recién al tocar «Ir a pagar»: en la apertura de la venta dos familias elegían
// la misma, completaban sus datos y a la segunda le decían "alguien la eligió recién". José pidió que la butaca sea
// del primero que la toca, con un tiempo para completar la compra: si no va a pagar en ese tiempo, se libera.
//
// Viven en la memoria del servidor, no en la base. Cada toque tiene que ser instantáneo aunque cientos de familias
// toquen a la vez, y en la base haría cola detrás del bloqueo de la función (el de las compras). Como el código de
// Node corre de a un pedido por vez, mirar si está libre y apartarla pasa sin que nadie se meta en el medio. Hay un
// solo servidor por gala (como los límites por IP); si se reinicia, se pierden los apartados, pero nunca se vende
// dos veces: eso lo sigue cuidando la compra, con la base bloqueada (apartarButacas en server.js).
//
// Lo de cada comprador es una TANDA (evento + su navegador): las butacas que tiene apartadas y un solo vencimiento,
// que corre desde la primera que tocó. Sumar butacas no lo estira (si no, tocando cada tanto se guardaría la butaca
// para siempre); soltarlas todas sí lo reinicia para la próxima.

export function crearApartadas({ minutos = 15, maxPorCliente = 10, maxPorIp = 120, reloj = () => Date.now() } = {}) {
  const tandas = new Map()     // `${evento}\n${cliente}` → { evento, cliente, ip, hasta, butacas: Set }
  const duenos = new Map()     // evento → Map(butaca → clave de la tanda)
  const clave = (evento, cliente) => `${evento}\n${cliente}`
  const vigente = t => t && t.hasta > reloj()

  function borrarTanda(k) {
    const t = tandas.get(k)
    if (!t) return
    const d = duenos.get(t.evento)
    if (d) for (const b of t.butacas) if (d.get(b) === k) d.delete(b)
    tandas.delete(k)
  }
  // La tanda vigente de ese comprador (la vencida se borra al mirarla).
  function tanda(evento, cliente) {
    const k = clave(evento, cliente), t = tandas.get(k)
    if (t && !vigente(t)) { borrarTanda(k); return null }
    return t || null
  }
  // De quién es una butaca ahora (la clave de su tanda), o null.
  function duenoDe(evento, butaca) {
    const k = duenos.get(evento)?.get(butaca)
    if (!k) return null
    const t = tandas.get(k)
    if (!vigente(t)) { borrarTanda(k); return null }
    return k
  }
  function apartadasDesde(ip) {
    let n = 0
    for (const t of tandas.values()) if (t.ip === ip && vigente(t)) n += t.butacas.size
    return n
  }

  return {
    minutos,
    // Aparta la butaca para ese comprador. Quien llama ya revisó que no esté vendida, pagándose ni guardada.
    // Devuelve { hasta } o { error: 'ajena' | 'tope' | 'tope_ip' }.
    apartar(evento, cliente, butaca, ip = '') {
      const k = clave(evento, cliente)
      const dueno = duenoDe(evento, butaca)
      if (dueno && dueno !== k) return { error: 'ajena' }
      let t = tanda(evento, cliente)
      if (t?.butacas.has(butaca)) return { hasta: t.hasta }
      if (t && t.butacas.size >= maxPorCliente) return { error: 'tope' }
      if (maxPorIp && apartadasDesde(ip) >= maxPorIp) return { error: 'tope_ip' }
      if (!t) { t = { evento, cliente, ip, hasta: reloj() + minutos * 60000, butacas: new Set() }; tandas.set(k, t) }
      t.butacas.add(butaca)
      if (!duenos.has(evento)) duenos.set(evento, new Map())
      duenos.get(evento).set(butaca, k)
      return { hasta: t.hasta }
    },
    soltar(evento, cliente, butaca) {
      const k = clave(evento, cliente), t = tandas.get(k)
      if (!t?.butacas.delete(butaca)) return
      if (duenos.get(evento)?.get(butaca) === k) duenos.get(evento).delete(butaca)
      if (!t.butacas.size) tandas.delete(k)
    },
    soltarTodas(evento, cliente) { borrarTanda(clave(evento, cliente)) },
    // Le saca esas butacas a quien las tenga apartadas (un pago que llegó tarde se queda con las suyas).
    quitar(evento, butacas) {
      for (const b of butacas) {
        const k = duenos.get(evento)?.get(b)
        if (!k) continue
        const t = tandas.get(k)
        if (t) { t.butacas.delete(b); if (!t.butacas.size) tandas.delete(k) }
        duenos.get(evento).delete(b)
      }
    },
    // Lo apartado de ese comprador: { butacas, hasta } o null.
    de(evento, cliente) {
      const t = cliente ? tanda(evento, cliente) : null
      return t ? { butacas: [...t.butacas], hasta: t.hasta } : null
    },
    // Las butacas que tienen apartadas los DEMÁS (sin cliente: todas).
    deOtros(evento, cliente) {
      const k = cliente ? clave(evento, cliente) : null, d = duenos.get(evento)
      if (!d) return []
      return [...d.keys()].filter(b => { const x = duenoDe(evento, b); return x && x !== k })
    },
    todas(evento) { return this.deOtros(evento, null) },
    // Borra lo vencido (lo demás se borra igual al mirarlo: esto es para que la memoria no crezca).
    purgar() {
      let n = 0
      for (const [k, t] of tandas) if (!vigente(t)) { borrarTanda(k); n++ }
      return n
    },
  }
}

// El navegador se presenta con un número propio que inventa al abrir la compra (no se adivina el de otro).
export const clienteValido = x => (typeof x === 'string' && /^[A-Za-z0-9-]{12,64}$/.test(x) ? x : null)
