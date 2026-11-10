// ───────────────────────────────────────────────────────────────
//  Backend - Venta de entradas con cartelera (galas, peñas, funciones)
//
//  Sale del sistema del Festival del Agricultor (QR + mail + panel + puerta), con:
//   · la ficha del sitio en sitio.json y los eventos de la cartelera en la base (se cargan desde el
//     panel): cada evento con sus tipos de entrada, precio y cupo propios;
//   · cupo por evento y tipo, con bloqueo en la base para que dos compras simultáneas no se pasen;
//   · cada QR vale solo para su evento y entra una vez;
//   · cobro con Chytapay (transferencia, un CVU por compra, conciliación por CUIL). La comisión
//     de José la transfiere Chytapay sola en cada pago (Distribución): acá no se calcula;
//   · venta en puntos físicos (efectivo o transferencia), al mismo precio final que online.
// ───────────────────────────────────────────────────────────────

import express from 'express'
import cors from 'cors'
import dotenv from 'dotenv'
import { randomUUID, randomBytes, createHmac, timingSafeEqual, scryptSync } from 'crypto'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { existsSync, readFileSync } from 'fs'
import QRCode from 'qrcode'
import nodemailer from 'nodemailer'
import { Op, QueryTypes, fn, col } from 'sequelize'
import { sequelize, Orden, Entrada, Usuario, Visita, SinImputar, Evento, Imagen } from './models/index.js'
import { leerSitio, normalizarEvento } from './sitio.js'
import { chytapayConfigurado, chytapayEsProduccion, clavePublicable, crearCobroCheckout, cobroPagado, firmaValida,
  urlAutorizar, canjearCode, guardarVinculo, vinculoActual, asignarSede, sedeConfigurada } from './chytapay.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: join(__dirname, '.env') })
const FRONT = join(__dirname, '..', 'frontend')
// Cada cliente es un TEMA (carpeta temas/<nombre>): su ficha sitio.json, su tema.css (colores) y sus
// assets (logo, fotos). Todos comparten este mismo código; en Render cada servicio lleva su TEMA.
const TEMA = String(process.env.TEMA || 'molde').replace(/[^a-z0-9-]/gi, '')
const TEMA_DIR = join(__dirname, '..', 'temas', TEMA)
const fichaDelTema = join(TEMA_DIR, 'sitio.json')
const { sitio: SITIO, eventos: SEMILLAS } = leerSitio(process.env.SITIO_ARCHIVO || (existsSync(fichaDelTema) ? fichaDelTema : 'sitio.json'))

const app = express()
app.set('trust proxy', true)
app.disable('x-powered-by')
// Encabezados de seguridad: sin incrustar el sitio en otras páginas (el panel no se puede "disfrazar"),
// sin adivinar tipos de archivo, https obligatorio y la cámara solo para el escáner de la puerta.
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'SAMEORIGIN')
  res.set('Content-Security-Policy', "frame-ancestors 'self'")
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  res.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()')
  if (req.headers['x-forwarded-proto'] === 'https') res.set('Strict-Transport-Security', 'max-age=15552000')
  next()
})
// La API la usan solo las páginas del propio sitio. Los avisos de Chytapay no mandan "Origin"
// (son de servidor a servidor): no les afecta.
const ORIGENES = [process.env.PUBLIC_URL, process.env.FRONTEND_URL, ...String(process.env.ORIGENES_EXTRA || '').split(',')]
  .map(u => String(u || '').trim().replace(/\/$/, '')).filter(Boolean)
app.use(cors({ origin: (origen, cb) => cb(null, !origen || ORIGENES.includes(origen) || /^http:\/\/localhost(:\d+)?$/.test(origen)) }))
// Cuerpos JSON chicos, salvo la subida de la foto de un evento. Los avisos de Chytapay se firman
// sobre el cuerpo CRUDO: se guarda antes de parsearlo.
const jsonChico = express.json({ limit: '50kb', verify: (req, _res, buf) => { if (req.originalUrl.startsWith('/api/webhooks/')) req.cuerpoCrudo = Buffer.from(buf) } })
const jsonGrande = express.json({ limit: '4mb' })
app.use((req, res, next) => (/^\/api\/admin\/eventos\/[^/]+\/imagen$/.test(req.path) ? jsonGrande : jsonChico)(req, res, next))

// ───── Configuración ─────
const PORT = process.env.PORT || 3030
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '')
const FRONTEND_URL = (process.env.FRONTEND_URL || PUBLIC_URL).replace(/\/$/, '')
// OJO: no usar `Number(x) || def`: un 0 explícito (por ejemplo CARGO_PCT=0) caería en el default.
function numEnv(clave, porDefecto) {
  const v = process.env[clave]
  if (v === undefined || String(v).trim() === '') return porDefecto
  const n = Number(v)
  return Number.isFinite(n) ? n : porDefecto
}
const CARGO_PCT = numEnv('CARGO_PCT', 10)              // costo de servicio online (lo paga el comprador, va adentro del precio)
const CARGO_PUNTO_PCT = numEnv('CARGO_PUNTO_PCT', 10)  // en los puntos de venta: mismo precio final que online
const MAX_ENTRADAS = numEnv('MAX_ENTRADAS', 10)
const RESERVA_MINUTOS = Math.min(60, Math.max(10, numEnv('RESERVA_MINUTOS', 30)))  // también es el vencimiento del cobro en Chytapay (3 a 60)
const POCAS = numEnv('AVISO_POCAS', 30)                // desde cuántas libres se avisa "quedan pocas" (el cupo nunca se muestra)
const SIN_TOPE = 100000                                 // un cupo así de grande = "sin tope": el panel no muestra barra ni libres
const VENTA_ABIERTA = String(process.env.VENTA_ABIERTA || 'true') !== 'false'   // llave general de la venta online
const ORGANIZACION = ['admin', 'organizador']          // ven resumen, ventas, planilla y cargan la cartelera

const EVENTO_MAIL_FROM = process.env.EVENTO_MAIL_FROM || 'entradas@ejemplo.com.ar'
const IS_PROD = process.env.NODE_ENV === 'production'
const QR_SECRET = process.env.QR_SECRET || 'CAMBIAR_ESTE_SECRETO_EN_PRODUCCION'
if (IS_PROD && (QR_SECRET.startsWith('CAMBIAR') || QR_SECRET.length < 24)) {
  console.error('❌ Falta QR_SECRET (o es muy corto): sin eso los QR y las sesiones se podrían falsificar. No arranco.')
  process.exit(1)
}
const SCAN_TOKEN = process.env.SCAN_TOKEN || ''
const NO_VENTA = ['prueba']                 // no ocupan lugar ni son plata
const NO_PLATA = ['prueba', 'cortesia']     // ocupan lugar pero no son venta

// ───── Hora argentina ─────
// Argentina es UTC-3 todo el año y Render corre en UTC.
const HORAS_AR = 3
const aISO = d => d.toISOString().slice(0, 10)
const hoyAR = (d = new Date()) => aISO(new Date(d.getTime() - HORAS_AR * 3600 * 1000))
function comienzoDelDiaArgentino() {
  const aca = new Date(Date.now() - HORAS_AR * 3600 * 1000)
  return new Date(Date.UTC(aca.getUTCFullYear(), aca.getUTCMonth(), aca.getUTCDate(), HORAS_AR, 0, 0))
}
// "La noche" de un evento va del mediodía de su fecha al mediodía siguiente: el ingreso de la
// madrugada sigue contando para esa misma fecha.
const nocheDeHoy = (ahora = new Date()) => aISO(new Date(ahora.getTime() - HORAS_AR * 3600 * 1000 - 12 * 3600 * 1000))
const pesos = n => '$' + Number(n).toLocaleString('es-AR')
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
function cuandoDe(ev) {
  const d = new Date(ev.fecha + 'T12:00:00Z')
  return `${DIAS[d.getUTCDay()]} ${d.getUTCDate()} de ${MESES[d.getUTCMonth()]}${ev.hora ? ` · ${ev.hora} h` : ''}`
}
const fechaCorta = ev => ev.fecha.slice(8, 10) + '/' + ev.fecha.slice(5, 7)

// ───── Precios ─────
// El precio de un tipo HOY (hora argentina): la primera etapa que todavía rige, o el precio base.
const precioVigente = (t, dia = hoyAR()) => (t.etapas || []).find(e => dia <= e.hasta)?.precio ?? t.precio
// Lo que paga el público por `cantidad` entradas y cómo se reparte (academia / cargo).
// Con precioIncluyeCargo el total es exacto (precio × cantidad) y el cargo sale de adentro.
function importes(precio, cantidad, pct) {
  if (SITIO.precioIncluyeCargo) {
    const total = precio * cantidad, subtotal = Math.round(total * 100 / (100 + pct))
    return { subtotal, cargo: total - subtotal, total }
  }
  const subtotal = precio * cantidad, cargo = Math.round(subtotal * pct / 100)
  return { subtotal, cargo, total: subtotal + cargo }
}
const finalDe = (precio, pct = CARGO_PCT) => importes(precio, 1, pct).total
// Para la página: el calendario de precios (finales) con la etapa que rige hoy marcada.
function etapasPublicas(t, dia = hoyAR()) {
  if (!t.etapas?.length) return {}
  const hoy = t.etapas.findIndex(e => dia <= e.hasta)
  return { etapas: t.etapas.map((e, i) => ({ hasta: e.hasta, nombre: e.nombre, final: finalDe(e.precio), vigente: i === hoy, paso: hoy === -1 || i < hoy })),
    finalDespues: finalDe(t.precio) }
}

// ───── Cartelera (en memoria; se recarga cada vez que el panel cambia algo) ─────
let EVENTOS = new Map()
async function cargarEventos() {
  const filas = await Evento.findAll({ order: [['fecha', 'ASC'], ['hora', 'ASC']] })
  EVENTOS = new Map(filas.map(f => [f.id, f.get({ plain: true })]))
  _ocCache = { t: 0, v: null }
}
const eventoDe = id => EVENTOS.get(String(id || ''))
const tipoDe = (ev, tipo) => ev?.tipos?.find(t => t.id === String(tipo || ''))
const noPaso = ev => ev.fecha >= nocheDeHoy()   // hasta el mediodía siguiente sigue "vigente"
const enFechaDeVenta = ev => !ev.ventaHasta || hoyAR() <= ev.ventaHasta   // después, solo en puerta
const vendibleOnline = ev => ev && Number(ev.publicado) !== 0 && Number(ev.ventaAbierta) !== 0 && noPaso(ev) && enFechaDeVenta(ev) && ev.tipos.length > 0
// El evento que se controla en la puerta por defecto: el de hoy, o el próximo.
function eventoActual() {
  const lista = [...EVENTOS.values()]
  return lista.find(e => e.fecha === nocheDeHoy()) || lista.find(e => e.fecha >= nocheDeHoy()) || lista[lista.length - 1] || null
}
const nombreDe = o => { const ev = eventoDe(o.evento); return { eventoNombre: ev?.nombre || o.evento, cuando: ev ? cuandoDe(ev) : '', tipoNombre: tipoDe(ev, o.tipo)?.nombre || o.tipo } }

// La portada con los datos del sitio puestos por el servidor: WhatsApp y Google no ejecutan JavaScript,
// así que el título y la descripción de la vista previa tienen que venir ya en el HTML.
const escAttr = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// Una gala puede traer su PROPIA portada (temas/<tema>/index.html, diseño exclusivo); si no, va la del molde.
// Compra, panel, puerta y mails son siempre los del molde.
const PORTADA_TEMA = join(TEMA_DIR, 'index.html')
const PORTADA = readFileSync(existsSync(PORTADA_TEMA) ? PORTADA_TEMA : join(FRONT, 'index.html'), 'utf8')
  .replaceAll('%%NOMBRE%%', escAttr(SITIO.nombre))
  .replaceAll('%%DESCRIPCION%%', escAttr([SITIO.lema || SITIO.organiza, SITIO.direccion || SITIO.lugar].filter(Boolean).join(' · ') + '. Entradas online con QR al instante.'))
  .replaceAll('%%URL%%', escAttr(FRONTEND_URL))
app.get(['/', '/index.html'], (_req, res) => { res.set('Cache-Control', 'no-cache'); res.type('html').send(PORTADA) })

