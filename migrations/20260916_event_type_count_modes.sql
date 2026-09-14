-- Pedido real: hasta ahora TODA licencia se contaba en dias corridos
-- (diffDaysInclusive, duplicado ademas en el frontend). En la practica
-- Vacaciones/Enfermedad/ART se cuentan corridos, pero motivos como
-- Articulo 55, Permiso particular o Licencia por estudio se cuentan en
-- dias HABILES (lunes a viernes, sin feriados) -- es normal que una
-- misma empresa necesite las dos modalidades al mismo tiempo, una por
-- motivo, no una unica configuracion global.
--
-- Ademas la modalidad de un motivo puede cambiar con el tiempo (una
-- paritaria que pasa de corridos a habiles, por ejemplo) -- por eso esto
-- NO es una columna plana en event_types, es un HISTORIAL de vigencias:
-- "que modalidad rige a partir de tal fecha". Para saber que modalidad
-- aplica en una fecha puntual: la fila con vigente_desde mas reciente
-- que sea <= esa fecha. Sin ninguna fila todavia = 'corridos' (el
-- comportamiento de siempre, cero cambio para lo que ya existe).
--
-- Una licencia que cruza un cambio de vigencia (empezo bajo una regla y
-- termino bajo otra) se cuenta dia por dia: cada dia usa la modalidad
-- vigente ESE dia puntual (ver leaveDaysCalculations.js) -- no hay que
-- elegir "la regla del inicio" ni "la regla del fin", conviven las dos
-- en el mismo calculo sin casos especiales.
--
-- Cambiar la modalidad de un motivo es una accion de configuracion de
-- empresa (mismo permiso que ya protege horarios/tema/limites en
-- horasdedica2.js: settings:update) -- created_by guarda quien lo hizo,
-- para auditoria (paritarias, reclamos futuros de un empleado sobre como
-- se le contaron los dias).
CREATE TABLE IF NOT EXISTS event_type_count_modes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_type_id INT NOT NULL,
  modo ENUM('corridos', 'habiles') NOT NULL,
  vigente_desde DATE NOT NULL,
  created_by INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_etcm_event_type FOREIGN KEY (event_type_id) REFERENCES event_types(id),
  CONSTRAINT fk_etcm_created_by FOREIGN KEY (created_by) REFERENCES app_users(id),
  UNIQUE KEY uq_etcm_event_type_vigencia (event_type_id, vigente_desde)
);

SELECT 'event_type_count_modes aplicada correctamente' AS resultado;
