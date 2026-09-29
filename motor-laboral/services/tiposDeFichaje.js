// ============================================================================
// Que es cada fichaje del dia (entrada, salida particular, inicio de HE...)
// ============================================================================
//
// Pedido real (2026-09-28): "AGOGLIA hoy tiene 7 fichajes: ¿que tipo es cada
// uno segun el marcador?". El sistema ya lo decide para calcular, pero no lo
// mostraba, y sin ver la interpretacion nadie puede detectar un error.
//
// LA REGLA DE ORO: esto NO interpreta nada por su cuenta. Recibe los eventos
// que YA calculo detectMovements (con las mismas opciones que usan los
// reportes: correcciones de marcadores incluidas) y solo los pega a los
// fichajes. Si mostrara otra logica, la pantalla podria decir una cosa y el
// reporte otra.
//
// Un fichaje puede tener mas de un tipo: el motor detecta cada categoria en
// una pasada propia, asi que el mismo fichaje puede ser "regreso particular"
// e "inicio de horas extra" a la vez. Se muestran los dos.
//
// Funcion pura: sin base de datos (test/tipos-de-fichaje.test.js).

const ETIQUETAS = {
  PARTICULAR: { salida: 'Salida particular', regreso: 'Regreso particular' },
  OFICIAL: { salida: 'Salida oficial', regreso: 'Regreso oficial' },
  HE: { salida: 'Inicio de horas extra', regreso: 'Fin de horas extra' },
  CAMPANA: { salida: 'Salida a campaña', regreso: 'Regreso de campaña' },
};

function etiqueta(categoria, rol) {
  const e = ETIQUETAS[categoria];
  if (e) return e[rol];
  return `${rol === 'salida' ? 'Salida' : 'Regreso'} (${categoria})`;
}

/**
 * @param {object} p
 * @param {string[]} p.fichajes  fichajes REALES del empleado ese dia, 'AAAA-MM-DD HH:MM:SS', en orden
 * @param {{categoria:string, rol:'salida'|'regreso', en:string, marcador:object|null,
 *          sinPar?:boolean, descartado?:string}[]} p.marcas
 *        lo que ya decidio el motor, en el mismo formato de hora que `fichajes`
 * @param {number} [p.reboteSegundos]  dos lecturas propias a menos de esto = repetido
 * @returns {{en:string, hora:string, tipos:object[], base:string}[]}
 *   base: 'Entrada' | 'Salida' | 'Intermedio' | 'Repetido' -- lo que es el
 *   fichaje para la jornada, aparte de cualquier marcador.
 */
function clasificarFichajesDelDia({ fichajes, marcas, reboteSegundos = 20 }) {
  const ordenados = [...fichajes].sort();
  const aSegundos = (s) => {
    const [h, m, sec] = s.slice(11, 19).split(':').map(Number);
    return h * 3600 + m * 60 + sec;
  };
  return ordenados.map((en, i) => {
    let base = 'Intermedio';
    if (i === 0) base = 'Entrada';
    else if (i === ordenados.length - 1) base = 'Salida';
    if (i > 0 && aSegundos(en) - aSegundos(ordenados[i - 1]) <= reboteSegundos) base = 'Repetido';

    const tipos = marcas
      .filter((m) => m.en === en)
      .map((m) => {
        let texto = etiqueta(m.categoria, m.rol);
        if (m.sinPar) texto += m.rol === 'salida' ? ' (sin regreso)' : ' (sin salida registrada)';
        return {
          categoria: m.categoria,
          rol: m.rol,
          texto,
          marcador: m.marcador || null,
          descartado: m.descartado || null,
        };
      });
    return { en, hora: en.slice(11, 16), base, tipos };
  });
}

/**
 * Pasa los eventos de detectMovements al formato de `marcas`.
 * @param {string} categoria
 * @param {{closedEvents, openEvents, orphanReturns}} r  salida de detectMovements
 * @param {string} legajo
 * @param {(date:Date)=>string} fmt  Date -> 'AAAA-MM-DD HH:MM:SS'
 * @param {(ev, rol)=>object|null} marcadorDe  datos del marcador de ese lado del evento
 * @param {(ev)=>string|null} [descarte]  motivo por el que el reporte descarta el evento
 */
function marcasDeEventos(categoria, r, legajo, fmt, marcadorDe, descarte = () => null) {
  const marcas = [];
  for (const ev of r.closedEvents || []) {
    if (ev.employeeId !== legajo || ev.category !== categoria) continue;
    const d = descarte(ev);
    if (ev.timeOut) marcas.push({ categoria, rol: 'salida', en: fmt(ev.timeOut), marcador: marcadorDe(ev, 'salida'), descartado: d });
    if (ev.timeIn) marcas.push({ categoria, rol: 'regreso', en: fmt(ev.timeIn), marcador: marcadorDe(ev, 'regreso'), descartado: d });
  }
  for (const [empId, ev] of (r.openEvents || new Map())) {
    if (empId !== legajo || ev.category !== categoria) continue;
    marcas.push({ categoria, rol: 'salida', en: fmt(ev.timeOut), marcador: marcadorDe(ev, 'salida'), sinPar: true, descartado: descarte({ ...ev, employeeId: empId }) });
  }
  for (const ev of r.orphanReturns || []) {
    if (ev.employeeId !== legajo || ev.category !== categoria) continue;
    marcas.push({ categoria, rol: 'regreso', en: fmt(ev.timeIn), marcador: marcadorDe(ev, 'regreso'), sinPar: true });
  }
  return marcas;
}

module.exports = { clasificarFichajesDelDia, marcasDeEventos, ETIQUETAS };