// La página y sus archivos. Las fotos casi no cambian: caché de un día. El HTML, siempre fresco.
// Primero los del tema del cliente (logo, fotos, colores); si no los tiene, los del molde.
const cacheEstatico = { setHeaders(res, ruta) {
  if (/\.(webp|jpg|jpeg|png|mp4|woff2|svg|ico)$/i.test(ruta)) res.set('Cache-Control', 'public, max-age=86400')
  else res.set('Cache-Control', 'no-cache')
} }
app.use('/assets', express.static(join(TEMA_DIR, 'assets'), cacheEstatico))
const TEMA_CSS = join(TEMA_DIR, 'tema.css')
app.get('/tema.css', (_req, res) => { res.set('Cache-Control', 'no-cache'); existsSync(TEMA_CSS) ? res.sendFile(TEMA_CSS) : res.type('css').send('') })
app.use(express.static(FRONT, cacheEstatico))

// ───── Seguridad ─────
// Firma HMAC del contenido del QR: no se puede falsificar sin el secreto.
function firmarQR(base) {
  const sig = createHmac('sha256', QR_SECRET).update(base).digest('hex').slice(0, 16)
  return `${base}::${sig}`
}
function verificarQR(codigo) {
  const parts = String(codigo).split('::')
  if (parts.length < 3) return null
  const sig = parts.pop()
  const base = parts.join('::')
  const esperado = createHmac('sha256', QR_SECRET).update(base).digest('hex').slice(0, 16)
  const a = Buffer.from(sig), b = Buffer.from(esperado)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  return base // "ordenId::indice"
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function ipDe(req) {
  const cf = String(req.headers['cf-connecting-ip'] || '').trim()
  if (cf) return cf
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean)
  return xff[xff.length - 1] || req.socket.remoteAddress || 'x'   // el último lo agrega el proxy, no el cliente
}
// Límite simple por IP, en memoria.
function rateLimit({ windowMs, max, msg }) {
  const hits = new Map()
  return (req, res, next) => {
    const ip = ipDe(req), now = Date.now()
    let rec = hits.get(ip)
    if (!rec || now > rec.reset) { rec = { count: 0, reset: now + windowMs }; hits.set(ip, rec) }
    rec.count++
    if (hits.size > 50000) hits.clear()
    if (rec.count > max) return res.status(429).json({ error: msg || 'Demasiadas solicitudes. Probá en un momento.' })
    next()
  }
}

// ───── Sesiones del panel ─────
function hashPassword(password, salt) { return scryptSync(String(password), salt, 64).toString('hex') }
function verifyPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex'), b = Buffer.from(hash, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
// Token firmado (mini-JWT con HMAC), válido 12 h
function firmarToken(payload) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 12 * 3600 * 1000 })).toString('base64url')
  const sig = createHmac('sha256', QR_SECRET).update(body).digest('base64url').slice(0, 32)
  return `${body}.${sig}`
}
function verificarToken(token) {
  const [body, sig] = String(token || '').split('.')
  if (!body || !sig) return null
  const esperado = createHmac('sha256', QR_SECRET).update(body).digest('base64url').slice(0, 32)
  const a = Buffer.from(sig), b = Buffer.from(esperado)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (p.exp && Date.now() > p.exp) return null
    return p
  } catch { return null }
}
const tokenDeReq = req => verificarToken((req.headers.authorization || '').replace(/^Bearer /, ''))
const _activos = new Map()   // usuario → { activo, rol, t }: se consulta la base como mucho una vez por minuto
async function sigueActivo(p) {
  const c = _activos.get(p.usuario)
  if (c && Date.now() - c.t < 60000) return c.activo && c.rol === p.rol
  const u = await Usuario.findOne({ where: { usuario: p.usuario }, attributes: ['activo', 'rol'], raw: true }).catch(() => null)
  const v = { activo: Boolean(u) && Number(u.activo) !== 0, rol: u?.rol, t: Date.now() }   // MySQL lo devuelve como 0/1
  _activos.set(p.usuario, v)
  return v.activo && v.rol === p.rol
}
function requireAuth(roles) {
  return async (req, res, next) => {
    const p = tokenDeReq(req)
    if (!p) return res.status(401).json({ error: 'No autorizado' })
    if (roles && !roles.includes(p.rol)) return res.status(403).json({ error: 'Sin permiso' })
    if (!(await sigueActivo(p))) return res.status(401).json({ error: 'Este acceso está deshabilitado' })
    req.usuario = p
    next()
  }
}

// ───── QR e imágenes ─────
const QR_COLOR = { dark: '#111111', light: '#ffffff' }   // casi negro: lo leen bien hasta las cámaras malas
const urlQR = codigo => `/qr?c=${encodeURIComponent(codigo)}`
// La imagen se arma al vuelo desde el código firmado: el disco de Render se borra en cada deploy.
app.get('/qr', async (req, res) => {
  try {
    const codigo = String(req.query.c || '')
    if (!verificarQR(codigo)) return res.status(400).send('QR inválido')
    const png = await QRCode.toBuffer(codigo, { width: 440, margin: 2, color: QR_COLOR })
    res.set('Content-Type', 'image/png')
    res.set('Cache-Control', 'public, max-age=86400')
    res.send(png)
  } catch (e) {
    console.error('❌ Error generando QR al vuelo:', e?.message || e)
    res.status(500).send('Error generando QR')
  }
})
// Fotos de la cartelera (subidas desde el panel). Cada subida tiene id nuevo: se pueden cachear para siempre.
app.get('/img/:id', async (req, res) => {
  try {
    const im = await Imagen.findByPk(Number(req.params.id) || 0)
    if (!im) return res.sendStatus(404)
    res.set('Content-Type', im.tipo)
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    res.send(im.datos)
  } catch { res.sendStatus(500) }
})

// ═══════════════════════════════════════════════════════════════
//  CUPO (por evento y tipo de entrada)
//  Ocupan lugar las entradas pagadas (también las cortesías) y las compras
//  empezadas hace menos de RESERVA_MINUTOS, que todavía pueden pagarse.
// ═══════════════════════════════════════════════════════════════
async function ocupacion(eventoId, transaction) {
  const ev = eventoDe(eventoId)
  const corte = new Date(Date.now() - RESERVA_MINUTOS * 60 * 1000)
  const filas = await Orden.findAll({
    attributes: ['tipo', 'estado', [fn('SUM', col('cantidad')), 'cant']],
    where: {
      evento: eventoId, metodo: { [Op.notIn]: NO_VENTA },
      [Op.or]: [{ estado: 'pagada' }, { estado: 'pendiente', createdAt: { [Op.gte]: corte } }],
    },
    group: ['tipo', 'estado'], raw: true, transaction,
  })
  const oc = Object.fromEntries((ev?.tipos || []).map(t => [t.id, { vendidas: 0, reservadas: 0, cupo: t.cupo, libres: 0 }]))
  for (const f of filas) if (oc[f.tipo]) oc[f.tipo][f.estado === 'pagada' ? 'vendidas' : 'reservadas'] += Number(f.cant)
  for (const t of Object.values(oc)) t.libres = Math.max(0, t.cupo - t.vendidas - t.reservadas)
  return oc
}

// Un solo proceso a la vez cuenta el cupo y crea la orden (bloqueo con nombre de MySQL).
// El nombre lleva la base: varios sistemas pueden compartir el mismo servidor de Aiven.
const LOCK = `cupo_${String(process.env.DB_NAME || 'gala').replace(/[^A-Za-z0-9_]/g, '').slice(0, 50)}`
async function conCupo(trabajo) {
  return sequelize.transaction(async transaction => {
    const [r] = await sequelize.query('SELECT GET_LOCK(?, 15) AS ok', { replacements: [LOCK], type: QueryTypes.SELECT, transaction })
    if (!r || Number(r.ok) !== 1) throw new Error('No se pudo reservar el cupo, probá de nuevo')
    try { return await trabajo(transaction) }
    finally { await sequelize.query('SELECT RELEASE_LOCK(?)', { replacements: [LOCK], type: QueryTypes.SELECT, transaction }) }
  })
}
// Valida evento, tipo y cantidad, y crea la orden si hay lugar. Devuelve { orden } o { error, status }.
async function crearOrdenConCupo(datos) {
  return conCupo(async transaction => {
    const oc = await ocupacion(datos.evento, transaction)
    const libres = oc[datos.tipo]?.libres ?? 0
    if (libres < datos.cantidad) {
      const que = tipoDe(eventoDe(datos.evento), datos.tipo)?.nombre.toLowerCase() || 'entradas'
      return { status: 409, error: libres > 0 ? `Quedan ${libres} (${que}).` : `Se agotaron (${que}).` }
    }
    const orden = await Orden.create(datos, { transaction })
    return { orden }
  })
}
// online: el evento tiene que estar publicado y con venta abierta. Punto de venta y cortesías: alcanza
// con que no haya pasado (en la boletería se vende aunque online esté cerrado).
function validarCompra(body, { maximo = MAX_ENTRADAS, online = true } = {}) {
  const ev = eventoDe(body.evento)
  if (!ev) return { error: 'Elegí la fecha.' }
  if (online ? !vendibleOnline(ev) : !noPaso(ev)) return { error: 'La venta para esa fecha no está abierta.' }
  const t = tipoDe(ev, body.tipo)
  if (!t) return { error: 'Elegí el tipo de entrada.' }
  const cantidad = parseInt(body.cantidad, 10)
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > maximo) return { error: `La cantidad va de 1 a ${maximo}.` }
  const nombre = String(body.nombre || '').trim().replace(/\s+/g, ' ')
  const email = String(body.email || '').trim().toLowerCase()
  const dni = String(body.dni || '').replace(/\D/g, '')
  if (nombre.length < 3) return { error: 'Falta tu nombre y apellido.' }
  if (nombre.length > 80 || !/^[\p{L}][\p{L}\p{M} '’.-]*$/u.test(nombre)) return { error: 'Revisá el nombre: solo letras y espacios.' }
  if (email.length > 120 || !/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/.test(email)) return { error: 'Revisá el email: ahí te llegan las entradas.' }
  if (dni.length < 7 || dni.length > 9) return { error: 'Revisá el DNI (solo números).' }
  return { evento: ev.id, tipo: t.id, cantidad, nombre, email, dni, precio: precioVigente(t) }
}

// ═══════════════════════════════════════════════════════════════
//  EMAIL
// ═══════════════════════════════════════════════════════════════
let _transporter = null
async function getTransporter() {
  if (_transporter) return _transporter
  if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
    _transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false },
    })
    console.log(`📮 Email: Gmail (${process.env.EMAIL_USER})`)
  } else {
    // Sin credenciales: Ethereal (solo vista previa, no llega a ninguna bandeja)
    const cuenta = await nodemailer.createTestAccount()
    _transporter = nodemailer.createTransport({ host: 'smtp.ethereal.email', port: 587, secure: false, auth: { user: cuenta.user, pass: cuenta.pass } })
    console.log('📮 Email: Ethereal (vista previa)')
  }
  return _transporter
}
const remitente = () => `"${SITIO.nombre.replace(/"/g, '')}" <${process.env.EMAIL_USER || EVENTO_MAIL_FROM}>`
const LOGO_MAIL = existsSync(join(TEMA_DIR, 'assets', 'mail-logo.png')) ? join(TEMA_DIR, 'assets', 'mail-logo.png') : join(FRONT, 'assets', 'mail-logo.png')
const primerNombre = n => escapeHtml(String(n || '').split(' ')[0])
const cuantasEntradas = (orden) => orden.cantidad === 1 ? '1 entrada' : `${orden.cantidad} entradas`

const MC = SITIO.mail   // colores del mail del tema (sitio.json → "mail")
const botonMail = `background:${MC.acento};color:${MC.acentoTexto};text-decoration:none;`
function encabezadoMail(ev) {
  const logo = existsSync(LOGO_MAIL) ? `<img src="cid:logo" width="110" height="110" alt="" style="display:block;margin:0 auto 10px;border-radius:50%;">` : ''
  // La franja va en celdas con fondo (no con degradé): así se ve igual en Gmail, Outlook y el celular.
  const franja = MC.franja.length ? `
      <tr><td style="padding:0;font-size:0;line-height:0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        ${MC.franja.map(c => `<td height="6" style="height:6px;background:${c};font-size:0;line-height:0;">&nbsp;</td>`).join('')}
      </tr></table></td></tr>` : ''
  return `
      <tr><td align="center" style="background:${MC.encabezado};padding:26px 20px 22px;">
        ${logo}
        <div style="font:800 13px/1.4 Arial,sans-serif;letter-spacing:.24em;text-transform:uppercase;color:${MC.sobrecabeza};">${escapeHtml(SITIO.nombre)}</div>
        <div style="font:700 20px/1.3 Arial,sans-serif;color:#ffffff;margin-top:6px;">${escapeHtml(ev?.nombre || '')}</div>
        <div style="font:400 14px/1.5 Arial,sans-serif;color:#d9d3e8;margin-top:4px;">${escapeHtml(ev ? cuandoDe(ev) : '')}</div>
      </td></tr>${franja}`
}
const adjuntoLogo = () => existsSync(LOGO_MAIL) ? [{ filename: 'logo.png', path: LOGO_MAIL, cid: 'logo' }] : []

