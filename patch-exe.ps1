# Patches DiskerIA.exe: changes PE subsystem CONSOLE (3) -> WINDOWS (2)
# This hides the black terminal window when the app is launched.

$exePath = "dist\DiskerIA.exe"

if (-not (Test-Path $exePath)) {
    Write-Error "Not found: $exePath — run 'npm run build' first"
    exit 1
}

$bytes = [System.IO.File]::ReadAllBytes((Resolve-Path $exePath))

# PE header offset stored at 0x3C
$peOffset = [BitConverter]::ToInt32($bytes, 60)

# Verify "PE\0\0" signature
if ($bytes[$peOffset] -ne 0x50 -or $bytes[$peOffset+1] -ne 0x45) {
    Write-Error "Not a valid PE executable"
    exit 1
}

# Subsystem WORD is at: PE sig (4) + COFF header (20) + optional header offset (68) = +92
$subOffset = $peOffset + 92
$current   = $bytes[$subOffset]

Write-Host "Current subsystem: $current"
if ($current -ne 2) {
    $bytes[$subOffset] = 2
    [System.IO.File]::WriteAllBytes((Resolve-Path $exePath), $bytes)
    Write-Host "OK: subsystem set to WINDOWS (2) — terminal window hidden"
} else {
    Write-Host "Already WINDOWS subsystem - nothing to do"
}
