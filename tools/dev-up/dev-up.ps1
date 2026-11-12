<#
.SYNOPSIS
  Local development in one command (Windows PowerShell 5.1+ / PowerShell 7).
.DESCRIPTION
  1. starts Postgres, SeaweedFS and Mailpit (docker/compose.dev.yml, ports from docker/.env)
  2. creates apps/backend/.env and apps/web/.env.local from the examples when missing
  3. installs dependencies when node_modules is missing
  4. seeds the sample org (migrations included; skipped when an org exists)
  5. runs the api (job worker in-process), collab and the web dev server until Ctrl+C
  Ports, database and URLs come from those .env files: edit them, not this script.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools/dev-up/dev-up.ps1
  powershell -ExecutionPolicy Bypass -File tools/dev-up/dev-up.ps1 -NoSeed -NoWeb
  powershell -ExecutionPolicy Bypass -File tools/dev-up/dev-up.ps1 -Down
#>
param(
  [switch]$NoSeed,
  [switch]$NoWeb,
  [switch]$Down
)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
Set-Location $Root

function Say([string]$text) { Write-Host "> $text" -ForegroundColor Yellow }

$composeArgs = @('compose', '-f', 'docker/compose.dev.yml')
if (Test-Path 'docker/.env') { $composeArgs += @('--env-file', 'docker/.env') }

if ($Down) {
  & docker @composeArgs down
  exit $LASTEXITCODE
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker is required' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue) -and $env:APPDATA) {
  # corepack installs pnpm under %APPDATA%\npm, which some shells leave off PATH.
  $env:PATH = "$env:PATH;$(Join-Path $env:APPDATA 'npm')"
}
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is required (corepack enable)' }

Say 'Infrastructure (docker/compose.dev.yml)'
& docker @composeArgs up -d --wait
if ($LASTEXITCODE -ne 0) { throw 'docker compose failed' }

if (-not (Test-Path 'apps/backend/.env')) {
  Say 'apps/backend/.env from the example'
  Copy-Item 'apps/backend/.env.example' 'apps/backend/.env'
}
if (-not (Test-Path 'apps/web/.env.local')) {
  Say 'apps/web/.env.local from the example'
  # Without the proxy lines: the targets below follow the api's port.
  Get-Content 'apps/web/.env.example' | Where-Object { $_ -notmatch '^VITE_(API|COLLAB)_PROXY=' } |
    Set-Content -Encoding utf8 'apps/web/.env.local'
}

if (-not (Test-Path 'node_modules')) {
  Say 'Dependencies'
  pnpm install --frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'pnpm install failed' }
}

if (-not $NoSeed) {
  Say 'Seed (migrations + sample org; skipped when an org exists)'
  pnpm --filter '@crewhall/backend' seed
  if ($LASTEXITCODE -ne 0) { throw 'seed failed' }
}

# Value of $Key in an env file (last one wins), $null when missing.
function EnvValue([string]$File, [string]$Key) {
  if (-not (Test-Path $File)) { return $null }
  $line = Get-Content $File | Where-Object { $_ -match "^$Key=" } | Select-Object -Last 1
  if (-not $line) { return $null }
  $value = ($line -split '=', 2)[1].Trim().Trim('"')
  if ($value) { return $value } else { return $null }
}

# Collab (pages, card descriptions, drawings) listens next to the api unless .env says otherwise:
# api 3000 -> collab 3001, api 4100 -> collab 4101. Child processes inherit these variables: the
# api uses COLLAB_PORT for its internal calls, the web dev server proxies /collab to it.
$apiPort = EnvValue 'apps/backend/.env' 'PORT'
if (-not $apiPort) { $apiPort = '3000' }
$collabPort = EnvValue 'apps/backend/.env' 'COLLAB_PORT'
if (-not $collabPort) { $collabPort = [string]([int]$apiPort + 1) }
$env:COLLAB_PORT = $collabPort
# The web dev server listens where the backend's HUB_URL points (its origin for CORS, cookies
# and e-mail links): http://localhost:4411 -> 4411. Default 5173.
$hubUrl = EnvValue 'apps/backend/.env' 'HUB_URL'
$webPort = '5173'
if ($hubUrl -and $hubUrl -match '^https?://[^/:]+:(\d+)') { $webPort = $Matches[1] }
$apiProxy = EnvValue 'apps/web/.env.local' 'VITE_API_PROXY'
if (-not $apiProxy) { $apiProxy = "http://localhost:$apiPort" }
$env:VITE_API_PROXY = $apiProxy
$collabProxy = EnvValue 'apps/web/.env.local' 'VITE_COLLAB_PROXY'
if (-not $collabProxy) { $collabProxy = "http://localhost:$collabPort" }
$env:VITE_COLLAB_PROXY = $collabProxy

$procs = @()
Say "api on :$apiPort (apps/backend/.env)"
$procs += Start-Process -FilePath 'pnpm.cmd' -ArgumentList '--filter', '@crewhall/backend', 'dev' -NoNewWindow -PassThru
Say "collab on :$collabPort"
$procs += Start-Process -FilePath 'pnpm.cmd' -ArgumentList '--filter', '@crewhall/backend', 'dev:collab' -NoNewWindow -PassThru
if (-not $NoWeb) {
  Say "web on :$webPort (/api -> $apiProxy, /collab -> $collabProxy)"
  # PORT for vite only (the api and collab already started without it).
  $env:PORT = $webPort
  $procs += Start-Process -FilePath 'pnpm.cmd' -ArgumentList '--filter', '@crewhall/web', 'dev' -NoNewWindow -PassThru
  Remove-Item Env:PORT
}

Say 'Running. Ctrl+C stops api, collab and web (infrastructure keeps running; -Down stops it).'
try {
  while ($true) {
    if (($procs | Where-Object { -not $_.HasExited }).Count -eq 0) { break }
    Start-Sleep -Seconds 1
  }
}
finally {
  foreach ($p in $procs) {
    if (-not $p.HasExited) {
      # Kill the whole tree: pnpm starts tsx and vite as child processes.
      & taskkill /PID $p.Id /T /F | Out-Null
    }
  }
}