// Mail para el que quedó a mitad de camino. Se manda UNA sola vez por persona.
async function enviarMailPendiente(orden) {
  const t = await getTransporter()
  const ev = eventoDe(orden.evento)
  const ayuda = SITIO.ayudaWhatsapp ? `
        <div style="background:#f4f1f8;border-radius:12px;padding:16px;text-align:center;margin-top:18px;">
          <p style="margin:0 0 10px;font-size:14px;">¿Preferís que te demos una mano?</p>
          <a href="https://wa.me/${SITIO.ayudaWhatsapp}?text=${encodeURIComponent(`Hola, quise comprar entradas para ${ev?.nombre || SITIO.nombre} y no pude completar el pago.`)}"
             style="background:#25D366;color:#fff;text-decoration:none;font-weight:700;padding:11px 26px;border-radius:24px;display:inline-block;font-size:14px;">Escribinos por WhatsApp</a>
        </div>` : ''
  await t.sendMail({
    from: remitente(), to: orden.email,
    subject: `¿Tuviste problemas para pagar tus entradas de ${ev?.nombre || SITIO.nombre}?`,
    attachments: adjuntoLogo(),
    html: `
  <div style="background:#f1eef5;padding:22px 12px;font-family:Arial,sans-serif;color:#1d1830;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;">
      ${encabezadoMail(ev)}
      <tr><td style="padding:26px;">
        <p style="font-size:16px;margin:0 0 12px;">Hola ${primerNombre(orden.nombre)}:</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 12px;">Empezaste a comprar <b>${cuantasEntradas(orden)}</b> y el pago quedó sin completar. <b>No se te cobró nada.</b></p>
        <p style="font-size:15px;line-height:1.6;margin:0;">Se paga por transferencia, desde la app de tu banco o de tu billetera. Importante: <b>transferí desde una cuenta a tu nombre</b>, con el DNI que pusiste en la compra.</p>
        <div style="text-align:center;margin:24px 0 4px;">
          <a href="${FRONTEND_URL}/comprar?evento=${encodeURIComponent(orden.evento)}" style="${botonMail}font-weight:800;padding:14px 32px;border-radius:30px;display:inline-block;">Retomar mi compra</a>
        </div>${ayuda}
        <p style="font-size:12px;color:#7d7590;margin:22px 0 0;text-align:center;">Si ya compraste, ignorá este mensaje.</p>
      </td></tr>
    </table>
  </div>`,
  })
  console.log(`✉️ Recordatorio enviado a ${orden.email} (${cuantasEntradas(orden)})`)
}

// Mail con las entradas. Los QR van adjuntos (cid): muchos correos bloquean imágenes externas.
async function enviarMailEntradas(orden, entradas) {
  const t = await getTransporter()
  const ev = eventoDe(orden.evento)
  const tipo = tipoDe(ev, orden.tipo) || { nombre: orden.tipo }
  const attachments = []
  for (const [i, e] of entradas.entries()) {
    attachments.push({ filename: `entrada-${i + 1}.png`, content: await QRCode.toBuffer(e.codigo, { width: 480, margin: 2, color: QR_COLOR }), cid: `qr${i}` })
  }
  attachments.push(...adjuntoLogo())
  const nombreEv = ev?.nombre || orden.evento, cuando = ev ? cuandoDe(ev) : ''
  const invitacion = orden.metodo === 'cortesia'   // cortesía: el mail no habla de "compra"

  const qrsHtml = entradas.map((e, i) => `
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 18px;">
          <tr><td align="center" style="background:#ffffff;border:3px solid ${MC.franja.length ? MC.franja[i % MC.franja.length] : '#1d1830'};border-radius:14px;padding:18px 14px;">
            <div style="font:800 13px/1.3 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MC.titulos};">${escapeHtml(nombreEv)} · ${ev ? fechaCorta(ev) : ''}</div>
            <div style="font:700 13px/1.3 Arial,sans-serif;color:#3a334d;margin-top:4px;">${escapeHtml(tipo.nombre)} · ${i + 1} de ${orden.cantidad}</div>
            <img src="cid:qr${i}" width="240" height="240" alt="Código QR de la entrada ${i + 1}" style="display:block;margin:12px auto 8px;">
            <div style="font:400 10px/1.4 Consolas,monospace;color:#9a9a9a;word-break:break-all;max-width:320px;margin:auto;">${escapeHtml(e.codigo)}</div>
          </td></tr>
        </table>`).join('')
  const puertas = ev?.puertas ? `<br>Apertura de puertas: <b>${escapeHtml(ev.puertas)}</b>` : ''
  const artistas = ev?.artistas?.length ? `<br>${escapeHtml(ev.artistas.join(' · '))}` : ''

  const html = `
  <div style="background:#f1eef5;padding:22px 12px;font-family:Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;">
      ${encabezadoMail(ev)}
      <tr><td style="padding:26px 26px 6px;">
        <div style="font:800 20px/1.3 Arial,sans-serif;color:#1d1830;">${invitacion ? '¡Hola' : '¡Listo'}, ${primerNombre(orden.nombre)}!</div>
        <p style="font:400 15px/1.6 Arial,sans-serif;color:#3a334d;margin:10px 0 0;">${invitacion ? `${escapeHtml(SITIO.organiza || SITIO.nombre)} te invita.` : 'Tu compra se confirmó.'} Abajo ${orden.cantidad > 1 ? `están tus <b>${cuantasEntradas(orden)}</b>, cada una con su QR` : `está tu <b>entrada</b> con su QR`}. Cada QR sirve para entrar <b>una vez</b>, solo el <b>${escapeHtml(cuando)}</b>.</p>
      </td></tr>
      <tr><td style="padding:16px 26px 0;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f1f8;border-radius:12px;">
          <tr><td style="padding:14px 18px;font:400 14px/1.8 Arial,sans-serif;color:#3a334d;">
            <b>${escapeHtml(nombreEv)}</b> · ${escapeHtml(cuando)}${artistas}<br>
            <b>${escapeHtml(tipo.nombre)}</b><br>
            ${escapeHtml(SITIO.lugar)}${SITIO.direccion ? '<br>' + escapeHtml(SITIO.direccion) : ''}${puertas}
          </td></tr>
        </table>
      </td></tr>
      <tr><td style="padding:22px 26px 0;">${qrsHtml}</td></tr>
      <tr><td style="padding:4px 26px 0;">
        <div style="font:800 12px/1.2 Arial,sans-serif;letter-spacing:.14em;text-transform:uppercase;color:${MC.titulos};margin-bottom:8px;">Cómo entrar</div>
        <ul style="font:400 14px/1.7 Arial,sans-serif;color:#3a334d;margin:0;padding-left:20px;">
          <li>Mostrá el QR en la puerta, desde el celular o impreso. <b>Hacele una captura</b>: en el lugar puede no haber señal.</li>
          <li>Cada persona necesita su propio QR.</li>
          <li>Si se te pierde este mail, entrá a <b>Mis entradas</b> con tu email y tu DNI.</li>
        </ul>
      </td></tr>
      <tr><td align="center" style="padding:22px 26px 6px;">
        <a href="${FRONTEND_URL}/mis-entradas" style="display:inline-block;${botonMail}font:800 15px/1 Arial,sans-serif;padding:14px 30px;border-radius:999px;">Ver mis entradas</a>
      </td></tr>
      <tr><td align="center" style="padding:18px 26px 26px;">
        <div style="font:400 12px/1.6 Arial,sans-serif;color:#7d7590;">${escapeHtml(SITIO.nombre)}${SITIO.lema ? ' · ' + escapeHtml(SITIO.lema) : ''}<br>N° de compra: ${escapeHtml(orden.id)}</div>
      </td></tr>
    </table>
  </div>`

  const texto = `${invitacion ? '¡Hola' : '¡Listo'}, ${String(orden.nombre || '').split(' ')[0]}!

${invitacion ? `${SITIO.organiza || SITIO.nombre} te invita` : 'Tu compra se confirmó'}: ${cuantasEntradas(orden)} · ${tipo.nombre}.
${nombreEv} · ${cuando}
${SITIO.lugar}${SITIO.direccion ? ' · ' + SITIO.direccion : ''}

Los QR van adjuntos a este mail. Mostralos en la puerta desde el celular o impresos. Cada QR sirve una sola vez, solo esa fecha.
Si no ves las imágenes, entrá a ${FRONTEND_URL}/mis-entradas con tu email y tu DNI.

N° de compra: ${orden.id}`

  const info = await t.sendMail({
    from: remitente(), to: orden.email,
    subject: invitacion ? `Tu invitación para ${nombreEv} (${ev ? fechaCorta(ev) : ''})`
      : orden.cantidad > 1 ? `Tus ${cuantasEntradas(orden)} para ${nombreEv} (${ev ? fechaCorta(ev) : ''})` : `Tu entrada para ${nombreEv} (${ev ? fechaCorta(ev) : ''})`,
    text: texto, html, attachments,
  })
  const vista = nodemailer.getTestMessageUrl(info)
  console.log(vista ? `📧 Mail (vista previa): ${vista}` : `📧 Mail enviado a ${orden.email}`)
  return vista || null
}

// ═══════════════════════════════════════════════════════════════
//  EMITIR LAS ENTRADAS de una orden ya pagada (un QR por entrada)
// ═══════════════════════════════════════════════════════════════
async function emitirEntradas(orden, { mandarMail = true } = {}) {
  const filas = []
  for (let i = 1; i <= orden.cantidad; i++) {
    const base = `${orden.id}::${i}`
    filas.push({ orden_id: orden.id, evento: orden.evento, indice: i, tipo: orden.tipo, codigo: firmarQR(base), base })
  }
  await Entrada.bulkCreate(filas, { ignoreDuplicates: true })
  const entradas = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
  let vista = null
  if (mandarMail) {
    try { vista = await enviarMailEntradas(orden, entradas) }
    catch (e) { console.error(`⚠️ Orden ${orden.id}: se emitió pero falló el mail:`, e?.message || e) }
  }
  return { entradas, vista }
}

// Idempotencia ATÓMICA: solo el primero que pasa la orden a "pagada" emite las entradas
// (si llegan el aviso y la consulta de la página juntos, no se emite dos veces).
async function confirmarYEmitir(orden, extra = {}) {
  const campos = { estado: 'pagada', pagadaEn: new Date(), medioPago: extra.medioPago || 'transferencia',
    ...(extra.pagador ? { pagador: String(extra.pagador).slice(0, 120) } : {}) }
  const [afectadas] = await Orden.update(campos, { where: { id: orden.id, estado: { [Op.in]: ['pendiente', 'abandonada'] } } })
  if (!afectadas) return false
  Object.assign(orden, campos)
  const { entradas } = await emitirEntradas(orden)
  console.log(`✅ Orden ${orden.id} PAGADA → ${entradas.length} QR (${orden.evento} · ${orden.tipo}) + mail a ${orden.email}`)
  return true
}

