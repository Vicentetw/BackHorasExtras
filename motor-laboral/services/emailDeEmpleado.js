// Mail de un empleado (employees.email, migracion 20261010).
//
// Es OPCIONAL: sirve para invitarlo al portal del empleado. Se puede cargar
// desde dos pantallas (el formulario del empleado y Portal del empleado), y
// las dos pasan por aca para responder igual.
//
// Reglas:
//   * dos empleados de la MISMA empresa no pueden compartir mail: el mail es
//     con lo que cada uno inicia sesion, asi que tiene que identificar a una
//     sola persona. Al chocar se devuelve QUIEN lo tiene (id, legajo y
//     nombre) para que la pantalla ofrezca abrir su ficha;
//   * si el empleado ya tiene cuenta, el mail no se cambia en silencio: el
//     mail de ingreso es el de la cuenta.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ErrorDeEmail extends Error {
  constructor(status, mensaje, extra = {}) { super(mensaje); this.status = status; this.extra = extra; }
}

const normalizar = (email) => String(email ?? '').trim().toLowerCase();

/**
 * Formato y duplicado, SIN guardar. Sirve para avisar antes de crear un
 * empleado nuevo. `exceptoId`: el propio empleado, al editar.
 * @returns {Promise<string>} el mail normalizado ('' si vino vacio)
 */
async function verificarEmailDeEmpleado(db, { tenantId, email, exceptoId = 0 }) {
  const mail = normalizar(email);
  if (!mail) return '';
  if (!EMAIL.test(mail)) throw new ErrorDeEmail(400, 'Ese mail no parece válido.');
  try {
    const [[otro]] = await db.query(
      `SELECT id, employee_id AS legajo, nombre FROM employees
       WHERE tenant_id <=> ? AND LOWER(email) = ? AND id <> ? LIMIT 1`, [tenantId, mail, exceptoId || 0]);
    if (otro) {
      throw new ErrorDeEmail(409, `Ese mail ya lo tiene ${otro.nombre} (legajo ${otro.legajo}).`,
        { duplicado: { id: otro.id, legajo: otro.legajo, nombre: otro.nombre } });
    }
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err; // sin la columna no hay duplicados posibles
  }
  return mail;
}

/**
 * Valida y guarda el mail de un empleado. `email` vacio lo borra.
 * @returns {Promise<{email:string|null, guardado:boolean, aviso?:string}>}
 * @throws {ErrorDeEmail} 400 (formato), 409 (duplicado o ya tiene cuenta)
 */
async function guardarEmailDeEmpleado(db, { tenantId, employeeId, email }) {
  const mail = normalizar(email);
  if (mail && !EMAIL.test(mail)) throw new ErrorDeEmail(400, 'Ese mail no parece válido.');
  try {
    const [[actual]] = await db.query('SELECT email FROM employees WHERE id = ?', [employeeId]);
    if (normalizar(actual && actual.email) === mail) return { email: mail || null, guardado: false };

    await verificarEmailDeEmpleado(db, { tenantId, email: mail, exceptoId: employeeId });
    const [[cuenta]] = await db.query('SELECT id, email FROM app_users WHERE employee_id = ?', [employeeId]);
    if (cuenta) {
      throw new ErrorDeEmail(409, `Ya tiene cuenta en el portal (ingresa con ${cuenta.email}). El mail de ingreso no se cambia desde acá.`);
    }
    await db.query('UPDATE employees SET email = ? WHERE id = ?', [mail || null, employeeId]);
    return { email: mail || null, guardado: true };
  } catch (err) {
    // Backend publicado antes que la migracion 20261010: la columna no existe.
    // Guardar el resto del empleado no puede fallar por esto.
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      return { email: null, guardado: false, ...(mail ? { aviso: 'El mail no se guardó: falta correr la migración 20261010 (portal del empleado).' } : {}) };
    }
    throw err;
  }
}

module.exports = { guardarEmailDeEmpleado, verificarEmailDeEmpleado, ErrorDeEmail, normalizar };
