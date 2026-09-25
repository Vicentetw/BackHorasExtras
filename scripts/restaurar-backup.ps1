# ============================================================================
# Restaurar un backup de Horas Dedica
# ============================================================================
#
# POR QUE ESTE SCRIPT EXISTE
# --------------------------
# Un backup que nadie restauro nunca no es un respaldo: es una intencion. El
# archivo puede estar completo, pesar lo que corresponde, tener la marca de
# "Dump completed" que verifica backup-produccion.ps1... y aun asi fallar al
# restaurarse, por una diferencia de version de MySQL, por un charset, por un
# usuario que no existe en el destino.
#
# La unica forma de saber que un backup sirve es restaurarlo. Y la unica forma
# de saber cuanto vas a tardar en volver despues de un desastre es haberlo
# cronometrado antes, con calma, en vez de descubrirlo el peor dia.
#
# Por eso este script ademas mide y reporta el tiempo.
#
# USO
#   # Ensayo en una base descartable (lo que hay que hacer una vez por mes):
#   .\scripts\restaurar-backup.ps1 -Archivo "C:\...\backup-xxx.zip" `
#       -Host localhost -Puerto 3307 -Usuario root -Base ensayo_restore `
#       -ConfirmoBase ensayo_restore
#
#   # De verdad, despues de un desastre: mismo comando apuntando al destino real.
#
# LA CONFIRMACION NO ES UN ADORNO
# -------------------------------
# Restaurar BORRA Y REEMPLAZA todo lo que haya en la base destino. Por eso hay
# que escribir el nombre de la base DOS veces: una en -Base y otra en
# -ConfirmoBase. No alcanza con un "si": hay que tipear el nombre exacto.
#
# Es incomodo a proposito. El dia que restaures vas a estar apurado y nervioso,
# y ese es justo el momento en que uno apunta sin querer a la base equivocada.
#
# REQUISITOS
#   mysql.exe y mysqldump.exe en el PATH (vienen con MySQL o con XAMPP), o
#   Docker corriendo si el destino es el contenedor local.
# ============================================================================

param(
  [Parameter(Mandatory = $true)][string]$Archivo,
  [string]$DbHost = 'localhost',
  [int]$Puerto = 3307,
  [string]$Usuario = 'root',
  [string]$Password,
  [Parameter(Mandatory = $true)][string]$Base,
  [Parameter(Mandatory = $true)][string]$ConfirmoBase,
  # Si el destino es el contenedor de Docker, se usa `docker exec` en vez de
  # mysql.exe -- asi no hace falta tener el cliente instalado en Windows.
  [string]$Contenedor
)

$ErrorActionPreference = 'Stop'

# --- Verificaciones antes de tocar nada -------------------------------------

if ($Base -cne $ConfirmoBase) {
  Write-Host "ABORTADO: -Base ('$Base') y -ConfirmoBase ('$ConfirmoBase') no coinciden." -ForegroundColor Red
  Write-Host "Es la proteccion contra restaurar sobre la base equivocada. Escribi el mismo nombre en las dos."
  exit 1
}

if (-not (Test-Path $Archivo)) {
  Write-Host "ABORTADO: no existe el archivo $Archivo" -ForegroundColor Red
  exit 1
}

# Red de seguridad extra: el nombre de la base de produccion empieza con
# 'bjtzqo'. Restaurar ENCIMA de produccion es algo que se hace una vez en la
# vida y con mucho cuidado, no de apuro copiando un comando de un documento.
if ($Base -like 'bjtzqo*') {
  Write-Host "CUIDADO: '$Base' parece la base de PRODUCCION." -ForegroundColor Yellow
  Write-Host "Restaurar la va a BORRAR Y REEMPLAZAR entera."
  $r = Read-Host "Escribi exactamente SI, RESTAURAR PRODUCCION para seguir"
  if ($r -cne 'SI, RESTAURAR PRODUCCION') { Write-Host "Cancelado."; exit 1 }
}

if (-not $Password) {
  $sec = Read-Host "Password de MySQL para '$Usuario'" -AsSecureString
  $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
}

# --- 1. Descomprimir --------------------------------------------------------

$tmp = Join-Path $env:TEMP "restore-hd-$(Get-Date -Format 'yyyyMMddHHmmss')"
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

