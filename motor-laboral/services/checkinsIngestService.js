// Fase 18 (agente de sincronizacion de relojes): logica de insercion de
// fichajes/usuarios extraida de horasdedica2.js (/import/checkins,
// /import/users) para poder reusarla TAL CUAL desde 2 lugares -- la subida
// manual por CSV (sin cambios de comportamiento, mismos tests) y el nuevo
// agente automatico (routes/agent.js), sin duplicar la logica de dedupe/
// batching en dos archivos que se puedan desincronizar con el tiempo.
//
// IMPORTANTE: las fechas de CHECKTIME vienen en hora LOCAL Argentina
// (nunca se convierten a UTC) -- ver el comentario historico en
// horasdedica2.js sobre esto. No tocar sin revisar donde mas se usa.

// Funcion para parsear fechas de checkins sin convertir a UTC.
function parseCheckTimeArgentina(value) {
  if (!value) return null;
  const v = String(value).trim();
  // DD/MM/YYYY HH:mm[:ss]
  if (v.match(/^\d{1,2}\/\d{1,2}\/\d{4} \d{2}:\d{2}(?::\d{2})?$/)) {
    const [date, time] = v.split(' ');
    const [dd, mm, yyyy] = date.split('/');
    const t = time.length === 5 ? `${time}:00` : time;
    return `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')} ${t}`;
  }
  // YYYY-MM-DD HH:mm[:ss]
  if (v.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/)) {
    const [date, time] = v.split(' ');
    const t = time.length === 5 ? `${time}:00` : time;
    return `${date} ${t}`;
  }
  console.warn('Formato de CHECKTIME no reconocido:', value);
  return null;
}

// Limite duro por request -- tanto para el CSV manual (un archivo enorme
// ya tenia su propio limite de tamaño de subida) como, sobre todo, para el
// agente automatico: un payload JSON sin este tope podria usarse para un
// DoS (mandar millones de filas de una sola vez). El agente real manda
// como mucho unos pocos miles de fichajes por corrida -- 5000 da margen de
// sobra sin abrir esa puerta.
const MAX_RECORDS_PER_BATCH = 5000;

// records: array de objetos con AL MENOS USERID/CHECKTIME (string), y
// opcionalmente MACHINE_IP/MACHINE_SN -- mismo shape que produce tanto el
// parseo del CSV (csv-parse con columns:true) como el JSON que manda el
// agente Python (mismos nombres de columna que ya exporta exporter.py,
// a proposito, para no tener que transformar nada de un lado al otro).
async function insertCheckinsBatch(records, db) {
  if (records.length > MAX_RECORDS_PER_BATCH) {
    const err = new Error(`Máximo ${MAX_RECORDS_PER_BATCH} registros por lote`);
    err.code = 'BATCH_TOO_LARGE';
    throw err;
  }

  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  const batchSize = 50;
  let batch = [];

  const flush = async () => {
    if (batch.length === 0) return;
    try {
      await db.query(`INSERT IGNORE INTO Checkins (USERID, CHECKTIME, MACHINE_IP, MACHINE_SN) VALUES ?`, [batch]);
      inserted += batch.length;
    } catch (err) {
      if (err.code === 'ER_CON_COUNT_ERROR' || err.message.includes('max_user_connections')) {
        const dbErr = new Error('La base de datos está ocupada. Intenta más tarde.');
        dbErr.code = 'DB_BUSY';
        throw dbErr;
      } else if (err.code === 'ECONNREFUSED') {
        const dbErr = new Error('Error de conexión con la base de datos. Verifica que el servidor de base de datos esté funcionando.');
        dbErr.code = 'DB_UNREACHABLE';
        throw dbErr;
      }
      console.error('ROW BATCH ERROR:', batch, err.message);
      errors += batch.length;
    }
    batch = [];
  };

  for (const r of records) {
    // Limpiar espacios y caracteres invisibles -- mismo saneo que ya tenia
    // el import manual (encontrado en exports reales de algunos relojes,
    // que agregan caracteres de ancho cero).
    const userIdClean = r.USERID ? r.USERID.toString().replace(/\s+/g, '').replace(/[\u200B-\u200D\uFEFF]/g, '') : '';
    const checktimeRaw = r.CHECKTIME ? r.CHECKTIME.toString().replace(/\s+/g, ' ').replace(/[\u200B-\u200D\uFEFF]/g, '').trim() : '';

    if (!userIdClean || !checktimeRaw || !Number.isFinite(Number(userIdClean))) {
      skipped++;
      continue;
    }

    const checktime = parseCheckTimeArgentina(checktimeRaw);
    if (!checktime) {
      skipped++;
      errors++;
      continue;
    }

    const machine_ip = r.MACHINE_IP ? r.MACHINE_IP.toString().trim().slice(0, 45) : null;
    const machine_sn = r.MACHINE_SN ? r.MACHINE_SN.toString().trim().slice(0, 45) : null;
    batch.push([Number(userIdClean), checktime, machine_ip, machine_sn]);

    if (batch.length >= batchSize) await flush();
  }
  await flush();

  return { inserted, skipped, errors, total: records.length };
}

