# deploy.ps1 - Copia DiskerIA.exe a Program Files (pide UAC si es necesario)
param([string]$Root = $PSScriptRoot)

# Si no es admin, se relanza elevado
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell -Verb RunAs -ArgumentList "-ExecutionPolicy Bypass -File `"$PSCommandPath`" `"$Root`"" -Wait
    exit $LASTEXITCODE
}

$src  = Join-Path $Root "dist\DiskerIA.exe"
$dest = "$env:ProgramFiles\DiskerIA\DiskerIA.exe"

if (-not (Test-Path $src)) {
    Write-Error "No se encontro dist\DiskerIA.exe. Corri npm run build primero."
    exit 1
}

Copy-Item -Force $src $dest
Write-Host "OK: DiskerIA.exe copiado a $dest"
