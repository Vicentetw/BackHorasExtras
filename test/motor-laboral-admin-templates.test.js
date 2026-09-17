// Bug real reportado: "modifico la plantilla de horario y cambio la
// descripción no guarda los cambios" / "no me deja crear una plantilla
// nueva" / 400 en PUT .../blocks/:id ("dayOfWeek, startTime, endTime y
// blockType son requeridos"). Los endpoints de /templates y /blocks nunca
// se probaron via HTTP (los tests existentes de turnos insertan
// shift_blocks directo por SQL, sin pasar por la API) -- por eso este
// desfasaje de nombres de campo (frontend en snake_case: day_of_week,
// start_time, type... vs. backend que esperaba camelCase: dayOfWeek,
// startTime, blockType...) nunca lo agarró ningún test.
require('dotenv').config();
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const BASE = `${BASE_URL}/api/labor-engine/admin`;
const TEST_UID = 'test-motor-laboral-admin-templates';
const TENANT_ID = 999954;

let headers;
const createdTemplateIds = [];

before(async () => {
  await db.query(
    `INSERT INTO tenants (id, name, code) VALUES (?, 'Tenant Templates Admin (test)', 'tenant-templates-admin-test')
     ON DUPLICATE KEY UPDATE name = VALUES(name)`,
    [TENANT_ID]
  );
  headers = await getTestAuthHeaders(TEST_UID, { isSuperadmin: true, tenantId: TENANT_ID });
});

after(async () => {
  for (const id of createdTemplateIds) {
    await db.query('DELETE FROM shift_blocks WHERE template_id = ?', [id]).catch(() => {});
    await db.query('DELETE FROM work_schedule_templates WHERE id = ?', [id]).catch(() => {});
  }
  await db.query('DELETE FROM tenants WHERE id = ?', [TENANT_ID]).catch(() => {});
  await deleteTestUser(TEST_UID);
  await closeDb();
});

test('POST /templates: crea una plantilla nueva con el payload real que manda template-dialog.ts', async () => {
  const res = await fetch(`${BASE}/templates`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Administrativos', description: 'Horario de oficina', type: 'FIXED', active: true, is_default: false, tenant_id: TENANT_ID })
  });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(body.id);
  createdTemplateIds.push(body.id);
});

test('PUT /templates/:id: cambiar la descripción persiste de verdad', async () => {
  const createRes = await fetch(`${BASE}/templates`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sereno', description: 'original', type: 'FLEXIBLE', active: true, is_default: false, tenant_id: TENANT_ID })
  });
  const { id } = await createRes.json();
  createdTemplateIds.push(id);

  const updateRes = await fetch(`${BASE}/templates/${id}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Sereno', description: 'descripcion cambiada', type: 'FLEXIBLE', active: true, is_default: false, tenant_id: TENANT_ID })
  });
  assert.equal(updateRes.status, 200);

  const getRes = await fetch(`${BASE}/templates?tenantId=${TENANT_ID}`, { headers });
  const templates = await getRes.json();
  const found = templates.find((t) => t.id === id);
  assert.equal(found.description, 'descripcion cambiada');
});

test('POST /templates/:id/blocks + PUT /blocks/:id: crear y editar un bloque con el payload real de block-dialog.ts', async () => {
  const createTemplateRes = await fetch(`${BASE}/templates`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Con Bloques', description: null, type: 'FIXED', active: true, is_default: false, tenant_id: TENANT_ID })
  });
  const { id: templateId } = await createTemplateRes.json();
  createdTemplateIds.push(templateId);

  // Payload EXACTO que manda templates-page.ts al crear (spread de
  // block-dialog.ts + day_of_week explicito por dia).
  const createBlockRes = await fetch(`${BASE}/templates/${templateId}/blocks`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      day_of_week: 1,
      name: 'Turno mañana',
      start_time: '07:00',
      end_time: '13:40',
      type: 'WORK',
      crosses_midnight: false,
      active: true
    })
  });
  const createBlockBody = await createBlockRes.json();
  assert.equal(createBlockRes.status, 200, JSON.stringify(createBlockBody));
  assert.ok(createBlockBody.id);
  const blockId = createBlockBody.id;

  // GET debe devolver "name"/"type" (no block_name/block_type crudos) --
  // si no, la tabla de bloques en /plantillas-horario los muestra vacíos.
  const getBlocksRes = await fetch(`${BASE}/templates/${templateId}/blocks`, { headers });
  const blocks = await getBlocksRes.json();
  const created = blocks.find((b) => b.id === blockId);
  assert.ok(created, 'el bloque recien creado debe aparecer en el listado');
  assert.equal(created.name, 'Turno mañana');
  assert.equal(created.type, 'WORK');
  assert.equal(created.day_of_week, 1);

  // PUT (editar un bloque existente) -- payload real de block-dialog.ts
  // save(), incluyendo day_of_week (bug real: antes no se mandaba al editar).
  const updateBlockRes = await fetch(`${BASE}/blocks/${blockId}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      day_of_week: 2,
      name: 'Turno mañana (editado)',
      start_time: '08:00',
      end_time: '14:00',
      type: 'WORK',
      crosses_midnight: false,
      active: true
    })
  });
  const updateBlockBody = await updateBlockRes.json();
  assert.equal(updateBlockRes.status, 200, JSON.stringify(updateBlockBody));

  const getBlocksAfterRes = await fetch(`${BASE}/templates/${templateId}/blocks`, { headers });
  const blocksAfter = await getBlocksAfterRes.json();
  const updated = blocksAfter.find((b) => b.id === blockId);
  assert.equal(updated.name, 'Turno mañana (editado)');
  assert.equal(updated.day_of_week, 2);
  assert.equal(updated.start_time.slice(0, 5), '08:00');
});
