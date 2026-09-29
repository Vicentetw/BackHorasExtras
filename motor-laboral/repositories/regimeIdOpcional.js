// La columna regime_id la crea la migracion 20261007. Render publica el
// backend apenas se sube el codigo, pero la migracion de produccion la
// corre una persona a mano: durante ese rato la columna todavia no existe.
// Para no romper Presentismo en ese intervalo, si MySQL responde "columna
// desconocida" se repite la consulta leyendo NULL en su lugar, que es
// exactamente lo que hay antes de la migracion: nadie tiene regimen.
async function consultarConRegimeId(db, sql, params) {
  try {
    return await db.query(sql, params);
  } catch (err) {
    if (err && err.code === 'ER_BAD_FIELD_ERROR' && /regime_id/.test(err.message || '')) {
      return db.query(sql.replace(/\b(\w+\.)?regime_id\b/, 'NULL AS regime_id'), params);
    }
    throw err;
  }
}

module.exports = { consultarConRegimeId };
