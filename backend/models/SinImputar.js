import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Transferencias que entraron a la cuenta de la academia pero Chytapay no pudo asignar a una compra
// (pagó otra persona, pagó después de vencer, pagó dos veces). La plata está en la cuenta de la
// academia: ella la asigna a mano desde Chytapay y entonces llega el aviso de pago y se emite.
const SinImputar = sequelize.define('SinImputar', {
  id:          { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  avisoId:     { type: DataTypes.STRING, allowNull: true },    // X-Chytapay-Webhook-Id
  motivo:      { type: DataTypes.STRING, allowNull: true },    // expired, already_paid, canceled, no_cuil_match, no_pending, ambiguous
  monto:       { type: DataTypes.DECIMAL(14, 2), allowNull: true },
  pagador:     { type: DataTypes.STRING, allowNull: true },
  pagadorCuil: { type: DataTypes.STRING, allowNull: true },
  orden_id:    { type: DataTypes.STRING, allowNull: true },    // si Chytapay pudo atribuirlo a un cobro
  fecha:       { type: DataTypes.DATE, allowNull: true },
  resuelto:    { type: DataTypes.BOOLEAN, defaultValue: false },
  emitida:     { type: DataTypes.BOOLEAN, defaultValue: false },  // llegó tarde pero era inequívoca: las entradas ya salieron
}, {
  tableName: 'sin_imputar',
  timestamps: true,
  indexes: [{ fields: ['avisoId'], unique: true }],
})

export default SinImputar
