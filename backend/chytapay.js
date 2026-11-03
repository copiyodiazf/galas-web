// ───────────────────────────────────────────────────────────────
//  Chytapay: cobro por transferencia (doc: https://chytapay.com.ar/api/)
//
//  · La academia (cuenta de comercio) autoriza esta integración UNA vez con OAuth.
//    Su refreshToken (180 días) queda cifrado en la base; el idToken dura 1 hora y se
//    renueva solo.
//  · Cada compra es un cobro "checkout": el widget le pide el DNI al comprador, le da un CVU
//    y concilia por el CUIL de quien transfiere.
//  · La comisión de José NO se calcula acá: Chytapay la transfiere sola en cada pago, desde la
//    cuenta de la academia a la del recaudador (Portal → Distribución). La academia la acepta
//    al autorizar.
//  · Los avisos vienen firmados (HMAC-SHA256): se verifican antes de creerles.
// ───────────────────────────────────────────────────────────────
import { createHmac, createHash, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'crypto'
import { Vinculo } from './models/index.js'

const URLS = {
  test: { api: 'https://integration-api.test.chytapay.com.ar', auth: 'https://auth-api.test.chytapay.com.ar' },
  prod: { api: 'https://integration-api.chytapay.com.ar', auth: 'https://auth-api.chytapay.com.ar' },
}

// ⚠️ process.env se lee DENTRO de las funciones: los imports corren antes que dotenv.config().
function cfg() {
  const prod = /^prod/i.test(process.env.CHYTAPAY_ENV || '')
  // CHYTAPAY_API_URL / CHYTAPAY_AUTH_URL: solo para las pruebas contra el Chytapay de imitación
  // (herramientas/prueba-chytapay.mjs). En producción se ignoran.
  const urls = prod ? URLS.prod : { api: process.env.CHYTAPAY_API_URL || URLS.test.api, auth: process.env.CHYTAPAY_AUTH_URL || URLS.test.auth }
  return {
    prod,
    urls,
    clientId: process.env.CHYTAPAY_CLIENT_ID || '',
    clientSecret: process.env.CHYTAPAY_CLIENT_SECRET || '',
    pk: process.env.CHYTAPAY_PK || '',
    secretoAvisos: process.env.CHYTAPAY_WEBHOOK_SECRET || '',
    // La vuelta del OAuth: tiene que estar registrada IDÉNTICA en el Portal (Configuración → redirect_uri).
    redirectUri: process.env.CHYTAPAY_REDIRECT_URI || (process.env.PUBLIC_URL ? process.env.PUBLIC_URL.replace(/\/$/, '') + '/chytapay/vuelta' : ''),
    // Atajo de Sandbox: el Portal da el idToken de un comercio de prueba (dura 1 h). No existe en producción.
    tokenPrueba: process.env.CHYTAPAY_ID_TOKEN_PRUEBA || '',
  }
}
// Modo SIMULADO (solo en una PC, nunca en producción): no habla con Chytapay. La compra muestra un botón
// "Simular pago" que llama a /api/dev/confirmar. Sirve para probar todo el circuito sin credenciales.
const simulado = () => process.env.CHYTAPAY_SIMULADO === 'true' && !cfg().prod && process.env.NODE_ENV !== 'production'
export const chytapayEsProduccion = () => cfg().prod
export const clavePublicable = () => simulado() ? 'simulado' : cfg().pk
export function chytapayConfigurado() {
  if (simulado()) return true
  const c = cfg()
  return Boolean(c.pk && c.secretoAvisos && ((c.clientId && c.clientSecret) || (!c.prod && c.tokenPrueba)))
}

// ── El refreshToken se guarda cifrado (AES-256-GCM). La clave sale de CHYTAPAY_CLAVE_TOKENS o, si no
//    está, de QR_SECRET: quien lea la base sin la clave no puede cobrar a nombre de la academia.
function claveCifrado() {
  const base = process.env.CHYTAPAY_CLAVE_TOKENS || process.env.QR_SECRET || ''
  if (base.length < 16) throw new Error('Falta CHYTAPAY_CLAVE_TOKENS (o QR_SECRET) para cifrar el token de la academia')
  return createHash('sha256').update('chytapay:' + base).digest()
}
export function cifrar(texto) {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', claveCifrado(), iv)
  const datos = Buffer.concat([c.update(String(texto), 'utf8'), c.final()])
  return [iv, c.getAuthTag(), datos].map(b => b.toString('base64url')).join('.')
}
export function descifrar(paquete) {
  const [iv, tag, datos] = String(paquete).split('.').map(p => Buffer.from(p, 'base64url'))
  const d = createDecipheriv('aes-256-gcm', claveCifrado(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(datos), d.final()]).toString('utf8')
}

async function pedir(url, { metodo = 'GET', cuerpo, token } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
    signal: AbortSignal.timeout(15000),
  })
  const texto = await r.text()
  let datos = null
  try { datos = texto ? JSON.parse(texto) : null } catch { datos = { mensaje: texto.slice(0, 300) } }
  return { status: r.status, ok: r.ok, datos }
}
const errorDe = (r, que) => new Error(`${que}: HTTP ${r.status} ${r.datos?.code || r.datos?.error || ''} ${r.datos?.message || r.datos?.mensaje || ''}`.trim())

