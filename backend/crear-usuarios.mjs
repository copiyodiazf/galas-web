// Crea (o renueva la clave de) usuarios del panel. Las claves se generan al azar y se
// guardan en usuarios-panel.txt (está en .gitignore): NO se muestran en pantalla.
//   node crear-usuarios.mjs admin:jose "organizador:academia@ejemplo.com:Nombre" control:puerta1 venta:boleteria
//   (rol:usuario[:Nombre a mostrar])
import { randomBytes, scryptSync } from 'crypto'
import { appendFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { sequelize, Usuario } from './models/index.js'

const aqui = dirname(fileURLToPath(import.meta.url))
const ROLES = ['admin', 'control', 'venta', 'organizador']
const pedidos = process.argv.slice(2)
if (!pedidos.length) { console.log('Uso: node crear-usuarios.mjs rol:usuario[:Nombre] ...'); process.exit(1) }

await sequelize.sync()
const lineas = [`# ${new Date().toISOString()}`]
for (const p of pedidos) {
  const [rol, usuario, ...resto] = p.split(':')
  if (!ROLES.includes(rol) || !usuario) { console.log(`✗ ${p}: el formato es rol:usuario (roles: ${ROLES.join(', ')})`); continue }
  // CLAVE=... (con un solo usuario) usa la clave que eligió el usuario; si no, una al azar de 8 caracteres
  const elegida = pedidos.length === 1 && process.env.CLAVE ? process.env.CLAVE : null
  const clave = elegida || randomBytes(6).toString('base64url')
  const salt = randomBytes(16).toString('hex')
  const hash = scryptSync(clave, salt, 64).toString('hex')
  const u = usuario.toLowerCase()
  const [fila, nuevo] = await Usuario.findOrCreate({ where: { usuario: u }, defaults: { usuario: u, rol, salt, hash, nombre: resto.join(':') || null } })
  if (!nuevo) await fila.update({ rol, salt, hash, activo: true, ...(resto.length ? { nombre: resto.join(':') } : {}) })
  lineas.push(`${rol}\t${u}\t${elegida ? '(la eligió el usuario: no se guarda)' : clave}`)
  console.log(`✓ ${rol} ${u} ${nuevo ? 'creado' : 'actualizado (clave nueva)'}`)
}
const archivo = process.env.USUARIOS_ARCHIVO || 'usuarios-panel.txt'   // las de Render van aparte
appendFileSync(join(aqui, archivo), lineas.join('\n') + '\n\n')
console.log(`Las claves quedaron en backend/${archivo}`)
await sequelize.close()
