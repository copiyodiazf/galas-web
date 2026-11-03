// Cambia el nombre de usuario (el email con el que se entra al panel). La clave no cambia.
//   node ../herramientas/con-env-render.mjs renombrar-usuarios.mjs viejo=nuevo [viejo=nuevo ...]
import { sequelize, Usuario } from './models/index.js'

for (const par of process.argv.slice(2)) {
  const [viejo, nuevo] = par.split('=').map(s => s.trim())
  if (!viejo || !nuevo) { console.log(`✗ formato inválido: ${par}`); continue }
  const [n] = await Usuario.update({ usuario: nuevo }, { where: { usuario: viejo } })
  console.log(`${n ? '✓' : '✗ no existe'} ${viejo} → ${nuevo}`)
}
await sequelize.close()
