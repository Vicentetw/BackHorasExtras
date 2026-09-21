// ============================================================================
// Reglas para vincular un usuario del reloj con un empleado.
// ============================================================================
//
// EL MODELO, EN CRIOLLO
// ---------------------
//   USERID       -> la llave interna del reloj biometrico. Solo sirve para
//                   unir los fichajes (CHECKINOUT/Checkins) con la fila de
//                   `users`. NO identifica a una persona y NO debe decidir
//                   nada.
//   Badgenumber  -> el LEGAJO real. Esta es la identidad que une al usuario
//                   del reloj con el empleado (employees.employee_id).
//
// Perder esa distincion salio carisimo (2026-09): el matching viejo elegia
// entre dos usuarios del mismo legajo con `users[0]` y sin `ORDER BY`, o sea
// por USERID mas bajo. Siempre elegia una fila importada de un CSV que nunca
// habia fichado, en vez de la del reloj. Resultado: 95 empleados activos
// vinculados a un usuario fantasma, y 81.622 fichajes que no llegaban a
// ningun reporte. Ver ESTADO_PROYECTO.md.
//
// DE AHI SALEN LAS DOS REGLAS DE ESTE ARCHIVO
// -------------------------------------------
// 1. El legajo es lo unico que identifica. Sin legajo igual, no hay
//    candidato.
// 2. Si hay varios candidatos para el mismo legajo, gana EL QUE FICHA.
//    Nunca el primero de la lista. Un usuario de reloj que jamas ficho no
//    puede ganarle a uno que ficha todos los dias.
//
// Y EL NOMBRE, ¿PARA QUE SIRVE?
// -----------------------------
// Para corroborar, no para decidir. Se midio contra los 478 casos reales de
// produccion: exigir que el nombre coincida EXACTO rechazaria el 83% de los
// vinculos buenos, porque el reloj casi siempre guarda solo el apellido
// ("VILLARROEL" vs "VILLARROEL, Victor Saul"). Asi que el nombre define un
// NIVEL DE CONFIANZA que se le muestra a la persona que decide, y nada mas.
//
// NADA SE APLICA SOLO. Estas funciones proponen; siempre acepta una persona,
// vinculo por vinculo.

// ============================================================================
// QUE DATO CARGO LA EMPRESA EN EL RELOJ
// ============================================================================
//
// El Badgenumber es la identidad, si -- pero identidad SEGUN QUE. Cada
// empresa decide que le carga al reloj cuando da de alta a una persona:
// puede ser el legajo, o puede ser el DNI. El reloj no sabe ni le importa;
// guarda el numero que le tipearon.
//
// Por eso esto es configurable por empresa y no una constante. En AVP se
// midio y es inequivoco: 478 Badgenumber coinciden con el legajo y 0 con el
// documento; ademas los badges tienen 4 digitos y los DNI 8. Pero la
// proxima empresa puede tener lo contrario.
//
// SEGURIDAD: estos nombres de columna se meten en una consulta SQL, asi que
// NUNCA se toma el valor que venga de afuera tal cual. Se busca en este
// mapa y, si no esta, se usa el default. Es una lista blanca, no una
// interpolacion.
const IDENTITY_FIELDS = {
  legajo: {
    column: 'employee_id',
    label: 'Legajo',
    description: 'El Badgenumber del reloj es el numero de legajo del empleado'
  },
  documento: {
    column: 'documento',
    label: 'Documento (DNI)',
    description: 'El Badgenumber del reloj es el documento del empleado'
  }
};

const DEFAULT_IDENTITY_FIELD = 'legajo';

/**
 * Traduce la opcion elegida a la columna de `employees` contra la que hay
 * que comparar. Cualquier valor desconocido (o vacio) cae en el default --
 * nunca llega a la consulta SQL algo que no este en la lista blanca.
 */
function resolveIdentityField(value) {
  const key = String(value || '').trim().toLowerCase();
  return IDENTITY_FIELDS[key] ? key : DEFAULT_IDENTITY_FIELD;
}

function identityColumn(value) {
  return IDENTITY_FIELDS[resolveIdentityField(value)].column;
}