// records: array de objetos { USERID, Badgenumber, Name } -- mismo shape
// que ya produce exportar_userinfo() en el agente Python.
//
// Bug real de produccion: la version anterior hacia hasta 2 consultas
// SECUENCIALES por usuario (una SELECT + una INSERT/UPDATE) -- con un
// lote de 500 usuarios (un sitio con bastante historial, primer
// sincronizacion real del agente) eso son hasta 1000 idas y vueltas a la
// base UNA POR UNA, suficiente para superar el timeout del request y
// devolver un 500 en vez de terminar. Se resuelve con UNA sola consulta
// para saber que ya existe (bulk) y UN solo INSERT masivo para los
// nuevos -- las actualizaciones de nombre (caso raro: mismo Badgenumber
// con un USERID distinto al que ya habia) siguen siendo una por una,
// pero eso deberia ser un puñado de filas, nunca el lote entero.
async function upsertUsersBatch(records, db) {
  if (records.length > MAX_RECORDS_PER_BATCH) {
    const err = new Error(`Máximo ${MAX_RECORDS_PER_BATCH} registros por lote`);
    err.code = 'BATCH_TOO_LARGE';
    throw err;
  }

  let skipped = 0;
  // Map en vez de array -- si el mismo Badgenumber aparece 2 veces en el
  // MISMO lote (pasa de verdad: un reloj puede repetir un usuario), se
  // queda con la ultima aparicion en vez de intentar insertarlo 2 veces
  // (rompia con duplicate key antes de este fix tambien, solo que de forma
  // menos visible al ser secuencial).
  const validosPorBadge = new Map();
  for (const r of records) {
    if (!r.USERID || !r.Badgenumber || !r.Name) {
      skipped++;
      continue;
    }
    const userId = Number(r.USERID);
    if (!Number.isFinite(userId)) {
      skipped++;
      continue;
    }
    validosPorBadge.set(String(r.Badgenumber).trim(), { userId, name: r.Name });
  }

  if (validosPorBadge.size === 0) {
    return { upserted: 0, skipped, total: records.length };
  }

  const badges = [...validosPorBadge.keys()];
  const userIds = [...new Set([...validosPorBadge.values()].map((v) => v.userId))];
  const [existingByBadgeRows] = await db.query(
    `SELECT USERID, TRIM(Badgenumber) AS Badgenumber FROM users WHERE TRIM(Badgenumber) IN (?)`,
    [badges]
  );
  // Bug real de produccion: la version anterior SOLO buscaba existentes por
  // Badgenumber -- un USERID que ya existia con OTRO badge (o sin badge,
  // de una carga vieja) no aparecia ahi, se lo mandaba a INSERT como si
  // fuera nuevo, y chocaba contra la PRIMARY KEY real de la tabla (USERID):
  // "Duplicate entry '201' for key 'users.PRIMARY'". Se agrega esta segunda
  // consulta por USERID -- el chequeo por USERID tiene prioridad (es la
  // clave primaria de verdad; Badgenumber no tiene esa garantia).
  const [existingByUserIdRows] = await db.query(
    `SELECT USERID, TRIM(Badgenumber) AS Badgenumber FROM users WHERE USERID IN (?)`,
    [userIds]
  );
  const existingUserIdByBadge = new Map(existingByBadgeRows.map((r) => [r.Badgenumber, r.USERID]));
  const existingBadgeByUserId = new Map(existingByUserIdRows.map((r) => [r.USERID, r.Badgenumber]));

  const aInsertar = [];
  const aActualizar = []; // { userId, badge: string|null, name } -- badge null = no tocar Badgenumber, solo Name
  for (const [badge, { userId, name }] of validosPorBadge) {
    const existingBadgeForUserId = existingBadgeByUserId.get(userId);
    if (existingBadgeForUserId !== undefined) {
      // El USERID YA EXISTE -- nunca insertar (violaria la PRIMARY KEY).
      // Si el badge cambio (o no tenia), se actualiza junto con el nombre;
      // si es el mismo badge, no hace falta tocar nada.
      if (existingBadgeForUserId !== badge) {
        aActualizar.push({ userId, badge, name });
      }
      continue;
    }
    const existingUserIdForBadge = existingUserIdByBadge.get(badge);
    if (existingUserIdForBadge === undefined) {
      aInsertar.push([userId, badge, name]);
    } else {
      // El badge ya existe pero con OTRO USERID -- no se toca el USERID
      // existente (podria ser un caso de reasignacion real, no se puede
      // decidir solo del lado del agente), solo se refresca el nombre.
      aActualizar.push({ userId: existingUserIdForBadge, badge: null, name });
    }
  }

  if (aInsertar.length > 0) {
    await db.query(`INSERT INTO users (USERID, Badgenumber, Name) VALUES ?`, [aInsertar]);
  }
  for (const { userId, badge, name } of aActualizar) {
    if (badge === null) {
      await db.query('UPDATE users SET Name = ? WHERE USERID = ?', [name, userId]);
    } else {
      await db.query('UPDATE users SET Badgenumber = ?, Name = ? WHERE USERID = ?', [badge, name, userId]);
    }
  }

  return { upserted: validosPorBadge.size, skipped, total: records.length };
}

module.exports = { parseCheckTimeArgentina, insertCheckinsBatch, upsertUsersBatch, MAX_RECORDS_PER_BATCH };
