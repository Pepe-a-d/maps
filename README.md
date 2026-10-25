# Mapa

Mapa interactivo en plano con fondo negro, hecho con [MapLibre GL](https://maplibre.org/) y sin claves de API.

- **Pantalla de inicio**: un único botón de encendido con la animación de arranque de un cuadro de moto.
- **Mapa limpio**: solo el buscador, los ajustes y tu ubicación. Plano y orientado al norte; negro o satélite.
- **Sitios guardados** como ubicaciones de videojuego: tocarlos marca la ruta al momento. Se gestionan en Ajustes y se guardan en el navegador.
- **Rutas** con preferencia: más rápida (OSRM), sin semáforos (compara alternativas y cuenta semáforos con Overpass), alta velocidad o baja velocidad (Valhalla).
- **Modo conducción** con la distribución de un cuadro TFT de moto: giro, próxima señal (la protagonista) y velocidad con el límite. Las señales siguientes, los datos del viaje y la hora con los testigos se activan en Ajustes. Funciona en vertical y en horizontal, y tiene un simulador.
- **Semáforos y señales en el mapa** (OpenStreetMap vía Overpass), ocultos salvo que los actives en Ajustes.

Los datos de tráfico vienen de OpenStreetMap: pueden faltar o estar desactualizados. Es una ayuda, no un navegador homologado.

## Desarrollo

```bash
npm install
npm run dev
```

Cada push a `main` se publica en GitHub Pages con `.github/workflows/publicar.yml`.
