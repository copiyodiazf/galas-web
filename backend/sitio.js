// Ficha del sitio (sitio.json o el archivo de SITIO_ARCHIVO): datos del lugar u organizador y las fechas
// iniciales de la cartelera. Las fechas viven en la base (tabla eventos): las de la ficha se cargan una
// sola vez, si todavía no existen; las nuevas se cargan desde el panel.
// Si la ficha está mal, el servidor no arranca: mejor eso que vender con un precio equivocado.
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, isAbsolute } from 'path'

const aqui = dirname(fileURLToPath(import.meta.url))
const limpio = (s, max = 200) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max)
// MySQL devuelve los sí/no como 0/1; el panel, como true/false. Sin dato = sí.
const apagado = v => v === false || v === 0 || v === '0' || v === 'false'

export function slug(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
}

// Valida y normaliza un evento (de la ficha o del panel). Devuelve { evento } o { error }.
export function normalizarEvento(d, { idFijo } = {}) {
  const nombre = limpio(d.nombre, 120)
  if (nombre.length < 3) return { error: 'Falta el nombre del evento' }
  const fecha = String(d.fecha || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || isNaN(new Date(fecha + 'T12:00:00Z'))) return { error: 'La fecha va como AAAA-MM-DD' }
  const hora = limpio(d.hora, 10)
  if (hora && !/^\d{1,2}:\d{2}$/.test(hora)) return { error: 'La hora va como 21:30' }
  const artistas = (Array.isArray(d.artistas) ? d.artistas : String(d.artistas || '').split(/\n|,/)).map(a => limpio(a, 80)).filter(Boolean).slice(0, 20)
  // Un evento puede publicarse SIN tipos de entrada todavía (precio a confirmar): se ve en la cartelera
  // como "Entradas muy pronto" y no se puede comprar hasta que se le cargue al menos un tipo.
  const tiposEntrada = Array.isArray(d.tipos) ? d.tipos : []
  const tipos = [], vistos = new Set()
  for (const t of tiposEntrada.slice(0, 10)) {
    const tn = limpio(t.nombre, 60)
    const id = slug(t.id || tn).slice(0, 40)
    if (!id || !tn) return { error: 'Cada tipo de entrada necesita un nombre' }
    if (vistos.has(id)) return { error: `El tipo "${tn}" está repetido` }
    vistos.add(id)
    const precio = Math.round(Number(t.precio)), cupo = Math.round(Number(t.cupo))
    if (!(precio > 0)) return { error: `"${tn}": falta el precio` }
    if (!(cupo > 0)) return { error: `"${tn}": falta la capacidad (cupo)` }
    // Etapas de precio ("hasta el 30/11, $20.000"): rigen hasta el final de su día "hasta", en orden.
    // Después de la última vale `precio` (por ejemplo, el precio en puerta).
    const etapas = []
    for (const e of (Array.isArray(t.etapas) ? t.etapas : []).slice(0, 6)) {
      const hasta = String(e.hasta || '').slice(0, 10), p = Math.round(Number(e.precio))
      if (!/^\d{4}-\d{2}-\d{2}$/.test(hasta) || isNaN(new Date(hasta + 'T12:00:00Z'))) return { error: `"${tn}": cada etapa necesita su fecha "hasta" (AAAA-MM-DD)` }
      if (!(p > 0)) return { error: `"${tn}": a la etapa hasta ${hasta} le falta el precio` }
      if (etapas.length && hasta <= etapas[etapas.length - 1].hasta) return { error: `"${tn}": las etapas van en orden de fecha` }
      etapas.push({ hasta, precio: p, nombre: limpio(e.nombre, 40) || null })
    }
    tipos.push({ id, nombre: tn, corto: limpio(t.corto || tn, 24), detalle: limpio(t.detalle, 80), precio, cupo, ...(etapas.length ? { etapas } : {}) })
  }
  // Último día de venta ONLINE (incluido). Sin dato, se vende online hasta la noche del evento.
  const ventaHasta = String(d.ventaHasta || '').slice(0, 10)
  if (ventaHasta && (!/^\d{4}-\d{2}-\d{2}$/.test(ventaHasta) || ventaHasta > fecha)) return { error: 'El último día de venta online va como AAAA-MM-DD y no puede ser después del evento' }
  const externoUrl = limpio(d.externoUrl, 300)
  if (externoUrl && !/^https:\/\/[^\s<>"']+$/i.test(externoUrl)) return { error: 'El enlace de la otra ticketera tiene que empezar con https://' }
  const externoTexto = limpio(d.externoTexto, 80), externoPrecio = limpio(d.externoPrecio, 80)
  if ((externoUrl || externoTexto || externoPrecio) && tipos.length) return { error: 'Una fecha que vende otra ticketera no lleva entradas propias: sacá los tipos de entrada o los datos de la otra ticketera' }
  const id = idFijo || slug(d.id || `${fecha}-${nombre}`)
  if (!/^[a-z0-9-]{3,60}$/.test(id)) return { error: 'No se pudo armar el identificador del evento' }
  return {
    evento: {
      id, nombre, subtitulo: limpio(d.subtitulo, 160) || null, fecha, hora: hora || null, puertas: limpio(d.puertas, 40) || null,
      artistas, descripcion: String(d.descripcion ?? '').trim().slice(0, 3000) || null, imagen: limpio(d.imagen, 200) || null, tipos,
      nota: limpio(d.nota, 120) || null, externoUrl: externoUrl || null, externoTexto: externoTexto || null, externoPrecio: externoPrecio || null,
      publicado: !apagado(d.publicado), ventaAbierta: !apagado(d.ventaAbierta), ventaHasta: ventaHasta || null,
    },
  }
}

// Colores del mail de las entradas (opcional, por tema). Lo que falta o no es un #rrggbb queda con los del molde.
const HEX = /^#[0-9a-f]{6}$/i
const colorDe = (x, porDefecto) => HEX.test(String(x || '')) ? String(x) : porDefecto
function coloresMail(m = {}) {
  return {
    encabezado: colorDe(m.encabezado, '#141022'),    // fondo de la cabecera (con el logo)
    sobrecabeza: colorDe(m.sobrecabeza, '#e7c27d'),  // el nombre del sitio, arriba del evento
    acento: colorDe(m.acento, '#e7c27d'),            // botones
    acentoTexto: colorDe(m.acentoTexto, '#1d1830'),  // texto de los botones
    titulos: colorDe(m.titulos, '#8a6a2a'),          // rótulos sobre blanco ("Cómo entrar", el de cada QR)
    franja: (Array.isArray(m.franja) ? m.franja : []).filter(c => HEX.test(String(c))).slice(0, 6),   // franja de colores bajo la cabecera
  }
}

// Archivos de la galería y del video de portada: dentro de assets/ del tema, o un https:// completo.
const RUTA = /^(assets\/[\w\-./]+|https:\/\/[^\s"'<>]+)$/
const rutaArchivo = x => { const r = String(x || '').trim(); return RUTA.test(r) && !r.includes('..') ? r.slice(0, 300) : '' }
function galeriaDe(g) {
  if (!g) return null
  const items = (Array.isArray(g) ? g : g.items || []).slice(0, 30)
    .map(i => ({ foto: rutaArchivo(i.foto), mini: rutaArchivo(i.mini) || null, video: rutaArchivo(i.video) || null, alt: limpio(i.alt, 140) })).filter(i => i.foto)
  // pasarela: las fotos corren en una tira y los videos van aparte, con su título (tituloVideos)
  return items.length ? { titulo: limpio(g.titulo, 80) || 'Galería', texto: limpio(g.texto, 300), items,
    pasarela: g.pasarela === true, tituloVideos: limpio(g.tituloVideos, 80) } : null
}

export function leerSitio(archivo = process.env.SITIO_ARCHIVO || 'sitio.json') {
  const ruta = isAbsolute(archivo) ? archivo : join(aqui, archivo)
  const s = JSON.parse(readFileSync(ruta, 'utf8'))
  if (!limpio(s.nombre)) throw new Error('sitio.json: falta el nombre')
  if (!limpio(s.lugar)) throw new Error('sitio.json: falta el lugar')
  const eventos = []
  for (const e of s.eventos || []) {
    const r = normalizarEvento(e)
    if (r.error) throw new Error(`sitio.json, evento "${e.nombre || '?'}": ${r.error}`)
    eventos.push(r.evento)
  }
  return {
    sitio: {
      nombre: limpio(s.nombre, 80), lema: limpio(s.lema, 120), organiza: limpio(s.organiza, 120), lugar: limpio(s.lugar, 120),
      direccion: limpio(s.direccion, 160), ciudad: limpio(s.ciudad, 80), instagram: limpio(s.instagram, 80).replace(/^@/, ''),
      ayudaWhatsapp: String(s.ayudaWhatsapp || '').replace(/\D/g, ''), menores: limpio(s.menores, 200),
      // "gala" = un solo evento: la portada lo muestra en grande. "cartelera" = lista de fechas.
      modo: s.modo === 'gala' ? 'gala' : 'cartelera',
      // true = los precios de la ficha son lo que PAGA el público, con el cargo adentro (la academia
      // recibe precio / 1,10). false (el de siempre) = son lo que recibe la academia y el cargo va encima.
      precioIncluyeCargo: s.precioIncluyeCargo === true,
      mail: coloresMail(s.mail || {}),
      // Secciones opcionales de la página: quiénes somos y el llamado a feriantes/emprendedores.
      sobre: s.sobre?.titulo ? { titulo: limpio(s.sobre.titulo, 80), parrafos: (s.sobre.parrafos || []).map(p => limpio(p, 600)).filter(Boolean).slice(0, 6) } : null,
      facebook: /^https:\/\//.test(s.facebook || '') ? limpio(s.facebook, 200) : '',
      // "Lo que se vive": 3 o 4 tarjetas cortas con un ícono (emoji), título y texto.
      destacados: (s.destacados || []).slice(0, 6).map(d => ({ icono: limpio(d.icono, 8), titulo: limpio(d.titulo, 60), texto: limpio(d.texto, 220) })).filter(d => d.titulo),
      // Galería: { titulo, texto, items: [{ foto, video?, alt }] }. "foto" es la imagen (o el cuadro del video).
      galeria: galeriaDe(s.galeria),
      // Video de fondo de la portada, mudo y en loop (mp4 liviano, sin sonido). La foto portada.webp queda debajo.
      portadaVideo: rutaArchivo(s.portadaVideo),
      // Opcional: versión vertical del video para celulares (si no está, el celular usa portadaVideo recortado).
      portadaVideoMovil: rutaArchivo(s.portadaVideoMovil),
      feriantes: s.feriantes?.whatsapp ? { titulo: limpio(s.feriantes.titulo || 'Feriantes y emprendedores', 80), texto: limpio(s.feriantes.texto, 600),
        whatsapp: String(s.feriantes.whatsapp).replace(/\D/g, ''), mensaje: limpio(s.feriantes.mensaje, 200) } : null,
    },
    eventos,
  }
}