// Deja el nombre comparable: sin acentos, sin puntuacion, en minusculas y
// con las palabras ordenadas (asi "PEREZ, Juan" y "Juan Perez" dan igual).
function normalizeName(name) {
  return String(name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// Variante que BORRA la letra acentuada en vez de reemplazarla.
//
// Por que hace falta: el reloj no transforma "CAÑETE" en "CANETE", la come
// entera y guarda "CAETE". Lo mismo con "AGÜERO" -> "AGERO", "Rubén" ->
// "Rubn", "Iñaky" -> "Iaky". Es un problema de codificacion en la descarga.
// Comparar asi permite reconocer esos casos como el mismo nombre mientras el
// bug de origen no este corregido.
function dropAccentedLetters(name) {
  return String(name || '')
    .normalize('NFD')
    .replace(/[a-zA-Z][\u0300-\u036f]+/g, '')   // saca la letra Y su tilde
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .sort()
    .join(' ');
}

// ¿Las palabras de `a` estan todas dentro de `b`? Sirve para el caso comun:
// el reloj guarda "VILLARROEL" y el legajo dice "VILLARROEL, Victor Saul".
function isTokenSubset(a, b) {
  if (!a || !b) return false;
  const tokensB = new Set(b.split(' '));
  return a.split(' ').every((t) => tokensB.has(t));
}

const NAME_EVIDENCE = {
  EXACT: 'exacto',
  CONTAINS: 'contiene',
  ACCENTS: 'acentos',
  NO_NAME: 'sin_nombre',
  MISMATCH: 'no_coincide'
};

/**
 * Compara el nombre que tiene el reloj contra el nombre del legajo y
 * devuelve QUE TAN BIEN corrobora, no un si/no.
 *
 * - `exacto`      los dos nombres son el mismo (82 casos reales)
 * - `contiene`    uno esta contenido en el otro, tipico "solo el apellido"
 *                 (363 casos reales -- el caso MAS comun, por lejos)
 * - `acentos`     coinciden si se toma en cuenta que el reloj se come las
 *                 tildes y la ñ ("CAETE" = "CAÑETE")
 * - `sin_nombre`  el reloj no tiene nombre util: vacio, o el legajo puesto
 *                 como nombre ("9370"). No se puede corroborar nada.
 * - `no_coincide` son nombres distintos. Bandera roja de verdad.
 */
function classifyNameEvidence(clockName, employeeName) {
  const rawClock = String(clockName || '').trim();
  if (!rawClock) return NAME_EVIDENCE.NO_NAME;
  // Un "nombre" que es solo digitos es el legajo repetido, no un nombre.
  if (/^\d+$/.test(rawClock.replace(/\s/g, ''))) return NAME_EVIDENCE.NO_NAME;

  const a = normalizeName(clockName);
  const b = normalizeName(employeeName);
  if (!a || !b) return NAME_EVIDENCE.NO_NAME;
  if (a === b) return NAME_EVIDENCE.EXACT;
  if (isTokenSubset(a, b) || isTokenSubset(b, a)) return NAME_EVIDENCE.CONTAINS;

  const a2 = dropAccentedLetters(clockName);
  const b2 = dropAccentedLetters(employeeName);
  if (a2 && b2 && (a2 === b2 || isTokenSubset(a2, b2) || isTokenSubset(b2, a2))) {
    return NAME_EVIDENCE.ACCENTS;
  }

  return NAME_EVIDENCE.MISMATCH;
}

// Solo estos tres niveles vienen pre-tildados en la pantalla. Los otros dos
// se muestran igual (a veces son validos: hay gente cuyo usuario de reloj
// tiene el legajo por nombre) pero exigen que alguien los mire y los tilde a
// mano.
const TRUSTWORTHY_EVIDENCE = new Set([
  NAME_EVIDENCE.EXACT,
  NAME_EVIDENCE.CONTAINS,
  NAME_EVIDENCE.ACCENTS
]);

/**
 * EL DESEMPATE QUE FALTABA.
 *
 * Ordena los usuarios de reloj candidatos a un mismo legajo, del mas
 * probable al menos. El criterio es "quien lo usa de verdad":
 *   1. tener fichajes le gana a no tener ninguno;
 *   2. entre dos que fichan, el del fichaje mas reciente;
 *   3. recien ahi, y solo para que el resultado sea estable y repetible,
 *      el USERID mas bajo.
 *
 * El bug viejo era justamente saltar directo al paso 3.
 */
function rankCandidateUsers(users) {
  return [...(users || [])].sort((x, y) => {
    const xHas = (x.checkinCount || 0) > 0 ? 1 : 0;
    const yHas = (y.checkinCount || 0) > 0 ? 1 : 0;
    if (xHas !== yHas) return yHas - xHas;

    const xLast = x.lastCheckin ? String(x.lastCheckin) : '';
    const yLast = y.lastCheckin ? String(y.lastCheckin) : '';
    if (xLast !== yLast) return yLast < xLast ? -1 : 1;

    return (x.USERID || 0) - (y.USERID || 0);
  });
}

/**
 * Arma la propuesta final para una persona que va a decidir.
 *
 * Recibe las filas crudas (usuario de reloj + empleado que comparten legajo)
 * y devuelve, POR EMPLEADO, el mejor candidato mas la evidencia para que se
 * pueda revisar sin entrar a la base:
 *
 *   {
 *     employeeId, empLegajo, employeeName,
 *     USERID, userBadgenumber, userName,
 *     checkinCount, lastCheckin,
 *     nameEvidence,         // exacto | contiene | acentos | sin_nombre | no_coincide
 *     preselected,          // viene tildado en la pantalla o no
 *     alternatives          // los otros usuarios de reloj con el mismo legajo
 *   }
 *
 * `preselected: false` NO quiere decir "no se puede". Quiere decir "miralo
 * vos". Nada de esto se aplica solo: cada vinculo lo acepta una persona.
 */
function buildMatchProposals(rows) {
  const byEmployee = new Map();
  for (const row of rows || []) {
    if (!byEmployee.has(row.employee_id)) byEmployee.set(row.employee_id, []);
    byEmployee.get(row.employee_id).push(row);
  }

  const proposals = [];
  for (const [employeeId, candidates] of byEmployee) {
    const ranked = rankCandidateUsers(candidates);
    const best = ranked[0];
    const nameEvidence = classifyNameEvidence(best.user_name, best.employee_name);

    proposals.push({
      employeeId,
      empLegajo: best.emp_legajo,
      employeeName: best.employee_name,
      USERID: best.USERID,
      userBadgenumber: best.user_badgenumber,
      userName: best.user_name,
      checkinCount: best.checkinCount || 0,
      lastCheckin: best.lastCheckin || null,
      nameEvidence,
      preselected: TRUSTWORTHY_EVIDENCE.has(nameEvidence),
      // Si hay mas de un usuario de reloj con este legajo hay que mostrarlo:
      // es exactamente la situacion que genero el desastre de 2026-09.
      alternatives: ranked.slice(1).map((u) => ({
        USERID: u.USERID,
        userName: u.user_name,
        checkinCount: u.checkinCount || 0,
        lastCheckin: u.lastCheckin || null
      }))
    });
  }
  return proposals;
}

// ============================================================================
// AVISO: ALGUIEN FICHA Y NO ESTA EN LA LISTA
// ============================================================================
//
// Pedido del dueño del producto (2026-09-20): "si está fichando y no está en
// la lista, o está desactivado o ignorado, sería bueno que salga un aviso
// para activarlo".
//
// Es lo que hay que mirar para que el sistema sea confiable de acá en
// adelante: no importa tanto el historial viejo, importa que MAÑANA, si una
// persona ficha y sus horas no van a ir a ningún lado, alguien se entere
// ANTES de cerrar el mes.
//
// Los USERID <= 10 no entran: en este reloj son marcadores ficticios, no
// personas (el 1 es el administrador del reloj). Dato del dueño del
// producto; el codigo ya los filtraba en varios lados.

const PUNCHER_STATUS = {
  /** El empleado existe pero esta dado de baja. Ficha igual. */
  INACTIVE: 'dado_de_baja',
  /** El empleado existe y esta activo, pero se lo oculto del informe. */
  HIDDEN: 'oculto',
  /** El empleado existe y esta visible, pero nadie lo vinculo al reloj. */
  UNLINKED: 'sin_vincular',
  /** Ficha alguien cuyo numero no corresponde a ningun empleado. */
  UNKNOWN: 'sin_empleado'
};

/**
 * Decide por que las fichadas de alguien no estan llegando a un informe.
 *
 * Importante: `resolvedEmployee` es el empleado al que el INFORME llega hoy
 * (resuelto con la misma logica que usa /attendance-range). Si ese dato
 * existe y el empleado esta activo y visible, no hay nada que avisar --
 * justamente lo que me falto verificar cuando di por perdidos 81.622
 * fichajes que en realidad llegaban bien.
 *
 * @param {object|null} resolvedEmployee empleado al que llega hoy, o null
 * @param {object|null} identityEmployee empleado cuyo legajo/documento coincide
 *                                       con el numero que ficha, si existe
 */
function classifyPuncher(resolvedEmployee, identityEmployee) {
  if (resolvedEmployee) {
    if (Number(resolvedEmployee.activo) === 0) return PUNCHER_STATUS.INACTIVE;
    if (Number(resolvedEmployee.exclude_from_report) === 1) return PUNCHER_STATUS.HIDDEN;
    return null; // llega bien: no hay nada que avisar
  }
  if (identityEmployee) {
    if (Number(identityEmployee.activo) === 0) return PUNCHER_STATUS.INACTIVE;
    if (Number(identityEmployee.exclude_from_report) === 1) return PUNCHER_STATUS.HIDDEN;
    return PUNCHER_STATUS.UNLINKED;
  }
  return PUNCHER_STATUS.UNKNOWN;
}

/** Que hacer con cada caso, en palabras que entienda cualquiera. */
const PUNCHER_STATUS_INFO = {
  [PUNCHER_STATUS.INACTIVE]: {
    titulo: 'Está dado de baja, pero sigue fichando',
    accion: 'Reactivar'
  },
  [PUNCHER_STATUS.HIDDEN]: {
    titulo: 'Está oculto en los informes, pero sigue fichando',
    accion: 'Volver a mostrar'
  },
  [PUNCHER_STATUS.UNLINKED]: {
    titulo: 'Ficha, pero no está asociado a su usuario del reloj',
    accion: 'Asociar'
  },
  [PUNCHER_STATUS.UNKNOWN]: {
    titulo: 'Ficha un número que no corresponde a ningún empleado',
    accion: 'Revisar a mano'
  }
};

module.exports = {
  classifyPuncher,
  PUNCHER_STATUS,
  PUNCHER_STATUS_INFO,
  normalizeName,
  dropAccentedLetters,
  classifyNameEvidence,
  rankCandidateUsers,
  buildMatchProposals,
  resolveIdentityField,
  identityColumn,
  NAME_EVIDENCE,
  TRUSTWORTHY_EVIDENCE,
  IDENTITY_FIELDS,
  DEFAULT_IDENTITY_FIELD
};
