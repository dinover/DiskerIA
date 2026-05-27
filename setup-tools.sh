#!/bin/bash
# setup-tools.sh — descarga yt-dlp y ffmpeg para Linux (Render)
set -e
mkdir -p bin

# ── yt-dlp ────────────────────────────────────────────────────────────────────
# Siempre descarga la última versión para evitar bloqueos de YouTube
echo "==> Descargando yt-dlp (última versión)..."
curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
  -o bin/yt-dlp
chmod +x bin/yt-dlp
echo "    yt-dlp OK ($(bin/yt-dlp --version))"

# ── ffmpeg ────────────────────────────────────────────────────────────────────
if [ ! -f bin/ffmpeg ]; then
  echo "==> Descargando ffmpeg (puede tardar unos segundos)..."
  curl -fsSL \
    "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-linux64-gpl.tar.xz" \
    -o /tmp/ffmpeg.tar.xz
  mkdir -p /tmp/ffmpeg_ext
  tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg_ext
  find /tmp/ffmpeg_ext -type f -name 'ffmpeg' | head -1 | xargs -I{} cp {} bin/ffmpeg
  chmod +x bin/ffmpeg
  rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg_ext
  echo "    ffmpeg OK"
else
  echo "==> ffmpeg ya existe, omitiendo."
fi

echo ""
echo "Herramientas listas:"
ls -lh bin/
