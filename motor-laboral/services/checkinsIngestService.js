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
async function upsertUsersBatch(records, db) {
  if (records.length > MAX_RECORDS_PER_BATCH) {
    const err = new Error(`Máximo ${MAX_RECORDS_PER_BATCH} registros por lote`);
    err.code = 'BATCH_TOO_LARGE';
    throw err;
  }

  let upserted = 0;
  let skipped = 0;

  for (const r of records) {
    if (!r.USERID || !r.Badgenumber || !r.Name) {
      skipped++;
      continue;
    }

    const trimmedBadge = String(r.Badgenumber).trim();
    const userId = Number(r.USERID);
    if (!Number.isFinite(userId)) {
      skipped++;
      continue;
    }

    const [existing] = await db.query('SELECT USERID FROM users WHERE TRIM(Badgenumber) = ? LIMIT 1', [trimmedBadge]);

    if (existing.length > 0) {
      if (existing[0].USERID !== userId) {
        await db.query('UPDATE users SET Name = ? WHERE USERID = ?', [r.Name, existing[0].USERID]);
      }
    } else {
      await db.query('INSERT INTO users (USERID, Badgenumber, Name) VALUES (?, ?, ?)', [userId, trimmedBadge, r.Name]);
    }

    upserted++;
  }

  return { upserted, skipped, total: records.length };
}

module.exports = { parseCheckTimeArgentina, insertCheckinsBatch, upsertUsersBatch, MAX_RECORDS_PER_BATCH };
