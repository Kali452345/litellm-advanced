<#
.SYNOPSIS
    Starts the LiteLLM proxy from this checkout and opens the Admin UI.

.DESCRIPTION
    Reads .env for LITELLM_MASTER_KEY and DATABASE_URL, puts the Prisma CLI and this
    checkout's litellm-proxy-extras where the proxy can find them so migrations actually
    run, generates the Prisma client on first use, rebuilds the Admin UI when the checkout
    is ahead of the last build, then runs the proxy out of the working tree rather than an
    installed litellm. Prints the dashboard link plus what an agent harness needs to point
    at it. Output is teed to litellm.log. Refuses to start when the port is already served
    or an earlier launcher still holds that log, rather than finding out after the UI build.

.EXAMPLE
    .\start-litellm.ps1
.EXAMPLE
    .\start-litellm.ps1 -Port 4001 -DetailedDebug
.EXAMPLE
    .\start-litellm.ps1 -SkipUiBuild
#>
[CmdletBinding()]
param(
    [int]$Port = 4000,
    [string]$Config = 'config.yaml',
    [string]$Python = 'python',
    [switch]$DetailedDebug,
    [switch]$NoBrowser,
    [switch]$SkipUiBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
Set-Location $repo
$log = Join-Path $repo 'litellm.log'

function Import-DotEnv {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    foreach ($line in Get-Content -LiteralPath $Path) {
        $entry = $line.Trim()
        if ($entry.Length -eq 0 -or $entry.StartsWith('#')) { continue }
        if ($entry.StartsWith('export ')) { $entry = $entry.Substring(7).Trim() }

        $split = $entry.IndexOf('=')
        if ($split -lt 1) { continue }

        $name = $entry.Substring(0, $split).Trim()
        $value = $entry.Substring($split + 1).Trim().Trim('"').Trim("'")
        [Environment]::SetEnvironmentVariable($name, $value, 'Process')
    }
}

# both of these are checked before the Prisma and UI build steps, so a port that is already served
# or a log a stranded launcher still holds fails in a second rather than after a two minute build
function Assert-PortFree {
    param([int]$Number)

    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return }

    $holder = Get-NetTCPConnection -LocalPort $Number -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if (-not $holder) { return }

    $owner = Get-Process -Id $holder.OwningProcess -ErrorAction SilentlyContinue
    $name = if ($owner) { $owner.ProcessName } else { 'an unknown process' }

    Write-Host ''
    Write-Host "Port $Number is already served by $name (pid $($holder.OwningProcess))" -ForegroundColor Red
    Write-Host 'Stop that one first, or start this on another port:'
    Write-Host "  Stop-Process -Id $($holder.OwningProcess) -Force"
    Write-Host "  .\start-litellm.ps1 -Port $($Number + 1)"
    exit 1
}

function Assert-LogWritable {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) { return }

    try {
        [System.IO.File]::Open($Path, 'Open', 'Write', 'None').Dispose()
    } catch {
        Write-Host ''
        Write-Host "Cannot write $Path" -ForegroundColor Red
        Write-Host "  $($_.Exception.Message)"
        Write-Host 'A launcher from an earlier run holds the log when its proxy is killed out from under it'
        Write-Host 'Close that window, or stop that powershell, then run this again:'
        Write-Host "  Get-CimInstance Win32_Process | Where-Object { `$_.CommandLine -like '*start-litellm*' }"
        exit 1
    }
}

Import-DotEnv (Join-Path $repo '.env')

$missing = @(@('LITELLM_MASTER_KEY', 'DATABASE_URL') | Where-Object { -not [Environment]::GetEnvironmentVariable($_) })
if ($missing.Count -gt 0) {
    Write-Host ''
    Write-Host "Missing from .env: $($missing -join ', ')" -ForegroundColor Red
    Write-Host ''
    Write-Host 'Put these in .env next to this script, then run it again:'
    Write-Host '  LITELLM_MASTER_KEY=sk-<something long and random>'
    Write-Host '  DATABASE_URL=postgresql://litellm:<password>@127.0.0.1:5432/litellm'
    Write-Host ''
    Write-Host 'The database has to be Postgres. Admin UI login refuses to start without it'
    exit 1
}

