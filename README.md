# 🎵 Music Downloader — Cypress E2E

Proyecto Cypress que automatiza la descarga de canciones desde YouTube a través de y2mate.

## Flujo de cada canción

```
YouTube (búsqueda) → Primer resultado → Copiar URL → y2mate → Descargar MP3
```

## Estructura

```
music-downloader/
├── cypress/
│   ├── downloads/          ← Archivos descargados (generado automáticamente)
│   ├── e2e/
│   │   └── music-downloader.cy.js   ← Test principal
│   ├── fixtures/
│   │   └── songs.json      ← ✏️  Lista de canciones (editar aquí)
│   └── support/
│       ├── commands.js     ← Comandos personalizados (searchYouTube, downloadWithY2Mate)
│       └── e2e.js          ← Punto de entrada del soporte
├── cypress.config.js
└── package.json
```

## Instalación

```bash
npm install
```

> Si estás en una red corporativa o con restricciones:
> ```bash
> CYPRESS_INSTALL_BINARY=0 npm install
> ```

## Uso

### Modo interactivo (recomendado para desarrollo)
```bash
npm run cy:open
```

### Modo headless (CI/CD)
```bash
npm run cy:run:headless
```

### Solo el test del descargador con ventana visible
```bash
npm run cy:run:one
```

## Personalizar la lista de canciones

Edita `cypress/fixtures/songs.json`:

```json
{
  "songs": [
    {
      "title": "Nombre de la canción",
      "artist": "Artista",
      "searchQuery": "Artista NombreCanción Official Video"
    }
  ],
  "downloadFormat": "mp3",
  "downloadQuality": "128"
}
```

## Notas

- Los archivos se descargan en `cypress/downloads/`.
- y2mate puede cambiar su UI; si los selectores fallan, revisar `commands.js`.
- Los tests están diseñados para ser resilientes ante banners de cookies.
- Cypress necesita **Chrome** instalado en el sistema.
- Las descargas en modo `--headless` pueden requerir ajuste del `downloadsFolder` en `cypress.config.js`.

## Requisitos

- Node.js ≥ 16
- Chrome instalado
- Conexión a internet