// ═══════════════════════════════════════════════════════════════
//  1) COMPRA ONLINE: crear la orden y el cobro de checkout en Chytapay
// ═══════════════════════════════════════════════════════════════
// Compras sin pagar que todavía guardan lugar: como mucho MAX_PENDIENTES por DNI o email y
// MAX_PENDIENTES_IP por conexión (en los celulares muchos comparten IP: el tope por IP es más alto).
const MAX_PENDIENTES = numEnv('MAX_PENDIENTES', 2)
const MAX_PENDIENTES_IP = numEnv('MAX_PENDIENTES_IP', 8)
const pendientesPorIp = new Map()   // ip → [{ id, t }]
async function demasiadasPendientes(v, ip) {
  const corte = new Date(Date.now() - RESERVA_MINUTOS * 60 * 1000)
  const mias = await Orden.count({ where: { estado: 'pendiente', metodo: 'chytapay', createdAt: { [Op.gte]: corte },
    [Op.or]: [{ dni: v.dni }, { email: v.email }] } })
  if (mias >= MAX_PENDIENTES) return `Ya tenés ${mias} compras empezadas sin pagar. Para retomar una, pedí la misma cantidad de entradas y tocá «Ir a pagar» de nuevo; si no, esperá ${RESERVA_MINUTOS} minutos.`
  if (pendientesPorIp.size > 50000) pendientesPorIp.clear()   // nunca crece sin límite
  const lista = (pendientesPorIp.get(ip) || []).filter(x => x.t > corte.getTime())
  pendientesPorIp.set(ip, lista)
  if (lista.length >= MAX_PENDIENTES_IP) {
    const siguen = await Orden.count({ where: { id: lista.map(x => x.id), estado: 'pendiente' } })
    if (siguen >= MAX_PENDIENTES_IP) return 'Hay demasiadas compras sin terminar desde esta conexión. Probá de nuevo en unos minutos.'
  }
  return null
}
// La misma compra de la misma persona (DNI y email), todavía pendiente y con tiempo para pagar: se
// retoma ese cobro en vez de crear otro. Pasa cuando la pantalla de pago no abrió y vuelve a tocar
// "Ir a pagar": antes quedaba frenada por el tope de compras sin pagar.
const RETOMAR_MINIMO = 5   // minutos que le tienen que quedar al cobro para retomarlo
const compraParaRetomar = v => Orden.findOne({ where: { estado: 'pendiente', metodo: 'chytapay', paymentId: { [Op.ne]: null },
  createdAt: { [Op.gte]: new Date(Date.now() - (RESERVA_MINUTOS - RETOMAR_MINIMO) * 60000) },
  evento: v.evento, tipo: v.tipo, cantidad: v.cantidad, dni: v.dni, email: v.email }, order: [['createdAt', 'DESC']] })

app.post('/api/orders', rateLimit({ windowMs: 60000, max: 30 }), async (req, res) => {
  try {
    if (!VENTA_ABIERTA) return res.status(403).json({ error: 'La venta online todavía no está abierta.' })
    if (!chytapayConfigurado()) return res.status(503).json({ error: 'El cobro online no está disponible en este momento.' })
    const v = validarCompra(req.body || {})
    if (v.error) return res.status(400).json({ error: v.error })
    const previa = await compraParaRetomar(v)
    if (previa) {
      const minutos = Math.max(1, Math.floor((new Date(previa.createdAt).getTime() + RESERVA_MINUTOS * 60000 - Date.now()) / 60000))
      console.log(`🔁 Compra retomada: ${previa.id} · ${pesos(previa.total)}`)
      return res.json({ orderId: previa.id, pago: { paymentId: previa.paymentId, pk: clavePublicable(), minutos }, total: previa.total, retomada: true })
    }
    const ip = ipDe(req)
    const freno = await demasiadasPendientes(v, ip)
    if (freno) return res.status(429).json({ error: freno })

    const id = 'orden_' + randomUUID()
    const { subtotal, cargo, total } = importes(v.precio, v.cantidad, CARGO_PCT)
    const { precio, ...datos } = v
    const r = await crearOrdenConCupo({ id, ...datos, metodo: 'chytapay', subtotal, cargo, total, estado: 'pendiente' })
    if (r.error) return res.status(r.status).json({ error: r.error })
    pendientesPorIp.get(ip)?.push({ id, t: Date.now() }) ?? pendientesPorIp.set(ip, [{ id, t: Date.now() }])

    // Si Chytapay falla, la orden se borra: si no, guardaría lugar en el cupo sin poder pagarse.
    // El comprador ve un solo precio: una sola descripción con el total, sin el costo de servicio aparte.
    const ev = eventoDe(v.evento)
    const etiqueta = `${v.cantidad} × ${tipoDe(ev, v.tipo).nombre} · ${ev.nombre} ${fechaCorta(ev)}`
    let cobro
    try {
      cobro = await crearCobroCheckout({ referenceId: id, amount: total, description: etiqueta,
        expiresInMinutes: RESERVA_MINUTOS, metadata: { orden: id, evento: ev.id }, webhookUrl: `${PUBLIC_URL}/api/webhooks/chytapay` })
    } catch (e) {
      await Orden.destroy({ where: { id, estado: 'pendiente' } }).catch(() => {})
      throw e
    }
    await Orden.update({ paymentId: cobro.paymentRequestId }, { where: { id } })
    console.log(`🧾 Orden creada: ${id} · ${etiqueta} · ${pesos(total)}`)
    // El paymentRequestId es sensible (con la clave pública alcanza para leer el cobro): va solo a esta respuesta.
    res.json({ orderId: id, pago: { paymentId: cobro.paymentRequestId, pk: clavePublicable(), minutos: RESERVA_MINUTOS }, total })
  } catch (e) {
    console.error('❌ Error creando orden:', e?.message || e)
    res.status(500).json({ error: 'No se pudo iniciar la compra. Probá de nuevo en un momento.' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  2) CHYTAPAY: avisos firmados + consulta del cobro
// ═══════════════════════════════════════════════════════════════
async function verificarYEmitir(orden) {
  if (orden.estado === 'pagada') return true
  if (orden.metodo !== 'chytapay') return false
  const r = await cobroPagado(orden.id, orden.total)
  if (!r.ok) return false
  await confirmarYEmitir(orden, { pagador: r.cobro?.reconciledPayerName })
  return true
}

const _avisosVistos = new Set()   // X-Chytapay-Webhook-Id ya procesados (los reintentos traen el mismo)
const limiteAvisos = rateLimit({ windowMs: 60000, max: 600 })
app.post('/api/webhooks/chytapay', limiteAvisos, async (req, res) => {
  // Prueba al registrar la URL en el Portal: responder 2xx y no procesar.
  if (String(req.headers['x-chytapay-webhook-test'] || '') === 'true') return res.sendStatus(200)
  if (!firmaValida(req.cuerpoCrudo, req.headers['x-chytapay-signature'])) {
    console.log('⚠️ Aviso de Chytapay con firma inválida o vencida: rechazado')
    return res.sendStatus(401)   // si fuera de verdad de Chytapay, lo reintenta
  }
  const avisoId = String(req.headers['x-chytapay-webhook-id'] || '')
  if (avisoId && _avisosVistos.has(avisoId)) return res.sendStatus(200)
  res.sendStatus(200)   // responder en menos de 5 s; procesar después
  if (avisoId) { _avisosVistos.add(avisoId); if (_avisosVistos.size > 20000) _avisosVistos.clear() }
  const d = req.body || {}
  try {
    if (d.event === 'payment_request.payment_received') {
      const orden = d.referenceId ? await Orden.findByPk(d.referenceId) : null
      if (!orden) return console.log(`⚠️ Aviso de pago sin orden (${d.referenceId})`)
      if (d.stateType !== 'total_payment') return console.log(`ℹ️ Orden ${orden.id}: pago parcial ${d.paidAmount} de ${orden.total}`)
      if (Number(d.paidAmount) + 1 < orden.total) return console.log(`⚠️ Orden ${orden.id}: dice pagada pero pagó ${d.paidAmount} de ${orden.total}`)
      await confirmarYEmitir(orden, { pagador: d.reconciledPayerName })
    } else if (d.event === 'payment_request.expired') {
      const [n] = await Orden.update({ estado: 'abandonada' }, { where: { id: String(d.referenceId || ''), estado: 'pendiente' } })
      if (n) console.log(`⌛ Orden ${d.referenceId}: venció sin pagar`)
    } else if (d.event === 'payment.unmatched') {
      // Plata que entró a la cuenta del organizador y no se pudo asignar a una compra (pagó otra
      // persona, pagó tarde o pagó dos veces). Se registra para que la asigne a mano.
      // Con sedes, cada gala recibe solo los de su academia: si llega uno de otra sede, no es nuestro.
      if (d.tenantKey && sedeConfigurada() && d.tenantKey !== sedeConfigurada()) return console.log(`ℹ️ Pago sin imputar de otra sede (${d.tenantKey}): ignorado`)
      await SinImputar.create({ avisoId: avisoId || null, motivo: d.reason, monto: d.amount, pagador: d.payerName,
        pagadorCuil: d.payerCuil != null ? String(d.payerCuil) : null, orden_id: d.paymentRequest?.referenceId || null,
        fecha: d.operationDate ? new Date(d.operationDate) : new Date() }).catch(e => { if (!/unique/i.test(e?.name || '')) throw e })
      console.log(`⚠️ Pago SIN IMPUTAR: ${pesos(d.amount)} de ${d.payerName || 'desconocido'} (${d.reason})`)
    } else if (d.event === 'refund.succeeded') {
      const ref = d.paymentRequest?.referenceId || d.referenceId
      const [n] = ref ? await Orden.update({ estado: 'reversada' }, { where: { id: ref, estado: 'pagada' } }) : [0]
      console.log(n ? `🚫 Orden ${ref} REVERSADA (devolución)` : `ℹ️ Devolución sin orden pagada asociada (${ref})`)
    } else {
      console.log(`ℹ️ Aviso de Chytapay sin manejar: ${d.event}`)
    }
  } catch (e) {
    console.error('❌ Error procesando aviso de Chytapay:', e?.message || e)
  }
})

// Simular el pago de una orden (solo pruebas locales; en producción no existe).
app.post('/api/dev/confirmar/:orden', async (req, res) => {
  if (IS_PROD) return res.sendStatus(404)
  try {
    const orden = await Orden.findByPk(req.params.orden)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    await confirmarYEmitir(orden, { pagador: 'Pago simulado' })
    res.json({ ok: true, estado: orden.estado })
  } catch (e) {
    console.error('❌ Error confirmando:', e?.message || e)
    res.status(500).json({ error: 'No se pudo confirmar' })
  }
})

// Estado de una orden al terminar el pago. Es también la red de seguridad si el aviso no llegó.
const _ultimaConsulta = new Map()   // orden → momento de la última consulta a Chytapay (no más de una cada 4 s)
app.post('/api/orders/:id/confirmar', rateLimit({ windowMs: 60000, max: 120 }), async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    if (orden.estado !== 'pagada' && Date.now() - (_ultimaConsulta.get(orden.id) || 0) > 4000) {
      _ultimaConsulta.set(orden.id, Date.now())
      if (_ultimaConsulta.size > 20000) _ultimaConsulta.clear()
      await verificarYEmitir(orden).catch(e => console.error('❌ Verificando al terminar el pago:', e?.message || e))
    }
    const entradas = orden.estado === 'pagada' ? await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] }) : []
    res.json({
      id: orden.id, nombre: String(orden.nombre).split(' ')[0], email: orden.email,
      evento: orden.evento, tipo: orden.tipo, ...nombreDe(orden), cantidad: orden.cantidad, estado: orden.estado,
      qrs: entradas.map(e => ({ url: urlQR(e.codigo), indice: e.indice })),
    })
  } catch (e) {
    console.error('❌ Error confirmando la orden:', e?.message || e)
    res.status(500).json({ error: 'No se pudo verificar el pago' })
  }
})

// Traza de la pantalla de pago (la manda comprar.html): un paso por llamada, con la hora argentina.
// La primera línea lleva el navegador. Solo compras online de las últimas 2 horas y hasta ~6.000 letras.
app.post('/api/orders/:id/traza', rateLimit({ windowMs: 60000, max: 60 }), async (req, res) => {
  res.sendStatus(204)
  try {
    const paso = String(req.body?.paso || '').replace(/[\u0000-\u001f|]/g, ' ').trim().slice(0, 200)
    const orden = paso && await Orden.findByPk(String(req.params.id).slice(0, 60), { attributes: ['id', 'metodo', 'createdAt', 'traza'] })
    if (!orden || orden.metodo !== 'chytapay' || Date.now() - new Date(orden.createdAt).getTime() > 2 * 3600e3) return
    if ((orden.traza || '').length > 6000) return
    const linea = `${new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 19)} ${paso}`
    const ua = String(req.headers['user-agent'] || '?').replace(/[\u0000-\u001f|]/g, ' ').slice(0, 250)
    // Se arma en la base: los pasos llegan casi juntos y ninguno pisa al otro (ni se repite el navegador).
    const e = x => sequelize.escape(x)
    await Orden.update({ traza: sequelize.literal(`IF(traza IS NULL OR traza = '', ${e(`[${ua}] ${linea}`)}, CONCAT(traza, ${e(' | ' + linea)}))`) },
      { where: { id: orden.id } })
  } catch (e) { console.error('⚠️ Traza de pago:', e?.message || e) }
})

