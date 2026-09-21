// ARCHIVO VACIADO A PROPOSITO (2026-09-20).
//
// Aca vivian 7 tests de GET /api/matching/suspicious y POST
// /api/matching/repair. Los dos endpoints se quitaron el mismo dia que se
// escribieron, porque el diagnostico que los motivaba era FALSO.
//
// Se creia que los fichajes de ~100 empleados no llegaban a ningun informe.
// No era cierto: /attendance-range resuelve cada fichaje con
//
//     (u.USERID = c.USERID OR u.Badgenumber = c.USERID)
//
// (horasdedica.js:3109), y ese OR alcanza para que lleguen igual. Verificado
// contra produccion: las 52 fichadas de septiembre del legajo 9412 dan
// exactamente los 13 dias que muestra Presentismo.
//
// Los tests pasaban todos. El problema no estaba en el codigo que probaban
// sino en la premisa: probaban muy bien una funcion que no habia que
// construir. Un test verde no valida que el problema exista.
//
// Lo que SI hacia falta -- avisar cuando alguien ficha y no esta en la lista
// activa -- vive ahora en GET /api/matching/punching-not-listed, y sus
// reglas estan probadas en test/matching-rules.test.js (classifyPuncher).
// El primero de esos tests es justamente el que faltaba aca: verificar que
// NO se avise por alguien cuyas fichadas ya llegan bien.
//
// El archivo se deja vacio en vez de borrarse porque el historial de git
// conserva igual lo que decia, y esta nota le ahorra a quien venga despues
// la pregunta "¿y esto por que se fue?".
