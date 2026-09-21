# ============================================================================
# Backup de la base de produccion (Horas Dedica)
# ============================================================================
#
# USO
#   .\scripts\backup-produccion.ps1
#   .\scripts\backup-produccion.ps1 -Destino "D:\backups-horasdedica"
#
# POR QUE COMPLETO Y NO INCREMENTAL
# ---------------------------------
# La base entera pesa ~37 MB y comprimida queda en ~6. Un backup completo
# tarda segundos. El incremental de MySQL necesita acceso a los binlogs, que
# el plan gestionado de Clever Cloud no expone; y ademas es una CADENA: si un
# eslabon se corrompe, se pierde todo lo posterior. Un backup completo se
# restaura solo, sin depender de ningun otro archivo. Para este tamaño, el
# incremental es complejidad sin beneficio.
#
# QUE HACE
#   1. lee las credenciales del .env (NO estan en este archivo);
#   2. hace el dump con --single-transaction, que toma una foto consistente
#      SIN bloquear la base -- se puede correr con el sistema en uso;
#   3. VERIFICA que el dump este completo (ver abajo);
#   4. lo comprime;
#   5. rota: conserva los ultimos 14 dias, y ademas el primero de cada mes
#      para siempre.
#
# LA VERIFICACION NO ES UN ADORNO
# -------------------------------
# mysqldump escribe "-- Dump completed" en la ultima linea. Si el proceso se
# corta a la mitad (se cae internet, se llena el disco), el archivo queda
# igual: con tamaño, con aspecto de backup, y sin esa linea. Un backup
# truncado que nadie reviso es peor que no tener backup, porque da confianza
# falsa. Por eso si falta la marca, el script borra el archivo y falla.
#
# PARA QUE CORRA SOLO TODOS LOS DIAS (Programador de tareas de Windows)
#   1. Programador de tareas -> Crear tarea basica
#   2. Diariamente, a una hora en que la PC este prendida
#   3. Accion: Iniciar un programa
#        Programa:   powershell.exe
#        Argumentos: -ExecutionPolicy Bypass -File "C:\angular\horasdedicacion-back-deploy\BackHorasExtras\scripts\backup-produccion.ps1"
#
# COMO SE RESTAURA (probalo UNA VEZ, contra una base de prueba)
#   1. descomprimir el .zip
#   2. crear una base vacia:  CREATE DATABASE prueba_restore;
#   3. mysql -h HOST -u USUARIO -p prueba_restore < backup-....sql
#   Un backup que nunca se restauro es una esperanza, no un backup.
# ============================================================================

