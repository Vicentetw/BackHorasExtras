// Bug real de seguridad (auditoria general): las 4 rutas de
// routes/import.routes.js no tenian NINGUN requirePermission -- a
// diferencia del alta individual (routes/employees.js, que exige
// 'employees:create'), cualquier usuario autenticado con CUALQUIER
// permiso (o ninguno de empleados) podia subir/confirmar un import
// masivo de empleados.
require('dotenv').config();
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { getTestAuthHeaders, deleteTestUser, closeDb } = require('../test-helpers/firebaseTestAuth');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';
const UID = 'test-import-permission-guard';

after(async () => {
  await deleteTestUser(UID);
  await closeDb();
});

test('sin employees:create: las 4 rutas de /api/import/employees* responden 403', async () => {
  // Un permiso cualquiera que NO sea employees:create -- confirma que el
  // gate es especifico, no "cualquier permiso alcanza".
  const headers = await getTestAuthHeaders(UID, { isSuperadmin: false, tenantId: 4, permissions: ['attendance:read'] });

  const upload = await fetch(`${BASE_URL}/api/import/employees/upload`, { method: 'POST', headers });
  assert.equal(upload.status, 403, 'POST /employees/upload debe exigir employees:create');

  const post = await fetch(`${BASE_URL}/api/import/employees`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ employees: [{ employee_id: '999999', nombre: 'No debería crearse' }] }),
  });
  assert.equal(post.status, 403, 'POST /employees debe exigir employees:create');

  const preview = await fetch(`${BASE_URL}/api/import/employees/preview/123`, { headers });
  assert.equal(preview.status, 403, 'GET /employees/preview/:batchId debe exigir employees:create');

  const confirm = await fetch(`${BASE_URL}/api/import/employees/confirm/123`, { method: 'POST', headers });
  assert.equal(confirm.status, 403, 'POST /employees/confirm/:batchId debe exigir employees:create');
});
