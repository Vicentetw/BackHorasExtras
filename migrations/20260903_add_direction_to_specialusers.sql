-- specialusers.direction distingue, para un marcador de Salida/Entrada
-- particular (o cualquier categoria con salida/regreso), si esa fila
-- representa la SALIDA o el REGRESO. Se usaba desde hace tiempo en el
-- codigo (fetchMarkerMap, alta/edicion de usuarios especiales) pero nunca
-- quedo una migracion guardada para esta columna -- se agrego a mano en
-- la base local de desarrollo en algun momento y se perdio el registro.
-- Sin esta columna, /movements-range (pantalla Salidas) falla con
-- ER_BAD_FIELD_ERROR.

ALTER TABLE specialusers
  ADD COLUMN direction ENUM('SALIDA','REGRESO') NULL AFTER category;
