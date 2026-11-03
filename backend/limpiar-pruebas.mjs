// Borra las compras de prueba (ePagos de sandbox) antes de abrir la venta de verdad.
// Deja los usuarios del panel y las visitas. Antes de borrar guarda un respaldo en respaldos/.
//   node limpiar-pruebas.mjs                                             (base local, solo cuenta)
//   node ../herramientas/con-env-render.mjs limpiar-pruebas.mjs          (Aiven, solo cuenta)
//   node ../herramientas/con-env-render.mjs limpiar-pruebas.mjs --borrar (Aiven, respalda y borra)
import { mkdirSync, writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { sequelize, Orden, Entrada } from './models/index.js'

const filas = await Orden.findAll({
  attributes: ['metodo', 'estado', [sequelize.fn('COUNT', sequelize.col('id')), 'n'], [sequelize.fn('MAX', sequelize.col('createdAt')), 'ultima']],
  group: ['metodo', 'estado'], raw: true,
})
console.log('Compras en la base:')
for (const f of filas) console.log(`  ${String(f.metodo).padEnd(13)} ${String(f.estado).padEnd(11)} ${String(f.n).padStart(4)}   última: ${new Date(f.ultima).toLocaleString('es-AR')}`)
console.log(`Entradas (QR): ${await Entrada.count()}`)

if (!process.argv.includes('--borrar')) {
  console.log('\nNo se borró nada. Para borrar, agregar --borrar')
  await sequelize.close()
  process.exit(0)
}

const ordenes = await Orden.findAll({ raw: true })
const entradas = await Entrada.findAll({ raw: true })
const dir = new URL('../respaldos/', import.meta.url)
mkdirSync(dir, { recursive: true })
const archivo = new URL(`pruebas-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`, dir)
writeFileSync(archivo, JSON.stringify({ ordenes, entradas }, null, 1))
console.log(`\nRespaldo: ${fileURLToPath(archivo)} (${ordenes.length} compras, ${entradas.length} entradas)`)

await sequelize.transaction(async transaction => {
  await Entrada.destroy({ where: {}, transaction })
  await Orden.destroy({ where: {}, transaction })
})
console.log(`Borradas. Quedan ${await Orden.count()} compras y ${await Entrada.count()} entradas.`)
await sequelize.close()
