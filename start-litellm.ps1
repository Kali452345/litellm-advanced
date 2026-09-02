<#
.SYNOPSIS
    Starts the LiteLLM proxy from this checkout and opens the Admin UI.

.DESCRIPTION
    Reads .env for LITELLM_MASTER_KEY and DATABASE_URL, puts the Prisma CLI and this
    checkout's litellm-proxy-extras where the proxy can find them so migrations actually
    run, generates the Prisma client on first use, then runs the proxy out of the working
    tree rather than an installed litellm. Prints the dashboard link plus what an agent
    harness needs to point at it. Output is teed to litellm.log.

.EXAMPLE
    .\start-litellm.ps1
.EXAMPLE
    .\start-litellm.ps1 -Port 4001 -DetailedDebug
#>
[CmdletBinding()]
param(
    [int]$Port = 4000,
    [string]$Config = 'config.yaml',
    [string]$Python = 'python',
    [switch]$DetailedDebug,
    [switch]$NoBrowser
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repo = $PSScriptRoot
Set-Location $repo

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

$env:PYTHONPATH = "$repo;$(Join-Path $repo 'litellm-proxy-extras')"
$env:PYTHONIOENCODING = 'utf-8'

function Invoke-Native {
    param([string]$Command, [string[]]$Arguments, [switch]$Quiet)

    # native stderr under 'Stop' becomes a terminating NativeCommandError
    $ErrorActionPreference = 'Continue'
    if ($Quiet) { & $Command @Arguments 2>&1 | Out-Null } else { & $Command @Arguments }
    return $LASTEXITCODE
}

$scriptDirs = @(
    Invoke-Native $Python @('-c', "import sysconfig; print(sysconfig.get_path('scripts')); print(sysconfig.get_path('scripts', 'nt_user'))")
)
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

$builtUi = Join-Path $repo 'ui\litellm-dashboard\out'
if (Test-Path -LiteralPath (Join-Path $builtUi 'index.html')) { $env:LITELLM_UI_PATH = $builtUi }

$base = "http://127.0.0.1:$Port"
$log = Join-Path $repo 'litellm.log'

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

if (-not $NoBrowser) {
    Start-Job -Name 'litellm-ui' -ScriptBlock {
        param($readiness, $ui)

        $deadline = (Get-Date).AddMinutes(3)
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
    'litellm/proxy/proxy_cli.py',
    '--config', $Config,
    '--port', $Port,
    '--use_v2_migration_resolver',
    '--enforce_prisma_migration_check'
)
if ($DetailedDebug) { $proxyArgs += '--detailed_debug' }

# uvicorn logs to stderr, so every log line arrives as an ErrorRecord whose own ToString is the
# wrapper type name: reading the message keeps it a plain line, and the writer keeps the log utf-8
$writer = [System.IO.StreamWriter]::new($log, $false, [System.Text.UTF8Encoding]::new($false))
try {
    $ErrorActionPreference = 'Continue'
    & $Python @proxyArgs 2>&1 | ForEach-Object {
        $line = if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.Exception.Message } else { [string]$_ }
        Write-Host $line
        $writer.WriteLine($line)
        $writer.Flush()
    }
} finally {
    $writer.Dispose()
    Get-Job -Name 'litellm-ui' -ErrorAction SilentlyContinue | Remove-Job -Force
}
