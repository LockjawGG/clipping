<#
.SYNOPSIS
  Snapshot the local Clipper database.

.DESCRIPTION
  While the database lived on Neon it had someone else's backups behind it.
  Local Postgres has none, and the transcripts alone are hours of Whisper time
  that no amount of re-editing brings back — so this exists.

  Writes a compressed custom-format dump, which `pg_restore` can restore whole
  or a single table from. Keeps the most recent $KeepCount and deletes the rest,
  so it can run unattended without filling the disk.

.PARAMETER OutDir
  Where dumps are written. Defaults to a folder outside the repo, so a dump is
  never a candidate for committing.

.PARAMETER KeepCount
  How many dumps to keep. Older ones are removed after a successful dump.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\backup-db.ps1
#>
param(
  [string]$OutDir = "$env:USERPROFILE\clipper-db-backups",
  [int]$KeepCount = 14,
  [string]$PgBin = "C:\Program Files\PostgreSQL\18\bin"
)

$ErrorActionPreference = "Stop"

# Read the connection string from .env rather than duplicating it here: one
# place to change, and no password sitting in a second file.
$envFile = Join-Path (Split-Path $PSScriptRoot -Parent) ".env"
if (-not (Test-Path $envFile)) { throw "No .env found at $envFile" }

$line = Select-String -Path $envFile -Pattern '^DATABASE_URL_UNPOOLED=' | Select-Object -First 1
if (-not $line) { $line = Select-String -Path $envFile -Pattern '^DATABASE_URL=' | Select-Object -First 1 }
if (-not $line) { throw "No DATABASE_URL in $envFile" }

$url = ($line.Line -replace '^[A-Z_]+=', '').Trim().Trim('"').Trim("'")

$pgDump = Join-Path $PgBin "pg_dump.exe"
if (-not (Test-Path $pgDump)) { throw "pg_dump not found at $pgDump" }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$target = Join-Path $OutDir "clipper-$stamp.dump"

& $pgDump --no-owner --no-privileges --format=custom --file=$target $url
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }

$size = [math]::Round((Get-Item $target).Length / 1MB, 2)
Write-Output "backup written: $target ($size MB)"

# Prune only after the new dump succeeded, so a failing run never leaves you
# with fewer backups than you started with.
Get-ChildItem -Path $OutDir -Filter "clipper-*.dump" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $KeepCount |
  ForEach-Object { Write-Output "pruning old backup: $($_.Name)"; Remove-Item $_.FullName -Force }
