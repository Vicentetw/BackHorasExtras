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
// TLS hacia MySQL (hallazgo F-11 de la auditoria de seguridad)
// ------------------------------------------------------------
// mysql2 NO negocia TLS por su cuenta: sin la opcion `ssl`, la conexion va en
// texto plano. Y aca eso no queda dentro de una maquina: el backend corre en
// Render y la base en Clever Cloud, asi que ese trafico -- las credenciales de
// la base y todo lo que se consulta, incluidos legajos, nombres y DNIs --
// cruza internet publica sin cifrar (CWE-319).
//
// Se controla por variable de entorno y NO se activa solo, a proposito. Si el
// proveedor no presenta un certificado que valide, la app deja de conectar y
// se cae entera; poder prenderlo y apagarlo desde Render, sin volver a
// desplegar, es la diferencia entre un ajuste de dos minutos y una caida.
//
//   (sin definir)          -> como hasta ahora, sin TLS
//   MYSQL_SSL=require      -> TLS validando el certificado del servidor
//   MYSQL_SSL=no-verify    -> TLS SIN validar el certificado
//
// Sobre 'no-verify': cifra el trafico (sirve contra alguien que escucha la
// red) pero no verifica con quien esta hablando, asi que no protege contra un
// man-in-the-middle activo. Es un escalon intermedio para proveedores que
// presentan un certificado autofirmado, no el destino final. Si funciona
// 'require', usar 'require'.
function resolverSsl() {
  const modo = (process.env.MYSQL_SSL || '').trim().toLowerCase();
  if (modo === 'require') return { minVersion: 'TLSv1.2', rejectUnauthorized: true };
  if (modo === 'no-verify') return { minVersion: 'TLSv1.2', rejectUnauthorized: false };
  return undefined;
}

const ssl = resolverSsl();
if (!ssl) {
  console.warn('⚠️  MySQL sin TLS: el trafico con la base viaja sin cifrar. Ver MYSQL_SSL en db.js.');
}

const db = mysql.createPool({
  host: process.env.MYSQL_ADDON_HOST,
  user: process.env.MYSQL_ADDON_USER,
  password: process.env.MYSQL_ADDON_PASSWORD,
  database: process.env.MYSQL_ADDON_DB,
  port: process.env.MYSQL_ADDON_PORT || 3306,
  waitForConnections: true,
  dateStrings: true,
  connectionLimit: 4,
  ...(ssl ? { ssl } : {})
});

module.exports = db;