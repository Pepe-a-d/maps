# Mapa

Mapa interactivo con fondo negro, hecho con [MapLibre GL](https://maplibre.org/) y sin claves de API.

- **Mapa negro y vista satélite** (CARTO Dark Matter repintado y Esri World Imagery).
- **Búsqueda** de lugares con Photon.
- **Capa de tráfico**: semáforos, pasos de peatones, stops, ceda el paso, señales, radares, reductores y pasos a nivel de OpenStreetMap (vía Overpass), a partir del zoom 15.
- **Modo conducción tipo videojuego**: ruta de OSRM con cámara de persecución, giro siguiente, próximos semáforos y señales con cuenta atrás, velocímetro con el límite de la vía, voz en español y un simulador para recorrer la ruta sin moverte.

Los datos de tráfico vienen de OpenStreetMap: pueden faltar o estar desactualizados. Es una ayuda, no un navegador homologado.

## Desarrollo

```bash
npm install
npm run dev
```

Cada push a `main` se publica en GitHub Pages con `.github/workflows/publicar.yml`.