// "Mis entradas": recuperar las entradas pagadas con email + DNI.
app.post('/api/mis-entradas', rateLimit({ windowMs: 60000, max: 20, msg: 'Demasiados intentos. Esperá un minuto.' }), async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const dni = String(req.body?.dni || '').replace(/\D/g, '')
  if (!email || !dni) return res.status(400).json({ error: 'Faltan el email y el DNI' })
  try {
    const ordenes = await Orden.findAll({
      where: { estado: 'pagada', email, dni },
      include: [{ model: Entrada, as: 'qrs' }],
      order: [['createdAt', 'DESC'], [{ model: Entrada, as: 'qrs' }, 'indice', 'ASC']],
    })
    res.json({
      ordenes: ordenes.map(o => ({
        id: o.id, fecha: o.createdAt, evento: o.evento, tipo: o.tipo, ...nombreDe(o), cantidad: o.cantidad,
        qrs: o.qrs.map(q => ({ url: urlQR(q.codigo), indice: q.indice, usado: q.usado })),
      })),
    })
  } catch (e) {
    console.error('❌ Error en mis-entradas:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron buscar las entradas' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  3) PUERTA: validar un QR (firma + su evento + un solo ingreso)
//  La puerta controla UN evento (por defecto el de hoy). Si además eligió un tipo, los otros no pasan.
// ═══════════════════════════════════════════════════════════════
app.post('/api/validar', rateLimit({ windowMs: 60000, max: 1500 }), async (req, res) => {
  const p = tokenDeReq(req)
  const okAuth = (p && ['control', 'admin', 'organizador'].includes(p.rol) && await sigueActivo(p)) || (SCAN_TOKEN && req.headers['x-scan-token'] === SCAN_TOKEN)
  if (!okAuth) return res.status(401).json({ ok: false, error: 'No autorizado' })
  const { codigo } = req.body || {}
  const ev = eventoDe(req.body?.evento) || eventoActual()
  const filtro = tipoDe(ev, req.body?.tipo) ? req.body.tipo : null
  if (!codigo) return res.status(400).json({ ok: false, error: 'Falta el código' })
  if (!ev) return res.status(400).json({ ok: false, estado: 'sin_evento', msg: 'Elegí qué evento estás controlando' })

  const base = verificarQR(codigo)
  if (!base) return res.json({ ok: false, estado: 'invalido', msg: 'QR inválido o adulterado' })
  try {
    const [ordenId] = base.split('::')
    const orden = await Orden.findByPk(ordenId)
    if (orden?.estado === 'reversada') return res.json({ ok: false, estado: 'reversada', nombre: orden.nombre, msg: 'PAGO DEVUELTO: entrada anulada' })
    if (!orden || orden.estado !== 'pagada') return res.json({ ok: false, estado: 'no_pagada', msg: 'Entrada no válida o no pagada' })
    const entrada = await Entrada.findOne({ where: { base } })
    if (!entrada) return res.json({ ok: false, estado: 'invalido', msg: 'El QR no corresponde a la compra' })
    const suEv = eventoDe(entrada.evento)
    const tipo = tipoDe(suEv, entrada.tipo) || { nombre: entrada.tipo, corto: entrada.tipo }
    if (entrada.evento !== ev.id) {
      return res.json({ ok: false, estado: 'otro_evento', nombre: orden.nombre, tipo: tipo.nombre,
        msg: `Es para ${suEv ? `${suEv.nombre} (${fechaCorta(suEv)})` : 'otra fecha'}: hoy no vale` })
    }
    if (filtro && entrada.tipo !== filtro) {
      return res.json({ ok: false, estado: 'otro_tipo', nombre: orden.nombre, tipo: tipo.nombre, msg: `Es una entrada de ${tipo.corto.toUpperCase()}: acá no vale` })
    }
    // Marcado ATÓMICO: solo pasa si todavía no había entrado.
    const [afectadas] = await Entrada.update({ usado: true, usadoEn: new Date() }, { where: { id: entrada.id, usado: false } })
    const ingresadas = await Entrada.count({ where: { orden_id: orden.id, usado: true } })
    const extra = { nombre: orden.nombre, tipo: tipo.nombre, cantidad: orden.cantidad, ingresadas, prueba: orden.metodo === 'prueba' }
    if (!afectadas) {
      const ya = await Entrada.findByPk(entrada.id)
      return res.json({ ok: false, estado: 'usado', msg: 'Ya ingresó', cuando: ya?.usadoEn, ...extra })
    }
    return res.json({ ok: true, estado: 'valido', msg: orden.metodo === 'prueba' ? 'PRUEBA · Ingreso OK' : 'Ingreso OK', ...extra })
  } catch (e) {
    console.error('❌ Error validando:', e?.message || e)
    return res.status(500).json({ ok: false, error: 'Error al validar' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  4) PANEL
// ═══════════════════════════════════════════════════════════════
app.post('/api/admin/login', rateLimit({ windowMs: 60000, max: 10, msg: 'Demasiados intentos. Esperá un minuto.' }), async (req, res) => {
  try {
    const { usuario, password } = req.body || {}
    if (!usuario || !password) return res.status(400).json({ error: 'Faltan usuario y clave' })
    const u = await Usuario.findOne({ where: { usuario: String(usuario).trim().toLowerCase() } })
    if (!u || !verifyPassword(password, u.salt, u.hash)) return res.status(401).json({ error: 'Usuario o clave incorrectos' })
    if (Number(u.activo) === 0) return res.status(403).json({ error: 'Este acceso está deshabilitado' })
    res.json({ token: firmarToken({ usuario: u.usuario, rol: u.rol }), rol: u.rol, usuario: u.usuario, nombre: u.nombre })
  } catch (e) {
    console.error('❌ Error en login:', e?.message || e)
    res.status(500).json({ error: 'Error al iniciar sesión' })
  }
})

// Contador de visitas a la página (público; nunca rompe la carga)
const _visitas = new Map()
app.post('/api/visita', rateLimit({ windowMs: 60000, max: 10 }), async (req, res) => {
  const ip = ipDe(req), ahora = Date.now()
  if (_visitas.get(ip) > ahora - 6 * 3600 * 1000) return res.json({ ok: true })
  _visitas.set(ip, ahora)
  if (_visitas.size > 50000) _visitas.clear()
  try { await Visita.create({ ip }); res.json({ ok: true }) } catch { res.json({ ok: false }) }
})

const filaOrden = (o, ingresos = {}) => {
  const ev = eventoDe(o.evento)
  return {
    id: o.id, metodo: o.metodo, vendedor: o.vendedor, cobro: o.cobro, evento: o.evento, eventoNombre: ev?.nombre || o.evento,
    eventoFecha: ev?.fecha || '', tipo: o.tipo, tipoNombre: tipoDe(ev, o.tipo)?.corto || o.tipo,
    nombre: o.nombre, email: o.email, dni: o.dni, cantidad: o.cantidad,
    subtotal: o.subtotal, cargo: o.cargo, total: o.total, estado: o.estado,
    fecha: o.pagadaEn || o.createdAt, creada: o.createdAt, medioPago: o.medioPago, pagador: o.pagador,
    operacion: o.paymentId || null,   // el cobro en Chytapay: para cruzarlo con la cuenta del organizador
    ingresadas: ingresos[o.id] || 0,
  }
}
// Cómo se ve una compra en el panel: pagada, pagando ahora (dentro de la reserva), no pagó, devuelta o cortesía.
function estadoVista(o, corte = new Date(Date.now() - RESERVA_MINUTOS * 60000)) {
  if (o.estado === 'reversada') return 'devuelta'
  if (o.estado === 'pagada') return o.metodo === 'cortesia' ? 'cortesia' : 'pagada'
  return o.estado === 'pendiente' && new Date(o.createdAt) >= corte ? 'pagando' : 'sinpagar'
}
async function ingresosDe(ids) {
  const r = {}
  if (!ids.length) return r
  const filas = await Entrada.findAll({ where: { orden_id: ids, usado: true }, attributes: ['orden_id', [fn('COUNT', col('id')), 'n']], group: ['orden_id'], raw: true })
  for (const f of filas) r[f.orden_id] = Number(f.n)
  return r
}

// Resumen de UN evento (por defecto el de hoy o el próximo), más la lista de eventos para elegir
app.get('/api/admin/resumen', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const ev = eventoDe(req.query.evento) || eventoActual()
    const lista = [...EVENTOS.values()].map(e => ({ id: e.id, nombre: e.nombre, fecha: e.fecha, cuando: cuandoDe(e) }))
    if (!ev) return res.json({ eventos: lista, evento: null })
    const oc = await ocupacion(ev.id)
    const pagadas = { evento: ev.id, estado: 'pagada', metodo: { [Op.notIn]: NO_PLATA } }
    const totales = await Orden.findOne({ where: pagadas, raw: true,
      attributes: [[fn('COUNT', col('id')), 'ordenes'], [fn('SUM', col('cantidad')), 'entradas'], [fn('SUM', col('subtotal')), 'recaudado'], [fn('SUM', col('total')), 'cobrado'], [fn('SUM', col('cargo')), 'cargo']] })
    // Por día (hora argentina) y por precio por entrada (= etapa): para cruzar con la cuenta de Chytapay.
    const nombrePrecio = {}
    for (const t of ev.tipos) {
      nombrePrecio[finalDe(t.precio)] ??= t.etapas?.length ? 'Después de las etapas' : t.nombre
      for (const e of t.etapas || []) nombrePrecio[finalDe(e.precio)] = e.nombre || `Hasta el ${e.hasta.slice(8, 10)}/${e.hasta.slice(5, 7)}`
    }
    const porDia = {}, porPrecio = {}
    for (const o of await Orden.findAll({ where: pagadas, raw: true, attributes: ['pagadaEn', 'createdAt', 'cantidad', 'subtotal', 'total'] })) {
      const dia = hoyAR(new Date(o.pagadaEn || o.createdAt)), unidad = Math.round(o.total / o.cantidad)
      const d = porDia[dia] ??= { dia, compras: 0, entradas: 0, cobrado: 0, paraOrganizador: 0 }
      d.compras++; d.entradas += o.cantidad; d.cobrado += o.total; d.paraOrganizador += o.subtotal
      const p = porPrecio[unidad] ??= { precio: unidad, nombre: nombrePrecio[unidad] || null, entradas: 0, cobrado: 0, paraOrganizador: 0 }
      p.entradas += o.cantidad; p.cobrado += o.total; p.paraOrganizador += o.subtotal
    }
    const intentos = await Orden.count({ where: { evento: ev.id, metodo: 'chytapay', estado: { [Op.in]: ['pendiente', 'abandonada'] },
      createdAt: { [Op.lt]: new Date(Date.now() - RESERVA_MINUTOS * 60000) } } })
    const online = await Orden.findOne({ where: { ...pagadas, metodo: 'chytapay' }, raw: true,
      attributes: [[fn('COUNT', col('id')), 'operaciones'], [fn('SUM', col('cantidad')), 'entradas'], [fn('SUM', col('total')), 'importe']] })
    const porPuntoFilas = await Orden.findAll({ where: { ...pagadas, metodo: 'punto' }, raw: true, group: ['vendedor'],
      attributes: ['vendedor', [fn('COUNT', col('id')), 'operaciones'], [fn('SUM', col('cantidad')), 'entradas'], [fn('SUM', col('subtotal')), 'subtotal'], [fn('SUM', col('cargo')), 'cargo'], [fn('SUM', col('total')), 'total']] })
    const cortesias = await Orden.sum('cantidad', { where: { evento: ev.id, estado: 'pagada', metodo: 'cortesia' } }) || 0
    const pendientes = await Orden.count({ where: { evento: ev.id, estado: 'pendiente', metodo: 'chytapay', createdAt: { [Op.gte]: new Date(Date.now() - RESERVA_MINUTOS * 60000) } } })
    const ingresosPorTipo = Object.fromEntries((await Entrada.findAll({ where: { evento: ev.id, usado: true }, attributes: ['tipo', [fn('COUNT', col('id')), 'n']], group: ['tipo'], raw: true })).map(f => [f.tipo, Number(f.n)]))
    const sinImputar = await SinImputar.count({ where: { resuelto: false } })
    const inicioHoy = comienzoDelDiaArgentino()
    const ultimas = await Orden.findAll({ where: { evento: ev.id, estado: { [Op.in]: ['pagada', 'reversada'] }, metodo: { [Op.notIn]: NO_VENTA } }, order: [['updatedAt', 'DESC']], limit: 200 })
    const ing = await ingresosDe(ultimas.map(o => o.id))
    res.json({
      eventos: lista,
      evento: { id: ev.id, nombre: ev.nombre, cuando: cuandoDe(ev), publicado: Boolean(Number(ev.publicado)), ventaAbierta: vendibleOnline(ev) },
      tipos: Object.fromEntries(Object.entries(oc).map(([k, t]) => [k, { ...t, nombre: tipoDe(ev, k)?.nombre || k, ingresaron: ingresosPorTipo[k] || 0, sinTope: t.cupo >= SIN_TOPE }])),
      cortesias, pendientes, sinImputar, intentos,
      ordenes: Number(totales?.ordenes || 0), entradas: Number(totales?.entradas || 0),
      recaudado: Number(totales?.recaudado || 0), cobrado: Number(totales?.cobrado || 0), cargo: Number(totales?.cargo || 0),
      porDia: Object.values(porDia).sort((a, b) => b.dia.localeCompare(a.dia)),
      porPrecio: Object.values(porPrecio).sort((a, b) => a.precio - b.precio),
      online: { operaciones: Number(online?.operaciones || 0), entradas: Number(online?.entradas || 0), importe: Number(online?.importe || 0) },
      porPunto: porPuntoFilas.map(f => ({ vendedor: f.vendedor, operaciones: Number(f.operaciones), entradas: Number(f.entradas), subtotal: Number(f.subtotal), cargo: Number(f.cargo), total: Number(f.total) })),
      visitas: { total: await Visita.count(), hoy: await Visita.count({ where: { createdAt: { [Op.gte]: inicioHoy } } }) },
      ventaGeneral: VENTA_ABIERTA, sandbox: !chytapayEsProduccion(),
      ultimas: ultimas.map(o => filaOrden(o, ing)),
    })
  } catch (e) {
    console.error('❌ Error en resumen:', e?.message || e)
    res.status(500).json({ error: 'Error al armar el resumen' })
  }
})

// Operaciones de UN evento, para controlar la venta: todas las compras con su estado (pagada, pagando
// ahora, no pagó, devuelta, cortesía) y cuántas hay de cada una.
app.get('/api/admin/operaciones', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const ev = eventoDe(req.query.evento) || eventoActual()
    if (!ev) return res.json({ ordenes: [], cuentas: {} })
    const filtro = String(req.query.estado || 'pagada')
    const todas = await Orden.findAll({ where: { evento: ev.id, metodo: { [Op.notIn]: NO_VENTA } }, order: [['createdAt', 'DESC']], limit: 3000 })
    const corte = new Date(Date.now() - RESERVA_MINUTOS * 60000)
    const cuentas = { pagada: 0, pagando: 0, sinpagar: 0, devuelta: 0, cortesia: 0 }
    const elegidas = []
    for (const o of todas) {
      const e = estadoVista(o, corte)
      cuentas[e]++
      if (filtro === 'todas' || filtro === e) elegidas.push({ o, e })
    }
    const ing = await ingresosDe(elegidas.filter(x => x.o.estado === 'pagada').map(x => x.o.id))
    res.json({ evento: ev.id, filtro, cuentas, ordenes: elegidas.map(({ o, e }) => ({ ...filaOrden(o, ing), estadoVista: e })) })
  } catch (e) {
    console.error('❌ Error listando operaciones:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron traer las operaciones' })
  }
})

// Buscar compradores (todo el staff, en todos los eventos): por DNI, email, nombre o número de compra
app.get('/api/admin/buscar', requireAuth(['admin', 'control', 'venta', 'organizador']), async (req, res) => {
  try {
    const q = String(req.query.q || '').trim()
    if (q.length < 3) return res.json({ ordenes: [] })
    const like = { [Op.like]: `%${q}%` }
    const donde = /^\d{6,9}$/.test(q) ? { dni: q } : { [Op.or]: [{ email: like }, { nombre: like }, { id: like }] }
    const ordenes = await Orden.findAll({ where: { ...donde, estado: { [Op.in]: ['pagada', 'reversada'] }, metodo: { [Op.notIn]: NO_VENTA } }, order: [['createdAt', 'DESC']], limit: 40 })
    const ing = await ingresosDe(ordenes.map(o => o.id))
    res.json({ ordenes: ordenes.map(o => filaOrden(o, ing)) })
  } catch (e) {
    console.error('❌ Error buscando:', e?.message || e)
    res.status(500).json({ error: 'No se pudo buscar' })
  }
})

// Planilla con las ventas (de un evento o de todos)
app.get('/api/admin/exportar', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const ev = eventoDe(req.query.evento)
    const ordenes = await Orden.findAll({ where: { estado: 'pagada', metodo: { [Op.notIn]: NO_VENTA }, ...(ev ? { evento: ev.id } : {}) }, order: [['pagadaEn', 'ASC']] })
    const ing = await ingresosDe(ordenes.map(o => o.id))
    const cols = ['id', 'fecha', 'eventoFecha', 'eventoNombre', 'tipoNombre', 'cantidad', 'nombre', 'email', 'dni', 'metodo', 'vendedor', 'cobro', 'pagador', 'operacion', 'subtotal', 'cargo', 'total', 'ingresadas']
    const celda = v => `"${String(v ?? '').replace(/"/g, '""')}"`
    const filas = ordenes.map(o => { const f = filaOrden(o, ing); f.fecha = new Date(f.fecha).toISOString(); return cols.map(c => celda(f[c])).join(';') })
    res.set('Content-Type', 'text/csv; charset=utf-8')
    res.set('Content-Disposition', `attachment; filename="ventas${ev ? '-' + ev.id : ''}.csv"`)
    res.send('﻿' + [cols.join(';'), ...filas].join('\n'))
  } catch (e) {
    console.error('❌ Error exportando:', e?.message || e)
    res.status(500).json({ error: 'No se pudo exportar' })
  }
})

