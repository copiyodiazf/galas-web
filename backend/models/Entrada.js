import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Una entrada (un QR). Vale para SU evento y entra una sola vez.
const Entrada = sequelize.define('Entrada', {
  id:       { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  orden_id: { type: DataTypes.STRING, allowNull: false },
  evento:   { type: DataTypes.STRING(60), allowNull: false },
  indice:   { type: DataTypes.INTEGER, allowNull: false },   // 1..cantidad
  tipo:     { type: DataTypes.STRING(40), allowNull: false },
  butaca:   { type: DataTypes.STRING(20), allowNull: true },    // "5-12" (fila-asiento), en las galas con sala
  codigo:   { type: DataTypes.STRING, allowNull: false },    // contenido firmado del QR (base::firma)
  base:     { type: DataTypes.STRING, allowNull: false },    // "ordenId::indice"
  usado:    { type: DataTypes.BOOLEAN, defaultValue: false },
  usadoEn:  { type: DataTypes.DATE, allowNull: true },
}, {
  tableName: 'entradas',
  timestamps: true,
  indexes: [{ fields: ['base'], unique: true }, { fields: ['orden_id'] }, { fields: ['evento', 'usado'] }],
})

export default Entrada
