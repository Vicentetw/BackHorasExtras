#!/usr/bin/env bash
# ============================================================================
# Regenera los dos archivos que usa el CI para armar su base de prueba
# ============================================================================
#
#   schema/estructura_AAAAMMDD.sql  estructura de la base, sin datos
#   schema/datos_base_ci.sql        catalogos globales + empresas de prueba
#
# Se sacan de la base LOCAL (contenedor Docker `mysql_local`, la misma de los
# tests), que tiene que tener TODAS las migraciones aplicadas. AAAAMMDD es la
# fecha de la ultima migracion: el CI aplica encima solo las posteriores.
#
# Uso (desde la raiz del repo, en Git Bash):
#   bash scripts/generar-esquema-ci.sh
#
# Despues: borrar el schema/estructura_*.sql anterior y commitear los dos.
# ============================================================================
set -euo pipefail

CONTENEDOR=mysql_local
PW=$(grep '^MYSQL_ADDON_PASSWORD=' .env | cut -d= -f2-)
BASE=$(grep '^MYSQL_ADDON_DB=' .env | cut -d= -f2-)
ULTIMA=$(ls migrations | grep -E '^[0-9]{8}_' | sort | tail -1 | cut -c1-8)
SALIDA="schema/estructura_${ULTIMA}.sql"

dump() { docker exec "$CONTENEDOR" mysqldump -uroot -p"$PW" --skip-comments --skip-dump-date --set-gtid-purged=OFF "$@" "$BASE" 2>/dev/null; }

{
  echo "-- Estructura de la base (SIN datos) para el CI -- GENERADO con scripts/generar-esquema-ci.sh"
  echo "-- Incluye las migraciones hasta ${ULTIMA}. Ver .github/workflows/ci.yml."
  echo
  dump --no-data --routines --triggers | sed -E 's/ AUTO_INCREMENT=[0-9]+//'
} > "$SALIDA.tmp"

ROLES=$(docker exec "$CONTENEDOR" mysql -uroot -p"$PW" -N "$BASE" -e "SELECT GROUP_CONCAT(id) FROM roles WHERE is_system=1" 2>/dev/null)
{
  sed -n '1,/^INSERT INTO `tenants` (id, name, code) VALUES (6/p' schema/datos_base_ci.sql
  dump --no-create-info --compact --skip-extended-insert roles --where="is_system=1"
  dump --no-create-info --compact --skip-extended-insert role_permissions --where="role_id IN ($ROLES)"
  dump --no-create-info --compact --skip-extended-insert plans
} > schema/datos_base_ci.sql.tmp

mv "$SALIDA.tmp" "$SALIDA"
mv schema/datos_base_ci.sql.tmp schema/datos_base_ci.sql
echo "Generados $SALIDA y schema/datos_base_ci.sql ($(grep -c '^CREATE TABLE' "$SALIDA") tablas)"