// ── Cartelera: el organizador y el admin cargan y editan los eventos ──
async function vendidasPorEvento() {
  const filas = await Orden.findAll({ where: { estado: 'pagada', metodo: { [Op.notIn]: NO_VENTA } }, raw: true, group: ['evento', 'tipo'],
    attributes: ['evento', 'tipo', [fn('SUM', col('cantidad')), 'cant'], [fn('SUM', col('subtotal')), 'recaudado']] })
  const r = {}
  for (const f of filas) { const e = r[f.evento] || (r[f.evento] = { entradas: 0, recaudado: 0, porTipo: {} }); e.entradas += Number(f.cant); e.recaudado += Number(f.recaudado || 0); e.porTipo[f.tipo] = Number(f.cant) }
  return r
}
app.get('/api/admin/eventos', requireAuth(ORGANIZACION), async (_req, res) => {
  try {
    const v = await vendidasPorEvento()
    res.json({ eventos: [...EVENTOS.values()].map(e => ({ ...e, cuando: cuandoDe(e), pasado: !noPaso(e), vendible: vendibleOnline(e),
      vendidas: v[e.id]?.entradas || 0, recaudado: v[e.id]?.recaudado || 0, porTipo: v[e.id]?.porTipo || {} })) })
  } catch (e) {
    console.error('❌ Error listando eventos:', e?.message || e)
    res.status(500).json({ error: 'No se pudo armar la cartelera' })
  }
})
app.post('/api/admin/eventos', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const r = normalizarEvento(req.body || {})
    if (r.error) return res.status(400).json({ error: r.error })
    let id = r.evento.id, n = 2
    while (EVENTOS.has(id) || await Evento.findByPk(id)) id = `${r.evento.id.slice(0, 56)}-${n++}`
    await Evento.create({ ...r.evento, id })
    await cargarEventos()
    console.log(`🗓️ Evento creado: ${id} (por ${req.usuario.usuario})`)
    res.json({ ok: true, id })
  } catch (e) {
    console.error('❌ Error creando evento:', e?.message || e)
    res.status(500).json({ error: 'No se pudo crear el evento' })
  }
})
app.put('/api/admin/eventos/:id', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const actual = eventoDe(req.params.id)
    if (!actual) return res.status(404).json({ error: 'Evento no encontrado' })
    // El panel no edita las etapas de precio: si un tipo no las manda, conserva las que ya tenía.
    const cuerpo = { ...(req.body || {}) }
    if (Array.isArray(cuerpo.tipos)) cuerpo.tipos = cuerpo.tipos.map(t => (t && t.etapas === undefined && tipoDe(actual, t.id)?.etapas) ? { ...t, etapas: tipoDe(actual, t.id).etapas } : t)
    const r = normalizarEvento({ ...actual, ...cuerpo }, { idFijo: actual.id })
    if (r.error) return res.status(400).json({ error: r.error })
    // No se puede sacar un tipo que ya vendió ni bajar el cupo por debajo de lo vendido y reservado.
    const oc = await ocupacion(actual.id)
    for (const [tipo, t] of Object.entries(oc)) {
      const nuevo = r.evento.tipos.find(x => x.id === tipo)
      const usadas = t.vendidas + t.reservadas
      if (!nuevo && usadas > 0) return res.status(400).json({ error: `"${tipoDe(actual, tipo)?.nombre}" ya tiene ${usadas} entradas: no se puede sacar` })
      if (nuevo && nuevo.cupo < usadas) return res.status(400).json({ error: `"${nuevo.nombre}": la capacidad no puede ser menor que las ${usadas} ya vendidas o reservadas` })
    }
    // Por la instancia (no Evento.update) para que artistas y tipos pasen por el setter que los guarda como JSON.
    const fila = await Evento.findByPk(actual.id)
    fila.set(r.evento)
    await fila.save()
    await cargarEventos()
    console.log(`🗓️ Evento editado: ${actual.id} (por ${req.usuario.usuario})`)
    res.json({ ok: true, id: actual.id })
  } catch (e) {
    console.error('❌ Error editando evento:', e?.message || e)
    res.status(500).json({ error: 'No se pudo guardar el evento' })
  }
})
app.delete('/api/admin/eventos/:id', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const ev = eventoDe(req.params.id)
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' })
    if (await Orden.count({ where: { evento: ev.id } })) return res.status(400).json({ error: 'Ese evento ya tiene compras: no se puede borrar. Despublicalo.' })
    await Evento.destroy({ where: { id: ev.id } })
    await cargarEventos()
    res.json({ ok: true })
  } catch (e) {
    console.error('❌ Error borrando evento:', e?.message || e)
    res.status(500).json({ error: 'No se pudo borrar' })
  }
})
// La foto llega achicada por el panel, en base64. Se aceptan JPG, PNG y WEBP de hasta 2,5 MB.
app.post('/api/admin/eventos/:id/imagen', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const ev = eventoDe(req.params.id)
    if (!ev) return res.status(404).json({ error: 'Evento no encontrado' })
    const tipo = String(req.body?.tipo || '')
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(tipo)) return res.status(400).json({ error: 'La foto tiene que ser JPG, PNG o WEBP' })
    const datos = Buffer.from(String(req.body?.datos || ''), 'base64')
    const firma = datos.subarray(0, 12).toString('hex')
    const esImagen = firma.startsWith('ffd8ff') || firma.startsWith('89504e47') || (firma.startsWith('52494646') && datos.subarray(8, 12).toString() === 'WEBP')
    if (!esImagen) return res.status(400).json({ error: 'El archivo no es una imagen válida' })
    if (datos.length > 2.5 * 1024 * 1024) return res.status(400).json({ error: 'La foto es muy pesada (máximo 2,5 MB)' })
    const im = await Imagen.create({ tipo, datos })
    await Evento.update({ imagen: `/img/${im.id}` }, { where: { id: ev.id } })
    await cargarEventos()
    res.json({ ok: true, imagen: `/img/${im.id}` })
  } catch (e) {
    console.error('❌ Error subiendo la foto:', e?.message || e)
    res.status(500).json({ error: 'No se pudo subir la foto' })
  }
})

// Transferencias sin asignar a una compra (el organizador las asigna desde su cuenta de Chytapay)
app.get('/api/admin/sin-imputar', requireAuth(ORGANIZACION), async (_req, res) => {
  try {
    const filas = await SinImputar.findAll({ order: [['createdAt', 'DESC']], limit: 100, raw: true })
    res.json({ pagos: filas.map(f => ({ id: f.id, motivo: f.motivo, monto: Number(f.monto), pagador: f.pagador, orden: f.orden_id, fecha: f.fecha, resuelto: Boolean(Number(f.resuelto)) })) })
  } catch (e) {
    console.error('❌ Error en sin-imputar:', e?.message || e)
    res.status(500).json({ error: 'No se pudo armar la lista' })
  }
})
app.post('/api/admin/sin-imputar/:id/resuelto', requireAuth(['admin']), async (req, res) => {
  const [n] = await SinImputar.update({ resuelto: true }, { where: { id: Number(req.params.id) || 0 } }).catch(() => [0])
  res.json({ ok: Boolean(n) })
})

