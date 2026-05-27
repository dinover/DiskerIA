# Creates assets/logo.ico (multi-size) from assets/logo.png
# Place the real logo PNG at assets/logo.png before running this script.
Add-Type -AssemblyName System.Drawing

$src = "assets\logo.png"
if (-not (Test-Path $src)) {
    Write-Error "Save the logo PNG to '$src' first, then run this script."
    exit 1
}

New-Item -ItemType Directory -Force -Path "assets" | Out-Null

# Load source image
$original = [System.Drawing.Image]::FromFile((Resolve-Path $src).Path)

$sizes = @(16, 32, 48, 256)
$pngArrays = @{}

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g   = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode  = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode      = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode    = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($original, 0, 0, $sz, $sz)
    $g.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngArrays[$sz] = $ms.ToArray()
    $ms.Dispose(); $bmp.Dispose()
}
$original.Dispose()

# Write multi-size ICO (each size embedded as PNG)
$icoPath   = "assets\logo.ico"
$icoStream = New-Object System.IO.FileStream($icoPath, [System.IO.FileMode]::Create)
$w         = New-Object System.IO.BinaryWriter($icoStream)

$w.Write([uint16]0)             # Reserved
$w.Write([uint16]1)             # Type = ICO
$w.Write([uint16]$sizes.Count)  # Image count

$offset = 6 + $sizes.Count * 16
foreach ($sz in $sizes) {
    $w.Write([byte]($sz % 256))              # Width  (0 = 256)
    $w.Write([byte]($sz % 256))              # Height (0 = 256)
    $w.Write([byte]0)                         # ColorCount
    $w.Write([byte]0)                         # Reserved
    $w.Write([uint16]1)                       # Planes
    $w.Write([uint16]32)                      # BitCount
    $w.Write([uint32]$pngArrays[$sz].Length)  # SizeInBytes
    $w.Write([uint32]$offset)                 # Offset
    $offset += $pngArrays[$sz].Length
}
foreach ($sz in $sizes) {
    $w.Write($pngArrays[$sz], 0, $pngArrays[$sz].Length)
}
$w.Flush(); $w.Close(); $icoStream.Close()

Write-Host "Created assets\logo.ico from $src (sizes: $($sizes -join ', ') px)"
