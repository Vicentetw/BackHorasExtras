// Asistente para crear horarios (2026-10-09, pedido del dueño: "a prueba de
// tontos"). La pantalla pregunta en castellano llano (¿corrido, cortado o
// rotativo? ¿qué días? ¿a qué hora entra y sale?) y manda TODO junto; acá se
// valida y se traduce a lo que ya existe: una plantilla con bloques por día
// de la semana, o una plantilla rotativa con sus turnos y su ciclo.
//
// Funciones puras (sin base de datos): las usa POST /templates/asistente
// (motor-laboral/routes/admin.js) y se prueban solas en
// test/asistente-horario.test.js.
//
// Reglas que valen para cualquier empresa (no son de AVP):
//  - una hora es HH:MM; un tramo no empieza y termina a la misma hora;
//  - los tramos de un día van en orden y sin pisarse;
//  - solo el último tramo del día puede terminar al día siguiente;
//  - nadie trabaja más de 20 horas en un día de su horario.

const HORA_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MAX_MINUTOS_DIA = 20 * 60;

const aMin = (h) => Number(h.slice(0, 2)) * 60 + Number(h.slice(3, 5));
const cruza = (t) => t.fin <= t.inicio;
const duracion = (t) => (cruza(t) ? 24 * 60 - aMin(t.inicio) + aMin(t.fin) : aMin(t.fin) - aMin(t.inicio));

class ErrorAsistente extends Error {}

// Tramos de un día: [{ inicio, fin }]. Devuelve los tramos limpios o lanza
// ErrorAsistente con un mensaje para mostrarle al usuario tal cual.
function validarTramos(tramos, donde) {
  if (!Array.isArray(tramos) || tramos.length < 1) throw new ErrorAsistente(`${donde}: falta el horario`);
  if (tramos.length > 4) throw new ErrorAsistente(`${donde}: como mucho 4 partes por día`);
  const limpios = tramos.map((t) => ({ inicio: String(t && t.inicio || '').slice(0, 5), fin: String(t && t.fin || '').slice(0, 5) }));
  limpios.forEach((t) => {
    if (!HORA_RE.test(t.inicio) || !HORA_RE.test(t.fin)) throw new ErrorAsistente(`${donde}: completá la hora de entrada y de salida`);
    if (t.inicio === t.fin) throw new ErrorAsistente(`${donde}: la entrada y la salida no pueden ser la misma hora`);
  });
  for (let i = 1; i < limpios.length; i++) {
    const ant = limpios[i - 1];
    if (cruza(ant)) throw new ErrorAsistente(`${donde}: solo la última parte del día puede terminar al día siguiente`);
    if (limpios[i].inicio < ant.fin) {
      throw new ErrorAsistente(`${donde}: la parte ${i + 1} (${limpios[i].inicio}) empieza antes de que termine la anterior (${ant.fin})`);
    }
  }
  const total = limpios.reduce((s, t) => s + duracion(t), 0);
  if (total > MAX_MINUTOS_DIA) throw new ErrorAsistente(`${donde}: suma más de 20 horas; revisá las horas (¿AM y PM al revés?)`);
  return limpios;
}

// Horario semanal: [{ dia: 0..6, tramos }]. Al menos un día.
function validarSemana(semana) {
  if (!Array.isArray(semana) || semana.length === 0) throw new ErrorAsistente('Elegí al menos un día de trabajo');
  const vistos = new Set();
  return semana.map((d) => {
    const dia = Number(d && d.dia);
    if (!Number.isInteger(dia) || dia < 0 || dia > 6) throw new ErrorAsistente('Día de la semana inválido');
    if (vistos.has(dia)) throw new ErrorAsistente(`El ${DIAS[dia]} está repetido`);
    vistos.add(dia);
    // descanso_sin_fichar: horario cortado en el que la persona NO ficha al
    // mediodía (2 fichadas por día). Se guarda como una sola jornada de
    // trabajo de punta a punta + la pausa como descanso (informativa).
    const tramos = validarTramos(d.tramos, `El ${DIAS[dia]}`);
    const sinFicharPausa = !!d.descanso_sin_fichar && tramos.length === 2;
    return { dia, tramos, sinFicharPausa };
  }).sort((a, b) => a.dia - b.dia);
}

// Bloques (shift_blocks) de un día del horario semanal.
function bloquesDelDia(d) {
  const nombres = d.tramos.length === 2 ? ['Mañana', 'Tarde'] : d.tramos.map((_, i) => (d.tramos.length === 1 ? 'Jornada' : `Parte ${i + 1}`));
  if (d.sinFicharPausa) {
    const [a, b] = d.tramos;
    return [
      { day_of_week: d.dia, block_name: 'Jornada', start_time: a.inicio, end_time: b.fin, block_type: 'WORK', crosses_midnight: cruza({ inicio: a.inicio, fin: b.fin }) ? 1 : 0 },
      { day_of_week: d.dia, block_name: 'Pausa', start_time: a.fin, end_time: b.inicio, block_type: 'BREAK', crosses_midnight: 0 },
    ];
  }
  return d.tramos.map((t, i) => ({
    day_of_week: d.dia, block_name: nombres[i], start_time: t.inicio, end_time: t.fin, block_type: 'WORK', crosses_midnight: cruza(t) ? 1 : 0,
  }));
}

// Rotativo: turnos [{ clave, id?, nombre, tramos }] (id = turno ya existente)
// y ciclo [clave|null, ...] (un elemento por día; null = franco).
function validarRotativo(rotativo) {
  const turnos = Array.isArray(rotativo && rotativo.turnos) ? rotativo.turnos : [];
  const ciclo = Array.isArray(rotativo && rotativo.ciclo) ? rotativo.ciclo : [];
  if (ciclo.length < 2 || ciclo.length > 60) throw new ErrorAsistente('El ciclo tiene que durar entre 2 y 60 días');
  const porClave = new Map();
  const nombres = new Set();
  turnos.forEach((t) => {
    const clave = String(t && t.clave || '');
    if (!clave || porClave.has(clave)) throw new ErrorAsistente('Turno repetido o sin identificar');
    if (t.id != null) { porClave.set(clave, { clave, id: Number(t.id) }); return; }
    const nombre = String(t.nombre || '').trim();
    if (!nombre || nombre.length > 60) throw new ErrorAsistente('Cada turno nuevo necesita un nombre (hasta 60 letras)');
    if (nombres.has(nombre.toLowerCase())) throw new ErrorAsistente(`Hay dos turnos que se llaman "${nombre}"`);
    nombres.add(nombre.toLowerCase());
    porClave.set(clave, { clave, nombre, tramos: validarTramos(t.tramos, `El turno "${nombre}"`) });
  });
  const dias = ciclo.map((c, i) => {
    if (c == null || c === '') return null;
    if (!porClave.has(String(c))) throw new ErrorAsistente(`El día ${i + 1} del ciclo usa un turno que no existe`);
    return String(c);
  });
  if (!dias.some((d) => d != null)) throw new ErrorAsistente('El ciclo necesita al menos un día de trabajo');
  return { turnos: [...porClave.values()].filter((t) => dias.includes(t.clave)), dias };
}

// Mismos tramos (para reutilizar un turno ya cargado con el mismo nombre).
const mismosTramos = (a, b) => a.length === b.length && a.every((t, i) => t.inicio === String(b[i].inicio).slice(0, 5) && t.fin === String(b[i].fin).slice(0, 5));

module.exports = { validarTramos, validarSemana, bloquesDelDia, validarRotativo, mismosTramos, ErrorAsistente, cruza, duracion };