Assert-PortFree $Port
Assert-LogWritable $log

$env:PYTHONPATH = "$repo;$(Join-Path $repo 'litellm-proxy-extras')"
$env:PYTHONIOENCODING = 'utf-8'

function Format-NativeLine {
    param([object]$Record)

    # uvicorn and npm log to stderr, so a line arrives as an ErrorRecord whose own ToString is the
    # wrapper type name: reading the message keeps it the plain line the tool wrote
    if ($Record -is [System.Management.Automation.ErrorRecord]) { return $Record.Exception.Message }
    return [string]$Record
}

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments, [switch]$Quiet)

    # native stderr under 'Stop' becomes a terminating NativeCommandError, and anything the command
    # leaves in the pipeline joins this function's return value, which has to be the exit code alone
    $ErrorActionPreference = 'Continue'
    & $Command @Arguments 2>&1 | ForEach-Object {
        if (-not $Quiet) { Write-Host (Format-NativeLine $_) }
    }
    return $LASTEXITCODE
}

function Get-NativeOutput {
    param([string]$Command, [string[]]$Arguments)

    $ErrorActionPreference = 'Continue'
    return @(& $Command @Arguments 2>$null)
}

function Get-NewestWriteUtc {
    param([string]$Dashboard)

    $candidates = @(
        @('src', 'public') |
            ForEach-Object { Join-Path $Dashboard $_ } |
            Where-Object { Test-Path -LiteralPath $_ } |
            ForEach-Object { Get-ChildItem -LiteralPath $_ -Recurse -File -Force }
        @('package.json', 'package-lock.json', 'next.config.mjs', 'postcss.config.js', 'tsconfig.json', 'components.json') |
            ForEach-Object { Join-Path $Dashboard $_ } |
            Where-Object { Test-Path -LiteralPath $_ } |
            ForEach-Object { Get-Item -LiteralPath $_ }
    )

    $newest = $candidates | Sort-Object -Property LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $newest) { return [datetime]::MinValue }
    return $newest.LastWriteTimeUtc
}

function Build-Dashboard {
    param([string]$Dashboard)

    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Host ''
        Write-Host 'The Admin UI is behind this checkout and npm is not on PATH to rebuild it' -ForegroundColor Red
        return $false
    }

    Write-Host ''
    Write-Host 'Building the Admin UI, which takes a couple of minutes' -ForegroundColor Yellow

    Push-Location $Dashboard
    try {
        if (-not (Test-Path -LiteralPath (Join-Path $Dashboard 'node_modules'))) {
            if ((Invoke-Native 'npm' @('ci')) -ne 0) { return $false }
        }
        return (Invoke-Native 'npm' @('run', 'build')) -eq 0
    } finally {
        Pop-Location
    }
}

$scriptDirs = Get-NativeOutput $Python @('-c', "import sysconfig; print(sysconfig.get_path('scripts')); print(sysconfig.get_path('scripts', 'nt_user'))")
foreach ($dir in $scriptDirs) {
    if ($dir -and (Test-Path -LiteralPath $dir) -and (($env:PATH -split ';') -notcontains $dir)) {
        $env:PATH = "$dir;$env:PATH"
    }
}

if (-not (Get-Command prisma -ErrorAction SilentlyContinue)) {
    Write-Host ''
    Write-Host 'The Prisma CLI is not on PATH' -ForegroundColor Red
    Write-Host 'Without it the proxy skips every migration and serves against an empty database'
    Write-Host ''
    Write-Host 'Install it for this Python, then run this again:'
    Write-Host "  $Python -m pip install --user prisma"
    exit 1
}

if ((Invoke-Native $Python @('-c', 'from prisma import Prisma') -Quiet) -ne 0) {
    Write-Host ''
    Write-Host 'Generating the Prisma client' -ForegroundColor Yellow
    Write-Host 'The first run downloads its own Node runtime, so give it a few minutes'
    if ((Invoke-Native 'prisma' @('generate')) -ne 0) {
        Write-Host ''
        Write-Host 'prisma generate failed, so the proxy has no database client to start with' -ForegroundColor Red
        exit 1
    }
}

$dashboard = Join-Path $repo 'ui\litellm-dashboard'
$builtUi = Join-Path $dashboard 'out'
$builtIndex = Join-Path $builtUi 'index.html'

