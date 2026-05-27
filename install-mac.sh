#!/bin/bash
# install-mac.sh — instala DiskerIA completo en una Mac desde cero.
# Uso: bash install-mac.sh
set -e
cd "$(dirname "$0")"

APP_DIR="$HOME/Library/Application Support/DiskerIA"
mkdir -p "$APP_DIR"

# ── 1. Dependencias npm ─────────────────────────────────────────────────────
echo "==> Instalando dependencias npm..."
npm install

# ── 2. Compilar la app ──────────────────────────────────────────────────────
echo "==> Compilando DiskerIA..."
bash build-mac.sh

# ── 3. yt-dlp ───────────────────────────────────────────────────────────────
echo "==> Descargando yt-dlp..."
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos" \
  -o "$APP_DIR/yt-dlp"
chmod +x "$APP_DIR/yt-dlp"

# ── 4. ffmpeg ────────────────────────────────────────────────────────────────
echo "==> Descargando ffmpeg..."
curl -fsSL "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-macos64-gpl.zip" \
  -o /tmp/ffmpeg.zip
unzip -qo /tmp/ffmpeg.zip -d /tmp/ffmpeg_ext
find /tmp/ffmpeg_ext -type f -name "ffmpeg" | head -1 | xargs -I{} cp {} "$APP_DIR/ffmpeg"
chmod +x "$APP_DIR/ffmpeg"
rm -rf /tmp/ffmpeg.zip /tmp/ffmpeg_ext

# ── 5. deno ──────────────────────────────────────────────────────────────────
echo "==> Descargando deno..."
ARCH=$(uname -m)
if [ "$ARCH" = "arm64" ]; then
  DENO_URL="https://github.com/denoland/deno/releases/latest/download/deno-aarch64-apple-darwin.zip"
else
  DENO_URL="https://github.com/denoland/deno/releases/latest/download/deno-x86_64-apple-darwin.zip"
fi
curl -fsSL "$DENO_URL" -o /tmp/deno.zip
unzip -qo /tmp/deno.zip deno -d "$APP_DIR"
chmod +x "$APP_DIR/deno"
rm /tmp/deno.zip

# ── 6. Instalar .app ─────────────────────────────────────────────────────────
echo "==> Instalando DiskerIA.app..."
# Intentar /Applications primero, sino ~/Applications
if cp -rf dist/DiskerIA.app /Applications/DiskerIA.app 2>/dev/null; then
  INSTALLED_PATH="/Applications/DiskerIA.app"
else
  mkdir -p ~/Applications
  cp -rf dist/DiskerIA.app ~/Applications/DiskerIA.app
  INSTALLED_PATH="$HOME/Applications/DiskerIA.app"
fi

# Quitar atributo de cuarentena para que macOS no bloquee el app
xattr -rd com.apple.quarantine "$INSTALLED_PATH" 2>/dev/null || true

echo ""
echo "✅  DiskerIA instalado en $INSTALLED_PATH"
echo ""
echo "Para abrirlo: doble click en DiskerIA desde Aplicaciones"
echo "  (Si macOS pide confirmación la primera vez: clic derecho → Abrir)"
