#!/bin/bash
# build-mac.sh — genera dist/DiskerIA.app
# Ejecutar desde la raíz del repo en una Mac con Node.js instalado.
set -e
cd "$(dirname "$0")"

echo "==> Generando assets embebidos..."
node generate-assets.js

# Detectar arquitectura y compilar
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  TARGET="node18-macos-arm64"
else
  TARGET="node18-macos-x64"
fi

echo "==> Compilando binario ($TARGET)..."
npx pkg server.js --target "$TARGET" --output dist/DiskerIA-mac

echo "==> Creando bundle DiskerIA.app..."
rm -rf dist/DiskerIA.app
mkdir -p dist/DiskerIA.app/Contents/MacOS
mkdir -p dist/DiskerIA.app/Contents/Resources

cp dist/DiskerIA-mac dist/DiskerIA.app/Contents/MacOS/DiskerIA
chmod +x dist/DiskerIA.app/Contents/MacOS/DiskerIA
rm dist/DiskerIA-mac

# Icono .icns desde assets/logo.png (sips + iconutil son herramientas nativas de macOS)
if [ -f assets/logo.png ]; then
  echo "==> Generando icono .icns..."
  ICONSET="dist/DiskerIA.iconset"
  mkdir -p "$ICONSET"
  for SIZE in 16 32 64 128 256 512; do
    sips -z $SIZE $SIZE assets/logo.png --out "$ICONSET/icon_${SIZE}x${SIZE}.png"       > /dev/null
    sips -z $((SIZE*2)) $((SIZE*2)) assets/logo.png --out "$ICONSET/icon_${SIZE}x${SIZE}@2x.png" > /dev/null
  done
  iconutil -c icns "$ICONSET" -o dist/DiskerIA.app/Contents/Resources/DiskerIA.icns
  rm -rf "$ICONSET"
fi

# Info.plist
cat > dist/DiskerIA.app/Contents/Info.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>   <string>DiskerIA</string>
  <key>CFBundleIdentifier</key>   <string>com.diskeria.app</string>
  <key>CFBundleName</key>         <string>DiskerIA</string>
  <key>CFBundleIconFile</key>     <string>DiskerIA</string>
  <key>CFBundleVersion</key>      <string>1.0.0</string>
  <key>CFBundleShortVersionString</key> <string>1.0.0</string>
  <key>CFBundlePackageType</key>  <string>APPL</string>
  <key>LSBackgroundOnly</key>     <true/>
  <key>NSHighResolutionCapable</key> <true/>
</dict>
</plist>
EOF

echo ""
echo "Listo: dist/DiskerIA.app"