// ═══ Conexión de la academia (OAuth) ═══
export function urlAutorizar(state) {
  const c = cfg()
  const u = new URL(`${c.urls.auth}/integration/oauth2/authorize`)
  u.search = new URLSearchParams({ response_type: 'code', client_id: c.clientId, redirect_uri: c.redirectUri, state }).toString()
  return u.toString()
}

export async function canjearCode(code) {
  const c = cfg()
  const r = await pedir(`${c.urls.auth}/integration/oauth2/token`, { metodo: 'POST',
    cuerpo: { grantType: 'authorization_code', code, clientId: c.clientId, clientSecret: c.clientSecret, redirectUri: c.redirectUri } })
  if (!r.ok || !r.datos?.idToken || !r.datos?.refreshToken) throw errorDe(r, 'No se pudo canjear el código de Chytapay')
  return { idToken: r.datos.idToken, refreshToken: r.datos.refreshToken, expiresIn: Number(r.datos.expiresIn) || 3600 }
}

export async function quienSoy(idToken) {
  const r = await pedir(`${cfg().urls.api}/me`, { token: idToken })
  if (!r.ok) throw errorDe(r, 'No se pudo consultar la cuenta de Chytapay')
  return r.datos
}

// ═══ Sedes (multitenant) ═══
// Cada gala es una "sede" de la integración (Portal → Tenants), con SU URL de avisos. Al conectar la
// cuenta de la academia se la asigna a la sede de este sistema (CHYTAPAY_SEDE = la key de la sede):
// así los payment.unmatched de esa cuenta llegan solo acá. Los avisos de cada cobro ya vienen por su
// webhookUrl. Sin CHYTAPAY_SEDE no se hace nada (integración de una sola URL).
export const sedeConfigurada = () => String(process.env.CHYTAPAY_SEDE || '').trim()
export async function asignarSede(tokenAcademia) {
  const tenantKey = sedeConfigurada()
  if (!tenantKey) return { ok: false, motivo: 'sin CHYTAPAY_SEDE' }
  if (simulado()) return { ok: true, tenantKey, simulado: true }
  const hacer = t => pedir(`${cfg().urls.api}/my-integration/tenant`, { metodo: 'PUT', cuerpo: { tenantKey }, token: t })
  const r = tokenAcademia ? await hacer(tokenAcademia) : await conToken(hacer)
  if (r.status === 404) throw new Error(`La sede "${tenantKey}" no existe en el Portal de Chytapay (Tenants): creala con esa key y la URL de avisos de esta gala`)
  if (!r.ok) throw errorDe(r, 'No se pudo asignar la sede en Chytapay')
  return { ok: true, tenantKey }
}

// Guarda (o reemplaza) la cuenta de la academia conectada. Hay una sola por sistema.
export async function guardarVinculo({ refreshToken, idToken, expiresIn }) {
  const yo = await quienSoy(idToken)
  const datos = {
    id: 1, merchantUserId: yo.merchantUserId, nombre: yo.accountHolderName || yo.fantasyName || '', fantasia: yo.fantasyName || '',
    cuit: yo.accountHolderTaxId || '', email: yo.email || '', refreshCifrado: cifrar(refreshToken), conectadoEn: new Date(), activo: true,
  }
  await Vinculo.upsert(datos)
  _token = { valor: idToken, vence: Date.now() + (expiresIn - 300) * 1000 }
  return datos
}

export async function vinculoActual() {
  const v = await Vinculo.findByPk(1, { raw: true })
  return v && Number(v.activo) !== 0 ? v : null
}

