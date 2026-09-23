# ============================================================================
# Exporta SOLO la estructura de la base (sin datos)
# ============================================================================
#
# PARA QUE SIRVE
# --------------
# Para crear una instalacion nueva y VACIA del sistema: otro servidor, otra
# base, cero empleados y cero fichajes. Es el paso 2 del instructivo
# REPLICAR_INSTALACION.md.
#
# POR QUE NO SE USA schema/full_schema_snapshot.sql
# -------------------------------------------------
# Porque quedo viejo. Verificado el 2026-09-22: declara 42 tablas y la base
# real tiene 51 -- le faltan ciudades, sucursales, day_type_overtime_rules,
# employee_convention_assignments, event_type_count_modes, manual_entry_log,
# manual_checkin_log, user_exclusion_log, rule_engine_shadow_diffs y
# work_schedule_template_config_history. Un archivo de esquema escrito a mano
# se desactualiza sin que nadie se entere; la base real, no. Por eso la
# estructura se saca de la base y no de un archivo.
#
# POR QUE TAMPOCO SE CORREN LAS 48 MIGRACIONES SOBRE UNA BASE VACIA
# ------------------------------------------------------------------
# Se podria, pero son 48 archivos escritos a lo largo de meses, varios pensados
# para modificar tablas que ya existian con datos adentro. Cualquiera de ellos
# que asuma algo del estado anterior falla o deja la base a medias, y hay que
# depurarlo justo cuando uno esta poniendo en marcha un cliente. La estructura
# de la base que YA funciona es, por definicion, el resultado correcto de
# haberlas corrido todas.
#
# USO
#   .\scripts\exportar-estructura.ps1
#   .\scripts\exportar-estructura.ps1 -Destino "D:\instalacion-nueva"
#
# COMO SE CARGA EN LA BASE NUEVA
#   1. crear la base vacia en el servidor nuevo
#   2. mysql -h HOST -P PUERTO -u USUARIO -p BASE < estructura-....sql
#   3. verificar:  SELECT COUNT(*) FROM information_schema.TABLES
#                  WHERE TABLE_SCHEMA = 'BASE';   -- tiene que dar lo mismo
#                                                 -- que informo este script
# ============================================================================

param(
  [string]$Destino = "$env:USERPROFILE\Backups\HorasDedica",
  [string]$EnvFile = "$PSScriptRoot\..\motor-laboral\.env"
)

$ErrorActionPreference = 'Stop'

function Buscar-MysqlDump {
  $enPath = (Get-Command mysqldump -ErrorAction SilentlyContinue).Source
  if ($enPath) { return $enPath }
  # Se prefiere el de MySQL (no el de MariaDB que trae XAMPP): la base es
  # MySQL 8.4 y los dumps de MariaDB pueden traer sintaxis incompatible.
  $candidatos = @(
    'C:\Program Files\MySQL\MySQL Workbench 8.0\mysqldump.exe',
    'C:\Program Files\MySQL\MySQL Server 8.0\bin\mysqldump.exe',
    'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe'
  )
  foreach ($c in $candidatos) { if (Test-Path $c) { return $c } }
  throw "No se encontro mysqldump. Instalalo o agregalo al PATH."
}

function Leer-Env([string]$ruta) {
  if (-not (Test-Path $ruta)) { throw "No existe el archivo de credenciales: $ruta" }
  $d = @{}
  foreach ($linea in Get-Content $ruta) {
    if ($linea -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
      $d[$matches[1]] = $matches[2].Trim().Trim('"').Trim("'")
    }
  }
  return $d
}

Write-Host "=== Estructura de la base (sin datos) ===" -ForegroundColor Cyan

$dump = Buscar-MysqlDump
$cfg  = Leer-Env $EnvFile