param(
  [string]$Destino = "$env:USERPROFILE\Backups\HorasDedica",
  [string]$EnvFile = "$PSScriptRoot\..\motor-laboral\.env",
  [int]$DiasAConservar = 14
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

Write-Host "=== Backup de Horas Dedica ===" -ForegroundColor Cyan

$dump = Buscar-MysqlDump
$cfg  = Leer-Env $EnvFile

foreach ($k in @('MYSQL_ADDON_HOST','MYSQL_ADDON_USER','MYSQL_ADDON_PASSWORD','MYSQL_ADDON_DB')) {
  if (-not $cfg[$k]) { throw "Falta $k en $EnvFile" }
}
$puerto = if ($cfg['MYSQL_ADDON_PORT']) { $cfg['MYSQL_ADDON_PORT'] } else { '3306' }

New-Item -ItemType Directory -Force -Path $Destino | Out-Null
$sello   = Get-Date -Format 'yyyy-MM-dd_HHmm'
$sql     = Join-Path $Destino "backup-$($cfg['MYSQL_ADDON_DB'])-$sello.sql"
$zip     = [System.IO.Path]::ChangeExtension($sql, '.zip')

$inicio = Get-Date
Write-Host "Base:    $($cfg['MYSQL_ADDON_DB']) en $($cfg['MYSQL_ADDON_HOST'])"
Write-Host "Destino: $zip"
Write-Host "Inicio:  $($inicio.ToString('HH:mm:ss'))"
Write-Host ""
# La duracion varia MUCHO segun como este la conexion a Clever Cloud: en
# pruebas dio entre 40 segundos y 4,5 minutos para los mismos 17 MB. Durante
# ese rato la pantalla queda quieta y no hay barra de progreso -- es normal.
# La señal de que termino bien es el cartel verde del final.
Write-Host "Descargando la base... (puede tardar varios minutos, la pantalla queda quieta)"

# --no-tablespaces: sin esto mysqldump falla con
#     "Access denied; you need (at least one of) the PROCESS privilege(s)
#      ... when trying to dump tablespaces"
# El usuario de una base gestionada (Clever Cloud) no tiene PROCESS, que es
# un permiso de administrador del servidor entero. Esa informacion no hace
# falta para restaurar: son metadatos de como InnoDB guarda los archivos en
# disco, y al restaurar se recrean solos. Probado contra produccion.
#
# La contrasena va por variable de entorno y no como argumento: los
# argumentos de un proceso los puede ver cualquier otro programa de la PC.
# Se invoca directo, sin Start-Process.
#
# Hubo un intento de mostrar el avance en vivo lanzandolo con
# Start-Process -PassThru y mirando el tamaño del archivo. Salio mal y vale
# la pena dejarlo anotado: `$proc.ExitCode` quedaba VACIO, el script lo leia
# como distinto de cero, y borraba un backup de 17 MB que estaba perfecto.
# Una "mejora" cosmetica destruyendo justo lo que el script tiene que
# cuidar. La version directa devuelve bien $LASTEXITCODE y es la que
# funciona.
$env:MYSQL_PWD = $cfg['MYSQL_ADDON_PASSWORD']
try {
  & $dump `
    --host=$($cfg['MYSQL_ADDON_HOST']) `
    --port=$puerto `
    --user=$($cfg['MYSQL_ADDON_USER']) `
    --single-transaction `
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
  throw "mysqldump fallo (codigo $codigo). No se genero ningun backup."
}
Write-Host "Descarga terminada ($([int]((Get-Date) - $inicio).TotalSeconds)s)."

# --- Verificacion: ¿el dump esta completo? ---
$ultimas = Get-Content $sql -Tail 5 -ErrorAction SilentlyContinue
if (-not ($ultimas -join "`n" -match 'Dump completed')) {
  Remove-Item $sql -Force
  throw "El dump quedo INCOMPLETO (falta la marca 'Dump completed'). Se borro el archivo."
}
$tablas = (Select-String -Path $sql -Pattern '^CREATE TABLE' -AllMatches).Count
$mb     = [math]::Round((Get-Item $sql).Length / 1MB, 1)
Write-Host "Verificado: $tablas tablas, $mb MB" -ForegroundColor Green

Compress-Archive -Path $sql -DestinationPath $zip -Force
Remove-Item $sql -Force
$mbZip = [math]::Round((Get-Item $zip).Length / 1MB, 2)
Write-Host "Comprimido: $mbZip MB" -ForegroundColor Green

# --- Rotacion ---
# Se conservan los ultimos N dias, y ademas el backup del dia 1 de cada mes
# para siempre: sirve para volver a un estado de hace meses si un error se
# descubre tarde (un calculo mal, un borrado que nadie noto en su momento).
$limite = (Get-Date).AddDays(-$DiasAConservar)
$borrados = 0
Get-ChildItem $Destino -Filter 'backup-*.zip' | ForEach-Object {
  if ($_.Name -match 'backup-.*-(\d{4})-(\d{2})-(\d{2})_') {
    $fecha = Get-Date -Year $matches[1] -Month $matches[2] -Day $matches[3]
    $esPrimeroDeMes = $matches[3] -eq '01'
    if ($fecha -lt $limite -and -not $esPrimeroDeMes) {
      Remove-Item $_.FullName -Force
      $borrados++
    }
  }
}

$total = (Get-ChildItem $Destino -Filter 'backup-*.zip').Count
Write-Host "Rotacion:   $borrados borrados, $total backups guardados."

$duracion = [int]((Get-Date) - $inicio).TotalSeconds
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " BACKUP TERMINADO CORRECTAMENTE" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host " Archivo:  $zip"
Write-Host " Tamanio:  $mbZip MB  ($tablas tablas)"
Write-Host " Duracion: $duracion segundos"
Write-Host " Hora:     $((Get-Date).ToString('HH:mm:ss'))"
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Si NO ves este cartel verde, el backup no se completo." -ForegroundColor Yellow
Write-Host "RECORDATORIO: proba restaurar uno en una base de prueba." -ForegroundColor Yellow
Write-Host "Un backup que nunca se restauro es una esperanza, no un backup."
