import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Usuarios del panel:
//   admin   → todo: ventas, cupos, recaudación, cortesías, conectar Chytapay (José)
//   organizador → la academia: ve resumen, ventas, puerta y planilla; no vende, no emite
//                 cortesías ni entradas de prueba
//   control → escanea en la puerta y busca compradores
//   venta   → punto de venta físico: carga ventas (efectivo o transferencia) y ve su liquidación
const Usuario = sequelize.define('Usuario', {
  id:      { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  usuario: { type: DataTypes.STRING, allowNull: false, unique: true },
  hash:    { type: DataTypes.STRING, allowNull: false },   // scrypt de la clave
  salt:    { type: DataTypes.STRING, allowNull: false },
  rol:     { type: DataTypes.ENUM('admin', 'control', 'venta', 'organizador'), allowNull: false },
  nombre:  { type: DataTypes.STRING, allowNull: true },    // por ejemplo el nombre del punto de venta
  activo:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, {
  tableName: 'usuarios',
  timestamps: true,
})

export default Usuario
