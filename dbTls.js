// ============================================================================
// Cifrado (TLS) de la conexión con la base de datos (2026-10-18)
// ============================================================================
//
// MODOS (variable MYSQL_SSL en Render):
//   (sin definir)  -> sin cifrar (como al principio).
//   no-verify      -> cifrado, pero sin comprobar CON QUIÉN se habla. Protege
//                     contra alguien que escucha la red, no contra alguien que
//                     se hace pasar por la base.
//   require        -> cifrado Y verificado.
//
// EL CASO DE CLEVER CLOUD (y de muchos MySQL en la nube): el certificado de la
// base lo firma una autoridad generada por el propio MySQL ("Auto_Generated_CA"),
// que ningún sistema reconoce, y no trae el nombre del servidor. Por eso
// `require` "a secas" no conecta (HANDSHAKE_SSL_ERROR, probado el 18/10).
// La solución estándar es FIJAR esa autoridad: MYSQL_SSL_CA tiene su
// certificado (texto PEM) y la conexión se verifica contra ella. Quien quisiera
// hacerse pasar por la base no tiene la clave privada de esa autoridad, así que
// no puede presentar un certificado válido. Lo que no se puede verificar es el
// NOMBRE (el certificado no lo trae): la protección la da la autoridad fijada.
// La pantalla Seguridad (superadmin) lee esa autoridad, prueba que funcione y
// la muestra para copiarla en Render.

// Render guarda bien los valores de varias líneas, pero si se pega con "\n"
// literales también se acepta.
function normalizarPem(texto) {
  if (!texto) return null;
  const t = String(texto).replace(/\\n/g, '\n').trim();
  return /-----BEGIN CERTIFICATE-----/.test(t) ? t + '\n' : null;
}

/**
 * Pura. Opciones `ssl` de mysql2 según las variables de entorno.
 * @param {{MYSQL_SSL?:string, MYSQL_SSL_CA?:string}} env
 */
function opcionesSsl(env = process.env) {
  const modo = String(env.MYSQL_SSL || '').trim().toLowerCase();
  const ca = normalizarPem(env.MYSQL_SSL_CA);
  if (modo === 'require' && ca) {
    return {
      minVersion: 'TLSv1.2',
      rejectUnauthorized: true,
      ca,
      // El certificado del servidor no trae su nombre: se verifica la cadena
      // contra la autoridad fijada, no el nombre (ver arriba).
      checkServerIdentity: () => undefined,
    };
  }
  if (modo === 'require') return { minVersion: 'TLSv1.2', rejectUnauthorized: true };
  if (modo === 'no-verify') return { minVersion: 'TLSv1.2', rejectUnauthorized: false };
  return undefined;
}

/** Certificado (de la cadena del servidor) a texto PEM. */
function aPem(cert) {
  const b64 = cert.raw.toString('base64').match(/.{1,64}/g).join('\n');
  return `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
}

/**
 * La cadena de certificados que presentó la base en una conexión ya abierta
 * (mysql2: conexion.connection.stream es el socket TLS). Devuelve cada
 * certificado y el PEM de la raíz (la autoridad a fijar).
 */
function cadenaDe(socket) {
  const cadena = [];
  let raiz = null;
  let x = socket && socket.getPeerCertificate ? socket.getPeerCertificate(true) : null;
  const vistos = new Set();
  while (x && x.raw && !vistos.has(x.fingerprint256)) {
    vistos.add(x.fingerprint256);
    cadena.push({ sujeto: (x.subject && x.subject.CN) || null, emisor: (x.issuer && x.issuer.CN) || null, vence: x.valid_to, huella: x.fingerprint256 });
    raiz = x;
    x = x.issuerCertificate;
  }
  return { cadena, raizPem: raiz ? aPem(raiz) : null, raizHuella: raiz ? raiz.fingerprint256 : null };
}

module.exports = { opcionesSsl, normalizarPem, cadenaDe, aPem };
