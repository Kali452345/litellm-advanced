<#
.SYNOPSIS
    Starts the LiteLLM proxy from this checkout and opens the Admin UI.

.DESCRIPTION
    Reads .env for LITELLM_MASTER_KEY and DATABASE_URL, runs the proxy out of the
    working tree rather than an installed litellm, and prints the dashboard link plus
    what an agent harness needs to point at it. Output is teed to litellm.log.

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

$env:PYTHONPATH = $repo
$env:PYTHONIOENCODING = 'utf-8'

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

$proxyArgs = @('litellm/proxy/proxy_cli.py', '--config', $Config, '--port', $Port, '--use_v2_migration_resolver')
if ($DetailedDebug) { $proxyArgs += '--detailed_debug' }

try {
    # uvicorn logs to stderr, which 'Stop' would turn into a terminating NativeCommandError
    $ErrorActionPreference = 'Continue'
    & $Python @proxyArgs 2>&1 | Tee-Object -FilePath $log
} finally {
    Get-Job -Name 'litellm-ui' -ErrorAction SilentlyContinue | Remove-Job -Force
}
