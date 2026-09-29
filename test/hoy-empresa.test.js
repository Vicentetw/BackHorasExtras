// "Hoy" segun la zona de la empresa (hoyEmpresa.js). Sin base ni servidor.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fechaEnZona } = require('../motor-laboral/services/hoyEmpresa');

// 28/09 a las 23:35 en Argentina = 29/09 02:35 UTC (el reporte real).
const NOCHE_DEL_28 = new Date('2026-09-29T02:35:00Z');

test('a las 23:35 del 28 en Argentina, hoy sigue siendo el 28 (en UTC ya seria el 29)', () => {
  assert.equal(fechaEnZona('America/Argentina/Buenos_Aires', NOCHE_DEL_28), '2026-09-28');
  assert.equal(fechaEnZona('UTC', NOCHE_DEL_28), '2026-09-29');
});

test('otra empresa en otro pais tiene su propio hoy', () => {
  assert.equal(fechaEnZona('Europe/Madrid', NOCHE_DEL_28), '2026-09-29');
  assert.equal(fechaEnZona('America/Mexico_City', NOCHE_DEL_28), '2026-09-28');
});

test('sin zona o con una zona mal escrita se usa Argentina, sin romper', () => {
  assert.equal(fechaEnZona(null, NOCHE_DEL_28), '2026-09-28');
  assert.equal(fechaEnZona('Marte/Olympus', NOCHE_DEL_28), '2026-09-28');
});