foreach ($k in @('MYSQL_ADDON_HOST','MYSQL_ADDON_USER','MYSQL_ADDON_PASSWORD','MYSQL_ADDON_DB')) {
  if (-not $cfg[$k]) { throw "Falta $k en $EnvFile" }
}
$puerto = if ($cfg['MYSQL_ADDON_PORT']) { $cfg['MYSQL_ADDON_PORT'] } else { '3306' }

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
$sello = Get-Date -Format 'yyyy-MM-dd_HHmm'
$sql   = Join-Path $Destino "estructura-$($cfg['MYSQL_ADDON_DB'])-$sello.sql"

Write-Host "Base:    $($cfg['MYSQL_ADDON_DB']) en $($cfg['MYSQL_ADDON_HOST'])"
Write-Host "Destino: $sql"
Write-Host ""
Write-Host "Exportando la estructura..."

# --no-data: NINGUNA fila. Es lo que hace que la instalacion nueva nazca
#   vacia, sin un solo empleado ni fichaje de otro cliente.
# --skip-add-drop-table: sin esto el archivo empieza cada tabla con
#   DROP TABLE IF EXISTS. Si alguien lo corre por error contra una base con
#   datos, los borra todos. Un archivo que solo CREA no puede destruir nada.
# --no-tablespaces: el usuario de una base gestionada no tiene el permiso
#   PROCESS que mysqldump pide para los tablespaces (ver backup-produccion.ps1).
# --routines --triggers --events: verificado el 2026-09-22 que esta base no
#   tiene ninguno de los tres, pero se incluyen igual por si se agregan
#   despues -- que el dia que aparezca un trigger, este script ya lo traiga.
$env:MYSQL_PWD = $cfg['MYSQL_ADDON_PASSWORD']
try {
  & $dump `
    --host=$($cfg['MYSQL_ADDON_HOST']) `
    --port=$puerto `
    --user=$($cfg['MYSQL_ADDON_USER']) `
    --no-data `
    --skip-add-drop-table `
    --routines --triggers --events `
    --no-tablespaces `
    --default-character-set=utf8mb4 `
    --result-file="$sql" `
    $cfg['MYSQL_ADDON_DB'] 2>&1 | ForEach-Object { if ($_ -notmatch 'Using a password') { $_ } }
  $codigo = $LASTEXITCODE
} finally {
  Remove-Item Env:\MYSQL_PWD -ErrorAction SilentlyContinue
}

if ($codigo -ne 0) {
  if (Test-Path $sql) { Remove-Item $sql -Force }
  throw "mysqldump fallo (codigo $codigo). No se genero nada."
}

# Misma verificacion que el backup: un archivo truncado tiene tamanio y
# aspecto de estar bien, y solo se descubre el dia que hace falta.
$ultimas = Get-Content $sql -Tail 5 -ErrorAction SilentlyContinue
if (-not ($ultimas -join "`n" -match 'Dump completed')) {
  Remove-Item $sql -Force
  throw "El archivo quedo INCOMPLETO (falta la marca 'Dump completed'). Se borro."
}

# Red de seguridad: que NO se haya colado ni una fila de datos. Si aparece un
# INSERT, este archivo llevaria datos de un cliente a la instalacion de otro.
$inserts = (Select-String -Path $sql -Pattern '^INSERT INTO' -AllMatches).Count
if ($inserts -gt 0) {
  Remove-Item $sql -Force
  throw "El archivo tenia $inserts INSERT (deberia no tener ninguno). Se borro."
}

$tablas = (Select-String -Path $sql -Pattern '^CREATE TABLE' -AllMatches).Count
$kb     = [math]::Round((Get-Item $sql).Length / 1KB, 1)

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " ESTRUCTURA EXPORTADA" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Archivo: $sql"
Write-Host " Tablas:  $tablas    (sin una sola fila de datos)"
Write-Host " Tamanio: $kb KB"
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Para cargarlo en la base nueva:" -ForegroundColor Yellow
Write-Host "  mysql -h HOST -P PUERTO -u USUARIO -p BASE_NUEVA < `"$sql`""
Write-Host ""
Write-Host "Despues verifica que la base nueva tenga las mismas $tablas tablas." -ForegroundColor Yellow