// Entrada de PRUEBA: QR real para probar los escáneres; no cuenta en ventas ni ocupa lugar.
app.post('/api/admin/entrada-prueba', requireAuth(['admin']), async (req, res) => {
  try {
    const ev = eventoDe(req.body?.evento) || eventoActual()
    if (!ev || !ev.tipos.length) return res.status(400).json({ error: 'Elegí un evento con tipos de entrada' })
    const tipo = tipoDe(ev, req.body?.tipo)?.id || ev.tipos[0].id
    const cantidad = Math.min(Math.max(parseInt(req.body?.cantidad, 10) || 1, 1), 5)
    const orden = await Orden.create({ id: 'orden_' + randomUUID(), evento: ev.id, tipo, nombre: 'ENTRADA DE PRUEBA', email: 'prueba@evento.local', dni: '0',
      metodo: 'prueba', cantidad, subtotal: 0, cargo: 0, total: 0, estado: 'pagada', pagadaEn: new Date() })
    const { entradas } = await emitirEntradas(orden, { mandarMail: false })
    res.json({ ok: true, ordenId: orden.id, evento: ev.id, tipo, qrs: entradas.map(e => ({ indice: e.indice, url: urlQR(e.codigo) })) })
  } catch (e) {
    console.error('❌ Error en entrada de prueba:', e?.message || e)
    res.status(500).json({ error: 'No se pudo generar la prueba' })
  }
})

// CORTESÍA (admin y organizador: es su evento): QR real que se manda por mail. Ocupa lugar pero no es venta.
app.post('/api/admin/entrada-cortesia', requireAuth(ORGANIZACION), async (req, res) => {
  try {
    const nombre = String(req.body?.nombre || '').trim() || 'Invitación'
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (!/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/.test(email)) return res.status(400).json({ error: 'Falta el email de la persona invitada' })
    const ev = eventoDe(req.body?.evento)
    if (!ev || !noPaso(ev)) return res.status(400).json({ error: 'Elegí un evento que no haya pasado' })
    const tipo = tipoDe(ev, req.body?.tipo)?.id
    if (!tipo) return res.status(400).json({ error: 'Elegí el tipo de entrada' })
    const cantidad = Math.min(Math.max(parseInt(req.body?.cantidad, 10) || 1, 1), 20)
    const r = await crearOrdenConCupo({ id: 'orden_' + randomUUID(), evento: ev.id, tipo, nombre, email, dni: String(req.body?.dni || '').replace(/\D/g, '') || null,
      metodo: 'cortesia', vendedor: req.usuario.usuario, cantidad, subtotal: 0, cargo: 0, total: 0, estado: 'pagada', pagadaEn: new Date() })
    if (r.error) return res.status(r.status).json({ error: r.error })
    await emitirEntradas(r.orden)
    console.log(`🎫 Cortesía: ${cantidad} ${ev.id}/${tipo} → ${email} (por ${req.usuario.usuario})`)
    res.json({ ok: true, ordenId: r.orden.id, cantidad, email })
  } catch (e) {
    console.error('❌ Error emitiendo cortesía:', e?.message || e)
    res.status(500).json({ error: 'No se pudo emitir la cortesía' })
  }
})

// VENTA EN UN PUNTO FÍSICO (vendedor o admin): el público paga en efectivo o por
// transferencia al vendedor, el QR sale en pantalla y se manda al mail.
app.post('/api/admin/venta-punto', requireAuth(['venta', 'admin']), async (req, res) => {
  try {
    const v = validarCompra(req.body || {}, { maximo: 20, online: false })
    if (v.error) return res.status(400).json({ error: v.error })
    const cobro = req.body?.cobro === 'transferencia' ? 'transferencia' : 'efectivo'
    const { subtotal, cargo, total } = importes(v.precio, v.cantidad, CARGO_PUNTO_PCT)
    const { precio, ...datos } = v
    const r = await crearOrdenConCupo({ id: 'orden_' + randomUUID(), ...datos, metodo: 'punto', vendedor: req.usuario.usuario, cobro,
      subtotal, cargo, total, estado: 'pagada', pagadaEn: new Date() })
    if (r.error) return res.status(r.status).json({ error: r.error })
    const { entradas } = await emitirEntradas(r.orden)
    console.log(`💵 Venta en punto (${req.usuario.usuario}, ${cobro}): ${v.cantidad} ${v.evento}/${v.tipo} → ${v.email} · ${pesos(total)}`)
    res.json({ ok: true, ordenId: r.orden.id, total, qrs: entradas.map(e => ({ indice: e.indice, url: urlQR(e.codigo) })) })
  } catch (e) {
    console.error('❌ Error en venta en punto:', e?.message || e)
    res.status(500).json({ error: 'No se pudo registrar la venta' })
  }
})

// Liquidación del vendedor: lo que cobró y lo que tiene que rendir.
app.get('/api/admin/mis-ventas', requireAuth(['venta', 'admin']), async (req, res) => {
  try {
    const ordenes = await Orden.findAll({ where: { estado: 'pagada', metodo: 'punto', vendedor: req.usuario.usuario }, order: [['createdAt', 'DESC']] })
    const suma = k => ordenes.reduce((s, o) => s + Number(o[k]), 0)
    res.json({
      totales: { ventas: ordenes.length, entradas: suma('cantidad'), cobrado: suma('total'), paraOrganizador: suma('subtotal'), costoServicio: suma('cargo'),
        efectivo: ordenes.filter(o => o.cobro === 'efectivo').reduce((s, o) => s + o.total, 0),
        transferencia: ordenes.filter(o => o.cobro === 'transferencia').reduce((s, o) => s + o.total, 0) },
      ordenes: ordenes.map(o => filaOrden(o)),
    })
  } catch (e) {
    console.error('❌ Error en mis-ventas:', e?.message || e)
    res.status(500).json({ error: 'No se pudo armar la liquidación' })
  }
})

// QR de una orden en pantalla (staff)
app.get('/api/admin/orden/:id/qrs', requireAuth(['admin', 'control', 'venta', 'organizador']), async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' })
    if (req.usuario.rol === 'venta' && orden.vendedor !== req.usuario.usuario) return res.status(403).json({ error: 'Sin permiso' })
    const entradas = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
    res.json({ ok: true, nombre: orden.nombre, email: orden.email, dni: orden.dni, evento: orden.evento, ...nombreDe(orden), cantidad: orden.cantidad,
      qrs: entradas.map(e => ({ indice: e.indice, url: urlQR(e.codigo), usado: e.usado })) })
  } catch (e) {
    console.error('❌ Error trayendo los QR:', e?.message || e)
    res.status(500).json({ error: 'No se pudieron traer los QR' })
  }
})

