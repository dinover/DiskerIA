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
echo "    yt-dlp OK"

# ── ffmpeg ────────────────────────────────────────────────────────────────────
if [ ! -f bin/ffmpeg ]; then
  echo "==> Descargando ffmpeg..."
  FFMPEG_URL=$(curl -s https://api.github.com/repos/yt-dlp/FFmpeg-Builds/releases/latest \
    | grep '"browser_download_url"' \
    | grep 'linux64-gpl.tar.xz' \
    | head -1 \
    | cut -d'"' -f4)
  if [ -z "$FFMPEG_URL" ]; then
    echo "ERROR: no se pudo obtener URL de ffmpeg desde GitHub API"
    exit 1
  fi
  echo "    URL: $FFMPEG_URL"
  curl -fsSL "$FFMPEG_URL" -o /tmp/ffmpeg.tar.xz
  mkdir -p /tmp/ffmpeg_ext
  tar -xf /tmp/ffmpeg.tar.xz -C /tmp/ffmpeg_ext
  find /tmp/ffmpeg_ext -type f -name 'ffmpeg' | head -1 | xargs -I{} cp {} bin/ffmpeg
  chmod +x bin/ffmpeg
  rm -rf /tmp/ffmpeg.tar.xz /tmp/ffmpeg_ext
  echo "    ffmpeg OK"
else
  echo "==> ffmpeg ya existe, omitiendo."
fi

# ── cookies de YouTube (opcional, base64) ─────────────────────────────────────
if [ -n "$YOUTUBE_COOKIES" ]; then
  echo "==> Escribiendo cookies de YouTube..."
  echo "$YOUTUBE_COOKIES" | base64 --decode > bin/cookies.txt
  echo "    cookies OK ($(wc -l < bin/cookies.txt) líneas)"
fi

echo ""
echo "Herramientas listas:"
ls -lh bin/
