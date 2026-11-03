// Modelos + asociaciones. Importá siempre desde acá.
import { sequelize } from '../database.js'
import Orden from './Orden.js'
import Entrada from './Entrada.js'
import Usuario from './Usuario.js'
import Visita from './Visita.js'
import Vinculo from './Vinculo.js'
import SinImputar from './SinImputar.js'
import Evento from './Evento.js'
import Imagen from './Imagen.js'

Orden.hasMany(Entrada, { as: 'qrs', foreignKey: 'orden_id', onDelete: 'CASCADE' })
Entrada.belongsTo(Orden, { as: 'orden', foreignKey: 'orden_id' })

export { sequelize, Orden, Entrada, Usuario, Visita, Vinculo, SinImputar, Evento, Imagen }
