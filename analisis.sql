-- Análisis de eficiencia de conversaciones - últimas 72h
-- Schema correcto: conversaciones.telefono (NO cliente_telefono)

-- Query 1: Top conversaciones por cantidad de mensajes
SELECT
  telefono,
  COUNT(*) AS total_mensajes,
  SUM(CASE WHEN rol='user' THEN 1 ELSE 0 END) AS msgs_cliente,
  SUM(CASE WHEN rol='assistant' THEN 1 ELSE 0 END) AS msgs_bot,
  MIN(creado_en) AS inicio,
  MAX(creado_en) AS fin
FROM conversaciones
WHERE creado_en > datetime('now', '-3 days')
GROUP BY telefono
HAVING msgs_bot > 0
ORDER BY total_mensajes DESC
LIMIT 30;

-- Query 2: Agregados globales últimas 72h
SELECT
  COUNT(DISTINCT telefono) AS total_conversaciones,
  AVG(cant) AS promedio_msgs_por_conv,
  MAX(cant) AS max_msgs
FROM (
  SELECT telefono, COUNT(*) AS cant
  FROM conversaciones
  WHERE creado_en > datetime('now', '-3 days')
  GROUP BY telefono
);

-- Query 3: Últimos 10 mensajes de las TOP 3 conversaciones más largas
-- (sirve para análisis cualitativo - bot repite info, tool calls duplicados, etc.)
WITH top3 AS (
  SELECT telefono
  FROM conversaciones
  WHERE creado_en > datetime('now', '-3 days')
  GROUP BY telefono
  ORDER BY COUNT(*) DESC
  LIMIT 3
)
SELECT c.telefono, c.rol, c.contenido, c.creado_en
FROM conversaciones c
JOIN top3 ON top3.telefono = c.telefono
WHERE c.id IN (
  SELECT id FROM conversaciones c2
  WHERE c2.telefono = c.telefono
  ORDER BY c2.creado_en DESC
  LIMIT 10
)
ORDER BY c.telefono, c.creado_en ASC;

-- Query 4: ¿Llegó a escalar al vendedor? (asignaciones de las top 3)
WITH top3 AS (
  SELECT telefono
  FROM conversaciones
  WHERE creado_en > datetime('now', '-3 days')
  GROUP BY telefono
  ORDER BY COUNT(*) DESC
  LIMIT 3
)
SELECT a.cliente_telefono, a.cliente_nombre, a.vehiculo_interes,
       a.motivo, a.etapa, a.creado_en
FROM asignaciones a
JOIN top3 ON top3.telefono = a.cliente_telefono
ORDER BY a.creado_en DESC;
