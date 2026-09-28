-- Diagnostico de SOLO LECTURA: OLGUIN (legajo 2555, empresa AVP = tenant 6).
-- Pregunta: en los dias 01, 03, 15, 17, 29 y 31 de agosto 2026, ¿alguien
-- ficho un MARCADOR (badges 2 a 10) justo antes de cada fichaje de OLGUIN?
--
-- Como el marcador no dice de quien es, el sistema se lo atribuye al PRIMER
-- fichaje real que llegue despues, siempre que llegue dentro de la ventana
-- (markerMaxGapSeconds, hoy 6 s para AVP). Por eso se buscan marcadores en
-- los 120 s previos y se muestra la distancia: <= 6 s significa que el
-- sistema SI lo toma como marcador de ese fichaje.

-- 1) Con que USERID(s) del reloj ficha OLGUIN
SELECT 'USERID de OLGUIN' AS bloque, u.USERID, u.Badgenumber, u.Name, e.employee_id AS legajo
FROM employees e
JOIN user_employee_map m ON m.employee_id = e.id AND m.tenant_id = e.tenant_id
JOIN users u ON u.USERID = m.USERID AND u.tenant_id = m.tenant_id
WHERE e.tenant_id = 6 AND e.employee_id = '2555';

-- 2) Cada fichaje de OLGUIN en esos dias + el marcador mas cercano en los 120 s previos
SELECT 'fichaje OLGUIN + marcador previo' AS bloque,
       c.CHECKTIME                                   AS fichaje_olguin,
       c.MACHINE_IP                                  AS reloj_olguin,
       mk.USERID                                     AS badge_marcador,
       su.name                                       AS marcador,
       mk.CHECKTIME                                  AS hora_marcador,
       mk.MACHINE_IP                                 AS reloj_marcador,
       TIMESTAMPDIFF(SECOND, mk.CHECKTIME, c.CHECKTIME) AS segundos_antes
FROM Checkins c
LEFT JOIN Checkins mk
       ON mk.tenant_id = c.tenant_id
      AND mk.USERID BETWEEN 2 AND 10
      AND mk.CHECKTIME <= c.CHECKTIME
      AND mk.CHECKTIME >= c.CHECKTIME - INTERVAL 120 SECOND
LEFT JOIN specialusers su ON su.userId = mk.USERID AND su.tenant_id = mk.tenant_id
WHERE c.tenant_id = 6
  AND c.USERID IN (
        SELECT m.USERID FROM user_employee_map m
        JOIN employees e ON e.id = m.employee_id AND e.tenant_id = m.tenant_id
        WHERE e.tenant_id = 6 AND e.employee_id = '2555'
        UNION SELECT 2555)
  AND DATE(c.CHECKTIME) IN ('2026-08-01','2026-08-03','2026-08-15',
                            '2026-08-17','2026-08-29','2026-08-31')
ORDER BY c.CHECKTIME, mk.CHECKTIME;
