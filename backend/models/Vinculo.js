import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// La cuenta de Chytapay de la academia, conectada por OAuth. Una sola fila (id 1) por sistema.
// El refreshToken va cifrado (ver chytapay.js): sin la clave del servidor no sirve.
const Vinculo = sequelize.define('Vinculo', {
  id:             { type: DataTypes.INTEGER, primaryKey: true },
  merchantUserId: { type: DataTypes.STRING, allowNull: false },
  nombre:         { type: DataTypes.STRING, allowNull: true },   // titular (razón social o nombre y apellido)
  fantasia:       { type: DataTypes.STRING, allowNull: true },
  cuit:           { type: DataTypes.STRING, allowNull: true },
  email:          { type: DataTypes.STRING, allowNull: true },
  refreshCifrado: { type: DataTypes.TEXT, allowNull: false },
  conectadoEn:    { type: DataTypes.DATE, allowNull: true },
  activo:         { type: DataTypes.BOOLEAN, defaultValue: true },
}, {
  tableName: 'chytapay_vinculo',
  timestamps: true,
})

export default Vinculo
