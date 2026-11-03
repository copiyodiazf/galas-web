import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Un evento de la cartelera (una peña, una gala, una función). Cada uno tiene sus tipos de entrada,
// con precio (lo que recibe el organizador) y cupo propios. Se cargan desde el panel.
const json = campo => ({
  type: DataTypes.TEXT,
  get() { try { return JSON.parse(this.getDataValue(campo) || '[]') } catch { return [] } },
  set(v) { this.setDataValue(campo, JSON.stringify(v ?? [])) },
})
const Evento = sequelize.define('Evento', {
  id:          { type: DataTypes.STRING(60), primaryKey: true },   // "2026-11-14-los-arcanos"
  nombre:      { type: DataTypes.STRING(120), allowNull: false },
  subtitulo:   { type: DataTypes.STRING(160), allowNull: true },   // "20 años", "6° aniversario"
  fecha:       { type: DataTypes.DATEONLY, allowNull: false },
  hora:        { type: DataTypes.STRING(10), allowNull: true },    // "21:30"
  puertas:     { type: DataTypes.STRING(40), allowNull: true },
  artistas:    json('artistas'),                                   // ["Néstor Garnica", "invitados"]
  descripcion: { type: DataTypes.TEXT, allowNull: true },             // el "Ver más" de la tarjeta (quiénes tocan, etc.)
  nota:        { type: DataTypes.STRING(120), allowNull: true },      // "Cartelera a confirmar"
  // Fechas que vende OTRA ticketera: se muestran igual en la cartelera, con un botón a su venta.
  externoUrl:   { type: DataTypes.STRING(300), allowNull: true },
  externoTexto: { type: DataTypes.STRING(80), allowNull: true },     // "Entradas en Ticketera X"
  externoPrecio:{ type: DataTypes.STRING(80), allowNull: true },     // "Anticipadas $10.000" (solo informativo)
  imagen:      { type: DataTypes.STRING(200), allowNull: true },   // /img/12 o assets/...
  tipos:       json('tipos'),                                      // [{ id, nombre, corto, detalle, precio, cupo }]
  publicado:   { type: DataTypes.BOOLEAN, defaultValue: false },   // se ve en la cartelera
  ventaAbierta:{ type: DataTypes.BOOLEAN, defaultValue: true },    // con publicado, se puede comprar
  ventaHasta:  { type: DataTypes.DATEONLY, allowNull: true },       // último día de venta online (después, solo en puerta)
}, {
  tableName: 'eventos',
  timestamps: true,
})

export default Evento
