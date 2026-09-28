-- Diagnostico de SOLO LECTURA (AVP, tenant 6).
--
-- Pregunta: ¿cuantas salidas a Campaña (marcador 8) se pierde el sistema por
-- la regla anti-rebote de 20 segundos?
--
-- El caso que lo destapo: OLGUIN (legajo 2555) ficha la entrada, aprieta el
-- marcador 8 y vuelve a fichar ~10 s despues. Para el motor, ese segundo
-- fichaje es un "rebote" de su propia entrada (menos de 20 s entre los dos),
-- asi que NO consume el marcador. Resultado: la salida a campaña nunca se
-- abre y OLGUIN no aparece ni en el reporte de Campaña.
--
-- Por cada marcador 8 se busca el fichaje real que lo consumiria (mismo reloj,
-- dentro de los 6 s de la ventana) y se mira cuanto antes habia fichado esa
-- misma persona. Si fue hace 20 s o menos, el motor lo descarta como rebote.

SELECT
  DATE_FORMAT(x.marcador, '%Y-%m')                              AS mes,
  COUNT(*)                                                      AS salidas_campana,
  SUM(x.seg_desde_fichaje_previo IS NOT NULL
      AND x.seg_desde_fichaje_previo <= 20)                     AS perdidas_por_rebote
FROM (
  SELECT mk.CHECKTIME AS marcador,
         TIMESTAMPDIFF(SECOND,
           (SELECT MAX(p.CHECKTIME) FROM Checkins p
             WHERE p.tenant_id = 6 AND p.USERID = nx.USERID AND p.CHECKTIME < nx.CHECKTIME),
           nx.CHECKTIME) AS seg_desde_fichaje_previo
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
GROUP BY mes
ORDER BY mes;
