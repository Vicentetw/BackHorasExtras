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
//
// Este ES el UNICO pool de todo el proceso (horasdedica.js tenia antes
// un SEGUNDO pool propio con connectionLimit:10 -- ver el comentario en
// ese archivo). Con un solo pool compartido, 5 ya alcanzaria en teoria,
// pero se deja en 4 a proposito: deja 1 conexion de margen para un
// script manual corrido aparte mientras el servidor esta vivo (una
// migracion con run-sql.js, un diagnostico puntual) sin chocar contra
// el limite real de Clever Cloud.
const db = mysql.createPool({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
  waitForConnections: true,
  dateStrings: true,
  connectionLimit: 4
});

module.exports = db;