$ErrorActionPreference = 'Stop'
Push-Location -LiteralPath $PSScriptRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
        Write-Host '请先在项目目录运行 npm ci。'
        exit 1
    }
    & npm.cmd start
    exit $LASTEXITCODE
} finally { Pop-Location }
