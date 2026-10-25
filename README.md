# Mapa

Mapa interactivo en plano con fondo negro, hecho con [MapLibre GL](https://maplibre.org/) y sin claves de API.

- **Pantalla de inicio**: un único botón de encendido con la animación de arranque de un cuadro de moto.
- **Mapa negro y vista satélite** (CARTO Dark Matter repintado y Esri World Imagery), siempre orientado al norte.
- **Búsqueda** de lugares con Photon, que muestra primero tus sitios guardados.
- **Sitios guardados** como ubicaciones de videojuego: rombos flotantes con su tipo y su nombre (se guardan en el navegador).
- **Capa de tráfico**: semáforos, pasos de peatones, stops, ceda el paso, señales, radares, reductores y pasos a nivel de OpenStreetMap (vía Overpass), a partir del zoom 15.
- **Modo conducción** con la distribución de un cuadro TFT de moto: testigos, casillas de giro, próxima señal (la protagonista) y velocidad con barra segmentada, el mapa en una ventana que gira con la marcha y un simulador para recorrer la ruta sin moverte. Rutas de OSRM.

Los datos de tráfico vienen de OpenStreetMap: pueden faltar o estar desactualizados. Es una ayuda, no un navegador homologado.

## Desarrollo

```bash
npm install
npm run dev
```

Cada push a `main` se publica en GitHub Pages con `.github/workflows/publicar.yml`.
