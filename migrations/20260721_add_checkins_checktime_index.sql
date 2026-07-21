-- Indice dedicado para rangos de fecha sobre Checkins.CHECKTIME.
-- Ya existia un indice compuesto (USERID, CHECKTIME) pero con USERID como
-- columna lider no sirve para las consultas de /attendance-range, el motor
-- diario y los reportes legacy, que filtran por CHECKTIME solo (o CHECKTIME
-- + USERID especifico en un join), sin fijar USERID de antemano.
-- Confirmado con EXPLAIN contra produccion: antes de este cambio de codigo,
-- la query de /attendance-range escaneaba las 129043 filas de la tabla
-- entera (type: ALL, key: null) para traer un solo mes.
ALTER TABLE Checkins ADD INDEX idx_checkins_checktime (CHECKTIME);
