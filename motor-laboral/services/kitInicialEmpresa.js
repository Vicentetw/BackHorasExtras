// Kit inicial de una empresa nueva (AISLAMIENTO_POR_EMPRESA.md, G).
//
// Por que: cada empresa tiene que ser DUEÑA de sus valores desde el primer
// dia. Si una empresa nueva dependiera de valores "de la plataforma", un
// cambio futuro en esos valores le moveria los calculos (vacaciones, cortes
// de liquidacion) a clientes que no pidieron nada. Con el kit, lo que
// recibe al nacer queda guardado como suyo, y lo edita su administrador.
//
// Que recibe:
//   * la escala de vacaciones de la Ley de Contrato de Trabajo (art. 150);
//   * el regimen de pago mensual (cortes de quincena 1 y 16, semana desde
//     el lunes), el mismo valor por defecto que ya usaba el sistema.
//
// Nunca hace fallar el alta: si una tabla no existe todavia (migracion
// pendiente) o algo falla, se registra y se sigue. La empresa igual funciona
// con los valores por defecto del codigo, que son los mismos.
const ESCALA_LCT = [
  [0, 5, 14],
  [5, 10, 21],
  [10, 20, 28],
  [20, null, 35]
];

async function darKitInicial(db, tenantId) {
  const pasos = [
    async () => {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM vacation_scale WHERE tenant_id = ?', [tenantId]);
      if (n > 0) return;
      for (const [min, max, dias] of ESCALA_LCT) {
        await db.query('INSERT INTO vacation_scale (tenant_id, min_years, max_years, days) VALUES (?, ?, ?, ?)', [tenantId, min, max, dias]);
      }
    },
    async () => {
      const [[{ n }]] = await db.query('SELECT COUNT(*) AS n FROM payroll_regime_settings WHERE tenant_id = ?', [tenantId]);
      if (n > 0) return;
      await db.query(
        `INSERT INTO payroll_regime_settings (tenant_id, regime, week_start_day, biweekly_cut_day1, biweekly_cut_day2)
         VALUES (?, 'monthly', 1, 1, 16)`,
        [tenantId]
      );
    }
  ];
  for (const paso of pasos) {
    try {
      await paso();
    } catch (err) {
      console.error(`Kit inicial de la empresa ${tenantId}: un paso fallo y se omite (${err.code || err.message})`);
    }
  }
}

module.exports = { darKitInicial, ESCALA_LCT };
