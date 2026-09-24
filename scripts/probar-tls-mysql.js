#!/usr/bin/env node
/**
 * ¿La base acepta conexiones cifradas?
 *
 * SOLO LEE. Abre conexiones de prueba, corre `SELECT 1` y pregunta qué cifrado
 * quedó negociado. No escribe, no modifica configuración, no toca datos.
 *
 * Para qué sirve: db.js puede hablar con MySQL por TLS, pero eso está apagado
 * por defecto a propósito. Si se activa y el proveedor no presenta un
 * certificado que valide, la aplicación deja de conectar y se cae entera. Este
 * script responde de antemano cuál de los dos modos funciona, sin arriesgar
 * nada.
 *
 * Uso (PowerShell, desde la carpeta del backend):
 *   $env:MYSQL_ADDON_HOST="..."   ; $env:MYSQL_ADDON_PORT="3306"
 *   $env:MYSQL_ADDON_USER="..."   ; $env:MYSQL_ADDON_PASSWORD="..."
 *   $env:MYSQL_ADDON_DB="..."
 *   node scripts/probar-tls-mysql.js
 *
 * IMPORTANTE: nunca escribas los valores reales acá en el archivo -- solo en
 * la terminal. Este archivo se commitea a git, y el repositorio todavía es
 * público.
 */
const mysql = require('mysql2/promise');

const MODOS = [
  {
    nombre: 'require',
    descripcion: 'TLS validando el certificado del servidor',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
  },
  {
    nombre: 'no-verify',
    descripcion: 'TLS sin validar el certificado (cifra, pero no verifica con quién habla)',
    ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false },
  },
  {
    nombre: '(sin TLS)',
    descripcion: 'como está hoy: en texto plano',
    ssl: undefined,
  },
];

async function probar(modo) {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_ADDON_HOST,
    user: process.env.MYSQL_ADDON_USER,
    password: process.env.MYSQL_ADDON_PASSWORD,
    database: process.env.MYSQL_ADDON_DB,
    port: process.env.MYSQL_ADDON_PORT || 3306,
    connectTimeout: 15000,
    ...(modo.ssl ? { ssl: modo.ssl } : {}),
  });
  try {
    await conn.query('SELECT 1');
    // Ssl_cipher vacío = la conexión NO quedó cifrada, aunque no haya fallado.
    const [[fila]] = await conn.query("SHOW STATUS LIKE 'Ssl_cipher'");
    return { ok: true, cifrado: fila && fila.Value ? fila.Value : null };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function main() {
  const faltan = ['MYSQL_ADDON_HOST', 'MYSQL_ADDON_USER', 'MYSQL_ADDON_PASSWORD', 'MYSQL_ADDON_DB']
    .filter((k) => !process.env[k]);
  if (faltan.length) {
    console.error('Faltan variables de entorno: ' + faltan.join(', '));
    process.exit(1);
  }

  console.log(`Probando contra ${process.env.MYSQL_ADDON_HOST} ...\n`);
  const resultados = [];

  for (const modo of MODOS) {
    process.stdout.write(`  ${modo.nombre.padEnd(12)} `);
    try {
      const r = await probar(modo);
      const cifrado = r.cifrado ? `cifrado con ${r.cifrado}` : 'SIN cifrar';
      console.log(`OK    -- ${cifrado}`);
      resultados.push({ modo: modo.nombre, ok: true, cifrado: r.cifrado });
    } catch (err) {
      console.log(`FALLA -- ${err.code || ''} ${err.message}`);
      resultados.push({ modo: modo.nombre, ok: false });
    }
  }

  console.log('\n--- Qué poner en Render ---');
  const conValidacion = resultados.find((r) => r.modo === 'require' && r.ok && r.cifrado);
  const sinValidacion = resultados.find((r) => r.modo === 'no-verify' && r.ok && r.cifrado);

  if (conValidacion) {
    console.log('  MYSQL_SSL=require');
    console.log('  El proveedor presenta un certificado válido: es el modo que conviene.');
  } else if (sinValidacion) {
    console.log('  MYSQL_SSL=no-verify');
    console.log('  El certificado no valida (suele ser autofirmado), pero el tráfico igual viaja');
    console.log('  cifrado. Protege contra quien escuche la red; no contra un man-in-the-middle');
    console.log('  activo. Es mejor que texto plano, no es el destino final.');
  } else {
    console.log('  Ninguno: esta base no acepta TLS.');
    console.log('  Dejá MYSQL_SSL sin definir y planteá mover la base a un proveedor que lo soporte,');
    console.log('  o ponerla detrás de una red privada.');
  }
}

main().catch((e) => { console.error('\nERROR: ' + (e.message || e)); process.exit(1); });