// ═══ idToken de la academia (1 hora; se renueva con el refreshToken) ═══
let _token = { valor: null, vence: 0 }
let _renovando = null
async function idToken() {
  const c = cfg()
  if (_token.valor && Date.now() < _token.vence) return _token.valor
  if (_renovando) return _renovando
  _renovando = (async () => {
    const v = await vinculoActual()
    if (!v) {
      if (!c.prod && c.tokenPrueba) return c.tokenPrueba
      throw new Error('La cuenta de Chytapay de la academia no está conectada (Panel → Herramientas → Conectar Chytapay)')
    }
    const r = await pedir(`${c.urls.auth}/integration/oauth2/refresh`, { metodo: 'POST',
      cuerpo: { grantType: 'refresh_token', refreshToken: descifrar(v.refreshCifrado), clientId: c.clientId, clientSecret: c.clientSecret } })
    if (!r.ok || !r.datos?.idToken) throw errorDe(r, 'No se pudo renovar el acceso a Chytapay (¿la academia desvinculó la cuenta?)')
    _token = { valor: r.datos.idToken, vence: Date.now() + ((Number(r.datos.expiresIn) || 3600) - 300) * 1000 }
    return _token.valor
  })()
  try { return await _renovando } finally { _renovando = null }
}
// Si la API dice 401, el token se tira y se reintenta una vez con uno nuevo.
async function conToken(hacer) {
  let r = await hacer(await idToken())
  if (r.status === 401) { _token = { valor: null, vence: 0 }; r = await hacer(await idToken()) }
  return r
}

// ═══ Cobros ═══
// Cobro de checkout: el comprador se identifica en el widget. Vence en expiresInMinutes (3 a 60).
// webhookUrl: los avisos de ESTE cobro van a esta gala. Hace falta porque la integración es una sola
// para todas las galas y su URL de avisos también (solo los payment.unmatched no lo respetan).
export async function crearCobroCheckout({ referenceId, amount, description, expiresInMinutes = 60, metadata, webhookUrl }) {
  if (simulado()) return { paymentRequestId: 'sim_' + referenceId, state: 'pending', simulado: true }
  const cuerpo = { type: 'checkout', referenceId, amount: Number(amount), description: String(description).slice(0, 500),
    expiresInMinutes: Math.min(60, Math.max(3, Math.round(expiresInMinutes))), ...(metadata ? { metadata } : {}),
    ...(/^https:\/\//.test(webhookUrl || '') ? { webhookUrl } : {}) }
  const r = await conToken(t => pedir(`${cfg().urls.api}/payment-request`, { metodo: 'POST', cuerpo, token: t }))
  if (r.status === 409) {
    // Ya existía (un reintento después de un timeout): se usa el que está.
    const existente = await consultarCobro(referenceId)
    if (existente) return existente
  }
  if (!r.ok || !r.datos?.paymentRequestId) throw errorDe(r, 'Chytapay no creó el cobro')
  return r.datos
}

// Estado de un cobro por nuestro referenceId. null si no existe.
export async function consultarCobro(referenceId) {
  if (simulado()) return { referenceId, state: 'pending' }   // en simulado se paga con /api/dev/confirmar
  const r = await conToken(t => pedir(`${cfg().urls.api}/payment-request/${encodeURIComponent(referenceId)}`, { token: t }))
  if (r.status === 404) return null
  if (!r.ok) throw errorDe(r, 'No se pudo consultar el cobro en Chytapay')
  return r.datos
}

// ¿Está pagado del todo, por al menos el monto esperado?
export async function cobroPagado(referenceId, totalEsperado) {
  const c = await consultarCobro(referenceId)
  if (!c) return { ok: false, motivo: 'no existe en Chytapay' }
  const estado = c.state || c.status
  if (estado !== 'total_payment') return { ok: false, motivo: `estado ${estado}`, cobro: c }
  const pagado = Number(c.paidAmount ?? c.amount)
  if (Number.isFinite(pagado) && pagado + 1 < Number(totalEsperado)) return { ok: false, motivo: `pagó ${pagado} de ${totalEsperado}`, cobro: c }
  return { ok: true, cobro: c }
}

// ═══ Avisos (webhooks) ═══
// Header X-Chytapay-Signature: "t=<unix>,v1=<hex>". HMAC-SHA256 de "{t}.{cuerpo crudo}" con el secreto whsec_...
// Se rechaza si el t está a más de 5 minutos de la hora del servidor (evita repetir un aviso viejo).
export function firmaValida(cuerpoCrudo, header, ahora = Date.now()) {
  const secreto = cfg().secretoAvisos
  if (!secreto || !header || !cuerpoCrudo) return false
  const partes = Object.fromEntries(String(header).split(',').map(p => p.trim().split('=')).filter(p => p.length === 2))
  const t = Number(partes.t)
  if (!Number.isFinite(t) || Math.abs(ahora / 1000 - t) > 300 || !partes.v1) return false
  const esperado = createHmac('sha256', secreto).update(`${t}.`).update(cuerpoCrudo).digest('hex')
  const a = Buffer.from(partes.v1, 'hex'), b = Buffer.from(esperado, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