Write-Host ""
Write-Host "1/4  Descomprimiendo..." -ForegroundColor Cyan
Expand-Archive -Path $Archivo -DestinationPath $tmp -Force
$sql = Get-ChildItem $tmp -Filter '*.sql' | Select-Object -First 1
if (-not $sql) { Write-Host "ABORTADO: el zip no contiene ningun .sql" -ForegroundColor Red; exit 1 }
Write-Host "     $($sql.Name)  ($([math]::Round($sql.Length/1MB,1)) MB)"

# La misma marca que verifica backup-produccion.ps1 al crear el archivo. Si
# falta, el dump esta truncado y no tiene sentido intentar restaurarlo.
$ultimas = Get-Content $sql.FullName -Tail 5
if (-not ($ultimas -match 'Dump completed')) {
  Write-Host "ABORTADO: el dump no termina en 'Dump completed' -- esta truncado." -ForegroundColor Red
  Remove-Item $tmp -Recurse -Force
  exit 1
}
Write-Host "     dump completo (tiene la marca final)" -ForegroundColor Green

# --- 2. Crear la base destino ----------------------------------------------

Write-Host ""
Write-Host "2/4  Preparando la base '$Base'..." -ForegroundColor Cyan

$cronometro = [Diagnostics.Stopwatch]::StartNew()

# utf8mb4: es lo que usa la base real. Crear el destino con otro charset es una
# forma silenciosa de arruinar todas las enies y tildes en la restauracion.
$crear = "DROP DATABASE IF EXISTS ``$Base``; CREATE DATABASE ``$Base`` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;"

if ($Contenedor) {
  $crear | docker exec -i -e "MYSQL_PWD=$Password" $Contenedor mysql -u $Usuario
} else {
  $env:MYSQL_PWD = $Password
  $crear | mysql -h $DbHost -P $Puerto -u $Usuario
}
if ($LASTEXITCODE -ne 0) { Write-Host "ABORTADO: no se pudo crear la base" -ForegroundColor Red; exit 1 }

# --- 3. Restaurar -----------------------------------------------------------

Write-Host ""
Write-Host "3/4  Restaurando (puede tardar)..." -ForegroundColor Cyan

if ($Contenedor) {
  Get-Content $sql.FullName -Raw | docker exec -i -e "MYSQL_PWD=$Password" $Contenedor mysql -u $Usuario $Base
} else {
  $env:MYSQL_PWD = $Password
  Get-Content $sql.FullName -Raw | mysql -h $DbHost -P $Puerto -u $Usuario $Base
}
if ($LASTEXITCODE -ne 0) { Write-Host "ABORTADO: fallo la restauracion" -ForegroundColor Red; exit 1 }

$cronometro.Stop()

# --- 4. Verificar que quedo algo usable -------------------------------------
#
# Restaurar sin errores no alcanza: un dump vacio tambien "restaura bien". Se
# cuenta lo que tiene que estar.

Write-Host ""
Write-Host "4/4  Verificando..." -ForegroundColor Cyan

$verificar = @"
SELECT COUNT(*) AS tablas FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$Base';
SELECT (SELECT COUNT(*) FROM ``$Base``.employees) AS empleados,
       (SELECT COUNT(*) FROM ``$Base``.Checkins) AS fichajes,
       (SELECT COUNT(*) FROM ``$Base``.tenants) AS empresas,
       (SELECT COUNT(*) FROM ``$Base``.app_users) AS usuarios;
"@

if ($Contenedor) {
  $verificar | docker exec -i -e "MYSQL_PWD=$Password" $Contenedor mysql -u $Usuario -t
} else {
  $env:MYSQL_PWD = $Password
  $verificar | mysql -h $DbHost -P $Puerto -u $Usuario -t
}

Remove-Item $tmp -Recurse -Force
$env:MYSQL_PWD = $null

Write-Host ""
Write-Host "LISTO. Restaurado en $([math]::Round($cronometro.Elapsed.TotalSeconds,1)) segundos." -ForegroundColor Green
Write-Host ""
Write-Host "Ese numero es tu respuesta a '¿cuanto tardo en volver?'. Sumale el"
Write-Host "tiempo de bajar el backup y de apuntar el backend a la base nueva."