// Reenviar las entradas a otro email (para quien escribió mal el suyo)
app.post('/api/admin/orden/:id/reenviar', requireAuth(['admin', 'venta', 'organizador']), async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase()
    if (email.length > 120 || !/^[^\s@<>"'`]+@[^\s@<>"'`]+\.[^\s@<>"'`]{2,}$/.test(email)) return res.status(400).json({ error: 'Email inválido' })
    const orden = await Orden.findByPk(req.params.id)
    if (!orden || orden.estado !== 'pagada') return res.status(404).json({ error: 'Orden no encontrada o sin pagar' })
    if (req.usuario.rol === 'venta' && orden.vendedor !== req.usuario.usuario) return res.status(403).json({ error: 'Solo podés reenviar tus propias ventas' })
    const entradas = await Entrada.findAll({ where: { orden_id: orden.id }, order: [['indice', 'ASC']] })
    if (!entradas.length) return res.status(404).json({ error: 'La orden no tiene entradas emitidas' })
    await orden.update({ email })
    await enviarMailEntradas(orden, entradas)
    console.log(`📧 Reenvío: orden ${orden.id} → ${email} (por ${req.usuario.usuario})`)
    res.json({ ok: true, email, cantidad: entradas.length })
  } catch (e) {
    console.error('❌ Error reenviando:', e?.message || e)
    res.status(500).json({ error: 'No se pudo reenviar' })
  }
})

// Marcar el ingreso de toda una orden sin escanear (por ejemplo si el celular no prende)
app.post('/api/admin/orden/:id/ingresar', requireAuth(['admin', 'control', 'organizador']), async (req, res) => {
  try {
    const orden = await Orden.findByPk(req.params.id)
    if (!orden || orden.estado !== 'pagada') return res.status(400).json({ error: 'La orden no está pagada' })
    const ev = eventoDe(req.body?.evento) || eventoActual()
    if (ev && orden.evento !== ev.id) return res.status(400).json({ error: `Son entradas para ${eventoDe(orden.evento)?.nombre || 'otra fecha'}: hoy no valen` })
    const [marcadas] = await Entrada.update({ usado: true, usadoEn: new Date() }, { where: { orden_id: orden.id, usado: false } })
    console.log(`🚪 Ingreso manual ${orden.id}: ${marcadas} (por ${req.usuario.usuario})`)
    res.json({ ok: true, marcadas, total: orden.cantidad, nombre: orden.nombre })
  } catch (e) {
    console.error('❌ Error en ingreso manual:', e?.message || e)
    res.status(500).json({ error: 'No se pudo marcar el ingreso' })
  }
})

// Repesca a pedido ("pagué y no me llegó")
app.post('/api/admin/repescar', requireAuth(['admin']), async (_req, res) => {
  try {
    const antes = await Orden.count({ where: { estado: { [Op.in]: ['pendiente', 'abandonada'] }, metodo: 'chytapay' } })
    const emitidas = await repescarPagos()
    res.json({ ok: true, revisadas: antes, emitidas })
  } catch (e) {
    console.error('❌ Error en la repesca manual:', e?.message || e)
    res.status(500).json({ error: 'No se pudo revisar' })
  }
})

// ── Conectar la cuenta de Chytapay del organizador (solo admin) ──
// El admin genera el enlace y se lo manda al organizador por WhatsApp; lo abre cuando puede, entra con su
// usuario de Chytapay, ve la comisión y autoriza. Chytapay lo manda de vuelta a /chytapay/vuelta.
// El enlace dura HORAS_ENLACE y sigue sirviendo aunque el servidor se reinicie (un deploy): el "state" va
// firmado, no guardado en memoria. El "code" de Chytapay sirve una sola vez: repetir la vuelta no conecta dos veces.
const HORAS_ENLACE = 72
const firmaState = cuerpo => createHmac('sha256', QR_SECRET).update('chytapay-state:' + cuerpo).digest('base64url').slice(0, 32)
function nuevoState() {
  const cuerpo = Buffer.from(JSON.stringify({ exp: Date.now() + HORAS_ENLACE * 3600000, n: randomBytes(9).toString('base64url') })).toString('base64url')
  return `${cuerpo}.${firmaState(cuerpo)}`
}
function stateVigente(state) {
  const [cuerpo, firma] = String(state || '').split('.')
  if (!cuerpo || !firma) return false
  const a = Buffer.from(firma), b = Buffer.from(firmaState(cuerpo))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false
  try { return JSON.parse(Buffer.from(cuerpo, 'base64url').toString()).exp > Date.now() } catch { return false }
}
app.get('/api/admin/chytapay', requireAuth(['admin']), async (_req, res) => {
  try {
    const v = await vinculoActual()
    res.json({ configurado: chytapayConfigurado(), produccion: chytapayEsProduccion(), sede: sedeConfigurada() || null,
      vinculo: v ? { nombre: v.nombre, fantasia: v.fantasia, cuit: v.cuit, email: v.email, conectadoEn: v.conectadoEn } : null })
  } catch (e) {
    res.status(500).json({ error: 'No se pudo consultar la conexión' })
  }
})
app.post('/api/admin/chytapay/conectar', requireAuth(['admin']), (_req, res) => {
  if (!process.env.CHYTAPAY_CLIENT_ID || !process.env.CHYTAPAY_CLIENT_SECRET) return res.status(400).json({ error: 'Faltan CHYTAPAY_CLIENT_ID y CHYTAPAY_CLIENT_SECRET en el servidor' })
  res.json({ url: urlAutorizar(nuevoState()), horas: HORAS_ENLACE })
})
app.get('/chytapay/vuelta', rateLimit({ windowMs: 60000, max: 20 }), async (req, res) => {
  const state = String(req.query.state || ''), code = String(req.query.code || '')
  if (!stateVigente(state)) return res.redirect('/admin?chytapay=vencido')
  if (!code) return res.redirect('/admin?chytapay=cancelado')
  try {
    const tokens = await canjearCode(code)
    const v = await guardarVinculo(tokens)
    console.log(`🔗 Chytapay conectado: ${v.nombre} (${v.cuit})`)
    // La cuenta queda conectada aunque falle la sede: se reintenta desde Herramientas.
    let sede = ''
    if (sedeConfigurada()) {
      try { await asignarSede(tokens.idToken); sede = '&sede=ok'; console.log(`🏠 Cuenta asignada a la sede "${sedeConfigurada()}"`) }
      catch (e) { sede = '&sede=error'; console.error('❌ Sede de Chytapay:', e?.message || e) }
    }
    res.redirect('/admin?chytapay=ok' + sede)
  } catch (e) {
    console.error('❌ Error conectando Chytapay:', e?.message || e)
    res.redirect('/admin?chytapay=error')
  }
})
// Reasignar la cuenta conectada a la sede de esta gala (si la sede se creó después de conectar).
app.post('/api/admin/chytapay/sede', requireAuth(['admin']), async (_req, res) => {
  try {
    if (!sedeConfigurada()) return res.status(400).json({ error: 'Falta CHYTAPAY_SEDE en el servidor (la key de la sede de esta gala)' })
    if (!(await vinculoActual())) return res.status(400).json({ error: 'Primero conectá la cuenta de Chytapay de la academia' })
    await asignarSede()
    res.json({ ok: true, sede: sedeConfigurada() })
  } catch (e) {
    console.error('❌ Sede de Chytapay:', e?.message || e)
    res.status(500).json({ error: e?.message || 'No se pudo asignar la sede' })
  }
})

// ═══════════════════════════════════════════════════════════════
//  5) CONFIG PÚBLICA para la página y la compra
//  Los precios salen de acá y NO se escriben a mano en el HTML: si no, la página
//  muestra un total y el cobro es por otro. El cupo NUNCA se manda: solo "pocas" o "agotado".
// ═══════════════════════════════════════════════════════════════
let _ocCache = { t: 0, v: null }   // la página la pide en cada visita: 20 s de caché alcanzan
async function estadosDeTipos() {
  if (_ocCache.v && Date.now() - _ocCache.t < 20000) return _ocCache.v
  const v = {}
  for (const ev of EVENTOS.values()) {
    if (!Number(ev.publicado) || !noPaso(ev)) continue
    const oc = await ocupacion(ev.id)
    v[ev.id] = Object.fromEntries(Object.entries(oc).map(([k, t]) => [k, t.libres <= 0 ? 'agotado' : t.libres <= POCAS ? 'pocas' : 'disponible']))
  }
  _ocCache = { t: Date.now(), v }
  return v
}
app.get('/api/config', async (_req, res) => {
  let estados = {}
  try { estados = await estadosDeTipos() } catch { /* sin base, se muestra disponible: la compra igual controla el cupo */ }
  res.set('Cache-Control', 'no-cache')
  const online = VENTA_ABIERTA && chytapayConfigurado()
  res.json({
    ventaAbierta: online, maxEntradas: MAX_ENTRADAS, cargoPct: CARGO_PCT, cargoPuntoPct: CARGO_PUNTO_PCT, reservaMinutos: RESERVA_MINUTOS,
    sitio: SITIO,
    eventos: [...EVENTOS.values()].filter(e => Number(e.publicado) && noPaso(e)).map(e => ({
      id: e.id, nombre: e.nombre, subtitulo: e.subtitulo, fecha: e.fecha, hora: e.hora, cuando: cuandoDe(e), puertas: e.puertas,
      artistas: e.artistas, descripcion: e.descripcion, imagen: e.imagen, nota: e.nota, vendible: online && vendibleOnline(e),
      ventaHasta: e.ventaHasta || null,
      externo: e.externoUrl || e.externoPrecio || e.externoTexto ? { url: e.externoUrl, texto: e.externoTexto, precio: e.externoPrecio } : null,
      // final = lo que paga hoy el público. etapas = el calendario de precios (finales), para mostrarlo;
      // finalDespues = el precio cuando terminan las etapas (por ejemplo, en puerta).
      tipos: Object.fromEntries(e.tipos.map(t => [t.id, { nombre: t.nombre, corto: t.corto, detalle: t.detalle, precio: precioVigente(t),
        final: finalDe(precioVigente(t)), estado: estados[e.id]?.[t.id] || 'disponible', ...etapasPublicas(t) }])),
    })),
    sandbox: !chytapayEsProduccion(),
  })
})
// Para el panel: todos los eventos (también los no publicados) con sus tipos, para la puerta,
// la boletería y las cortesías.
app.get('/api/admin/config', requireAuth(['admin', 'control', 'venta', 'organizador']), (_req, res) => {
  res.json({ cargoPuntoPct: CARGO_PUNTO_PCT, actual: eventoActual()?.id || null, sandbox: !chytapayEsProduccion(), precioIncluyeCargo: SITIO.precioIncluyeCargo, modo: SITIO.modo,
    // unidadPunto: lo que cobra la boletería por entrada hoy (mismo cálculo que el servidor).
    eventos: [...EVENTOS.values()].map(e => ({ id: e.id, nombre: e.nombre, fecha: e.fecha, cuando: cuandoDe(e), pasado: !noPaso(e),
      tipos: e.tipos.map(t => ({ ...t, unidadPunto: finalDe(precioVigente(t), CARGO_PUNTO_PCT) })) })) })
})

// Direcciones cortas (se dictan por teléfono sin decir "punto html")
for (const p of ['comprar', 'admin', 'mis-entradas', 'pago-exitoso', 'pago-pendiente', 'pago-fallido']) {
  app.get('/' + p, (_req, res) => res.sendFile(join(FRONT, p + '.html')))
}
app.get('/panel', (_req, res) => res.redirect('/admin'))
app.get('/puerta', (_req, res) => res.redirect('/admin'))
app.get('/entradas', (_req, res) => res.redirect('/mis-entradas'))
app.get('/health', (_req, res) => res.send(`Backend ${SITIO.nombre} ✅`))

// Levantar el server YA, sin esperar la base (Render necesita que responda rápido)
app.listen(PORT, () => {
  console.log(`🚀 ${SITIO.nombre} (tema ${TEMA}): puerto ${PORT}`)
  if (!chytapayConfigurado()) console.warn('⚠️ Faltan datos de Chytapay (CHYTAPAY_*): la venta online queda cerrada')
  console.log(`💳 Chytapay [${chytapayEsProduccion() ? 'PRODUCCIÓN' : 'sandbox'}] · cargo ${CARGO_PCT}% online, ${CARGO_PUNTO_PCT}% en puntos · reserva ${RESERVA_MINUTOS} min · venta ${VENTA_ABIERTA ? 'ABIERTA' : 'cerrada'}`)
})

// ═══════════════════════════════════════════════════════════════
//  REPESCA DE PAGOS: pregunta a Chytapay por las órdenes pendientes
//  (el comprador cerró la pestaña o el aviso no llegó). Una compra vencida que el organizador
//  después imputa a mano también se emite.
// ═══════════════════════════════════════════════════════════════
const REPESCA_MINUTOS = numEnv('REPESCA_MINUTOS', 2)
const REPESCA_HORAS = numEnv('REPESCA_HORAS', 24)
const REPESCA_MAX = numEnv('REPESCA_MAX', 30)
let repescaCorriendo = false
async function repescarPagos() {
  if (repescaCorriendo || !chytapayConfigurado()) return 0
  repescaCorriendo = true
  let emitidas = 0
  try {
    const pendientes = await Orden.findAll({
      where: { estado: { [Op.in]: ['pendiente', 'abandonada'] }, metodo: 'chytapay', createdAt: { [Op.gte]: new Date(Date.now() - REPESCA_HORAS * 3600 * 1000) } },
      order: [['updatedAt', 'ASC']], limit: REPESCA_MAX,
    })
    for (const orden of pendientes) {
      try { if (await verificarYEmitir(orden)) emitidas++ } catch (e) { console.error(`⚠️ Repesca ${orden.id}:`, e?.message || e) }
      // Se toca updatedAt para que la próxima pasada empiece por otras (rota entre todas las pendientes).
      if (orden.estado !== 'pagada') await Orden.update({ avisadoEn: orden.avisadoEn }, { where: { id: orden.id } }).catch(() => {})
    }
    if (emitidas) console.log(`✅ Repesca: ${emitidas} de ${pendientes.length} pendientes se emitieron.`)
  } catch (e) {
    console.error('⚠️ Error en la repesca:', e?.message || e)
  } finally {
    repescaCorriendo = false
  }
  return emitidas
}

// ═══════════════════════════════════════════════════════════════
//  RECUPERO DE COMPRAS A MEDIO CAMINO: un mail, una sola vez, ofreciendo ayuda.
// ═══════════════════════════════════════════════════════════════
const RECUPERO_MINUTOS = numEnv('RECUPERO_MINUTOS', 45)
const RECUPERO_HORAS = numEnv('RECUPERO_HORAS', 48)
let recuperoCorriendo = false
async function recuperarPendientes() {
  if (recuperoCorriendo) return
  recuperoCorriendo = true
  try {
    const ahora = Date.now()
    const candidatas = await Orden.findAll({
      where: { estado: { [Op.in]: ['pendiente', 'abandonada'] }, avisadoEn: null, metodo: 'chytapay',
        createdAt: { [Op.lte]: new Date(ahora - RECUPERO_MINUTOS * 60000), [Op.gte]: new Date(ahora - RECUPERO_HORAS * 3600000) } },
      order: [['createdAt', 'ASC']], limit: 20,
    })
    const yaEscritos = new Set()
    for (const orden of candidatas) {
      const mail = String(orden.email || '').toLowerCase()
      const compro = await Orden.count({ where: { email: orden.email, evento: orden.evento, estado: 'pagada' } })
      const ev = eventoDe(orden.evento)
      if (!compro && ev && vendibleOnline(ev) && mail.includes('@') && !yaEscritos.has(mail)) {
        try { await enviarMailPendiente(orden); yaEscritos.add(mail) } catch (e) { console.error(`⚠️ No se pudo escribir a ${orden.email}:`, e?.message || e) }
      }
      await orden.update({ avisadoEn: new Date() })   // se marca igual: nunca dos veces
    }
  } catch (e) {
    console.error('⚠️ Error en el recupero:', e?.message || e)
  } finally {
    recuperoCorriendo = false
  }
}

// sync() crea las tablas que faltan pero no les agrega columnas nuevas: esto suma las que falten
// (cuando el sistema crece y una base ya existe). Nunca borra ni cambia columnas.
async function completarColumnas() {
  const qi = sequelize.getQueryInterface()
  for (const modelo of [Evento, Orden, Entrada]) {
    const tabla = modelo.getTableName()
    const hay = await qi.describeTable(tabla)
    for (const [nombre, attr] of Object.entries(modelo.getAttributes())) {
      const columna = attr.field || nombre
      if (!hay[columna]) { await qi.addColumn(tabla, columna, { type: attr.type, allowNull: true }); console.log(`🧩 Columna nueva: ${tabla}.${columna}`) }
    }
  }
}

// Las fechas de la ficha se cargan una sola vez: si ya existen en la base, manda la base (el panel).
async function sembrarEventos() {
  for (const e of SEMILLAS) {
    if (!(await Evento.findByPk(e.id))) { await Evento.create(e); console.log(`🗓️ Evento de la ficha cargado: ${e.id}`) }
  }
}

// Conectar la base en segundo plano y crear las tablas si no existen
sequelize.authenticate()
  .then(() => sequelize.sync())
  .then(completarColumnas)
  .then(sembrarEventos)
  .then(cargarEventos)
  .then(() => {
    console.log(`🗄️  Base MySQL conectada · ${EVENTOS.size} evento(s) en la cartelera`)
    if (REPESCA_MINUTOS > 0) { setInterval(repescarPagos, REPESCA_MINUTOS * 60000); setTimeout(repescarPagos, 20000) }
    if (RECUPERO_MINUTOS > 0) { setInterval(recuperarPendientes, 5 * 60000); setTimeout(recuperarPendientes, 90000) }
  })
  .catch(e => {
    console.error('❌ No se pudo conectar a la base:', e?.message || e)
    console.error('   Revisá DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME y la lista de IPs permitidas de Aiven')
  })

// Que un error async no tumbe el proceso
process.on('unhandledRejection', e => console.error('⚠️ unhandledRejection:', e?.message || e))
process.on('uncaughtException', e => console.error('⚠️ uncaughtException:', e?.message || e))