$stale = if (Test-Path -LiteralPath $builtIndex) {
    (Get-Item -LiteralPath $builtIndex).LastWriteTimeUtc -lt (Get-NewestWriteUtc $dashboard)
} else {
    $true
}

if ($stale -and -not $SkipUiBuild) {
    if (-not (Build-Dashboard $dashboard)) {
        Write-Host ''
        Write-Host 'The Admin UI did not build, so the dashboard here would not be the one in this checkout' -ForegroundColor Red
        Write-Host 'Fix the build, or re-run with -SkipUiBuild to boot the proxy against whatever was built last'
        exit 1
    }
} elseif ($stale) {
    Write-Host ''
    Write-Host 'Skipping the Admin UI build, so the dashboard is behind this checkout' -ForegroundColor Yellow
}

if (Test-Path -LiteralPath $builtIndex) {
    $env:LITELLM_UI_PATH = $builtUi
} else {
    Write-Host ''
    Write-Host 'Nothing is built in ui\litellm-dashboard\out' -ForegroundColor Yellow
    Write-Host 'The dashboard below is the export that shipped with the package, not this checkout'
}

$base = "http://127.0.0.1:$Port"

Write-Host ''
Write-Host "Dashboard    $base/ui/" -ForegroundColor Cyan
Write-Host "  sign in as admin, password is your LITELLM_MASTER_KEY"
Write-Host "  keys and quotas: Models + Endpoints -> Provider Keys"
Write-Host "  what each pool has spent: $base/model/quota/usage"
Write-Host ''
Write-Host 'Point a harness at it' -ForegroundColor Cyan
Write-Host '  api key    your LITELLM_MASTER_KEY, or a virtual key made under Keys'
Write-Host '  model      the model name the pool is under, not a provider model id'
Write-Host ''
Write-Host "  `$env:OPENAI_BASE_URL = '$base/v1'"
Write-Host "  `$env:OPENAI_API_KEY = `$env:LITELLM_MASTER_KEY"
Write-Host "  `$env:ANTHROPIC_BASE_URL = '$base'"
Write-Host "  `$env:ANTHROPIC_AUTH_TOKEN = `$env:LITELLM_MASTER_KEY"
Write-Host ''
Write-Host "Logging to $log"
Write-Host 'Ctrl+C stops the proxy'
Write-Host ''
Write-Host 'Starting. The link above refuses to connect until boot finishes, which on the first' -ForegroundColor Yellow
Write-Host 'run means importing litellm and applying every migration, so give it a few minutes' -ForegroundColor Yellow
if (-not $NoBrowser) {
    Write-Host 'The dashboard opens on its own once it answers' -ForegroundColor Yellow
}
Write-Host ''

if (-not $NoBrowser) {
    Start-Job -Name 'litellm-ui' -ScriptBlock {
        param($readiness, $ui)

        $deadline = (Get-Date).AddMinutes(10)
        while ((Get-Date) -lt $deadline) {
            try {
                if ((Invoke-WebRequest -Uri $readiness -TimeoutSec 3 -UseBasicParsing).StatusCode -eq 200) {
                    Start-Process $ui
                    return
                }
            } catch { }
            Start-Sleep -Seconds 2
        }
    } -ArgumentList "$base/health/readiness", "$base/ui/" | Out-Null
}

$proxyArgs = @(
    '-u',
    'litellm/proxy/proxy_cli.py',
    '--config', $Config,
    '--port', $Port,
    '--use_v2_migration_resolver',
    '--enforce_prisma_migration_check'
)
if ($DetailedDebug) { $proxyArgs += '--detailed_debug' }

# the writer keeps the log utf-8 whatever the console code page is
$writer = [System.IO.StreamWriter]::new($log, $false, [System.Text.UTF8Encoding]::new($false))
try {
    $ErrorActionPreference = 'Continue'
    & $Python @proxyArgs 2>&1 | ForEach-Object {
        $line = Format-NativeLine $_
        Write-Host $line
        $writer.WriteLine($line)
        $writer.Flush()
    }
} finally {
    $writer.Dispose()
    Get-Job -Name 'litellm-ui' -ErrorAction SilentlyContinue | Remove-Job -Force
}
