$ErrorActionPreference = 'Stop'
$petRoot = $PSScriptRoot
$petPython = Join-Path $petRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $petPython)) {
    python -m venv (Join-Path $petRoot '.venv')
    if ($LASTEXITCODE -ne 0) { throw '需要 Python 3.10 或更新版本。' }
}
& $petPython -m pip install -r (Join-Path $petRoot 'requirements-dev.txt')
if ($LASTEXITCODE -ne 0) { throw '桌宠依赖安装失败。' }
Write-Host '桌宠已就绪。运行 npm run pet 或双击 启动桌宠.vbs。'
