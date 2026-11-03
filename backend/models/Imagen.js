import { DataTypes } from 'sequelize'
import { sequelize } from '../database.js'

// Fotos que sube el organizador desde el panel (la del flyer de cada peña). Van en la base porque
// el disco de Render se borra en cada deploy. El panel las achica antes de subirlas (máx. 1600 px).
const Imagen = sequelize.define('Imagen', {
  id:    { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
  tipo:  { type: DataTypes.STRING(30), allowNull: false },   // image/jpeg, image/webp, image/png
  datos: { type: DataTypes.BLOB('medium'), allowNull: false },
}, {
  tableName: 'imagenes',
  timestamps: true,
})

export default Imagen
