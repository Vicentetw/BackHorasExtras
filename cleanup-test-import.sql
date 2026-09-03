-- Limpieza de los 2 registros de prueba (USERID 999999) insertados al
-- verificar que /import/checkins y /import/users funcionan en produccion.
-- Seguro de correr una sola vez; no toca ningun dato real.
DELETE FROM Checkins WHERE USERID = 999999;
DELETE FROM users WHERE USERID = 999999;
