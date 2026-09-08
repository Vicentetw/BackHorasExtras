const mysql = require('mysql2/promise');

// Bug real en produccion: el plan de Clever Cloud para este usuario de
// MySQL tiene un tope de 'max_user_connections' de 5 (visible en el
// error ER_USER_LIMIT_REACHED) -- el pool pedia hasta 10, mas de lo que
// el servidor permite para este usuario. Con trafico concurrente normal
// (varias pantallas cargando a la vez, mas ahora el agente de
// sincronizacion pegando cada tantos minutos) el pool intentaba abrir
// una 6ta conexion y el servidor la rechazaba de una -- 500 real para
// quien estuviera pidiendo algo en ese momento.
// connectionLimit en 5 (el tope real) + waitForConnections:true (ya
// estaba) -- ahora un pedido de mas simplemente espera en cola a que se
// libere una conexion, en vez de romper con un error.
const db = mysql.createPool({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
  waitForConnections: true,
  dateStrings: true,
  connectionLimit: 5
});

module.exports = db;