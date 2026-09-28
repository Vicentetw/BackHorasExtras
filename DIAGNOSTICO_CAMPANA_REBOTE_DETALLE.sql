-- Diagnostico de SOLO LECTURA (AVP, tenant 6). Sigue a DIAGNOSTICO_CAMPANA_REBOTE.sql.
--
-- Las 79 salidas a campaña perdidas por la regla de rebote, una por una, para
-- elegir con datos la regla que las recupere SIN volver a romper el caso
-- SANTIBAÑEZ (18/08/2026 13:37).
--
-- Columnas clave:
--   seg_1ra_a_marcador : cuanto despues de su 1ra lectura se apreto el marcador
--   seg_marcador_a_2da : cuanto despues del marcador llego su 2da lectura
--   horas_hasta_proximo: cuanto tardo esa persona en volver a fichar.
--       Una salida a campaña REAL deja dias sin fichar (OLGUIN: 12 dias).
--       Si vuelve a fichar el mismo dia (SANTIBAÑEZ: 16:49), no se fue.
--   mismo_reloj_1ra    : si la 1ra lectura fue en el mismo aparato que el marcador.

SELECT x.persona, x.lectura_1, x.marcador, x.lectura_2,
       TIMESTAMPDIFF(SECOND, x.lectura_1, x.marcador)  AS seg_1ra_a_marcador,
       TIMESTAMPDIFF(SECOND, x.marcador, x.lectura_2)  AS seg_marcador_a_2da,
       ROUND(TIMESTAMPDIFF(MINUTE, x.lectura_2,
         (SELECT MIN(n.CHECKTIME) FROM Checkins n
           WHERE n.tenant_id = 6 AND n.USERID = x.persona AND n.CHECKTIME > x.lectura_2
             AND n.CHECKTIME > x.lectura_2 + INTERVAL 60 SECOND)) / 60, 1) AS horas_hasta_proximo,
       (x.ip_1 <=> x.ip_marcador) AS mismo_reloj_1ra
FROM (
  SELECT nx.USERID AS persona, mk.CHECKTIME AS marcador, nx.CHECKTIME AS lectura_2,
         mk.MACHINE_IP AS ip_marcador,
         (SELECT MAX(p.CHECKTIME) FROM Checkins p
           WHERE p.tenant_id = 6 AND p.USERID = nx.USERID AND p.CHECKTIME < nx.CHECKTIME) AS lectura_1,
         (SELECT p.MACHINE_IP FROM Checkins p
           WHERE p.tenant_id = 6 AND p.USERID = nx.USERID AND p.CHECKTIME < nx.CHECKTIME
           ORDER BY p.CHECKTIME DESC LIMIT 1) AS ip_1
  FROM Checkins mk
  JOIN Checkins nx
    ON nx.tenant_id = 6
   AND nx.USERID NOT BETWEEN 2 AND 10
   AND nx.CHECKTIME >  mk.CHECKTIME
   AND nx.CHECKTIME <= mk.CHECKTIME + INTERVAL 6 SECOND
   AND (mk.MACHINE_IP IS NULL OR nx.MACHINE_IP IS NULL OR nx.MACHINE_IP = mk.MACHINE_IP)
  WHERE mk.tenant_id = 6 AND mk.USERID = 8
    AND mk.CHECKTIME >= '2026-01-01'
) x
WHERE TIMESTAMPDIFF(SECOND, x.lectura_1, x.lectura_2) <= 20
ORDER BY x.marcador;

-- Y el caso SANTIBAÑEZ tal como esta en la base, con el reloj de cada fichaje:
SELECT 'SANTIBANEZ 18/08' AS bloque, c.USERID, c.CHECKTIME, c.MACHINE_IP
FROM Checkins c
WHERE c.tenant_id = 6
  AND c.CHECKTIME BETWEEN '2026-08-18 13:37:00' AND '2026-08-18 13:38:00'
ORDER BY c.CHECKTIME;
