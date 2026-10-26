# Mapa

Mapa interactivo en plano con fondo negro, hecho con [MapLibre GL](https://maplibre.org/) y sin claves de API.

- **Estética de juego de conducción de mundo abierto**: paneles oscuros translúcidos, rosa como acento, tipografía gruesa en mayúsculas e insignias hexagonales.
- **Pantalla de inicio**: un único botón de encendido; al pulsarlo, un velocímetro hace el barrido y franjas de color barren la pantalla hasta el mapa.
- **Mapa limpio**: solo el buscador, los ajustes y tu ubicación. Plano y orientado al norte; negro o satélite.
- **Sitios guardados** como ubicaciones de videojuego (hexágonos con su nombre y aviso de «ubicación descubierta»): tocarlos marca la ruta al momento. Se gestionan en Ajustes y se guardan en el navegador.
- **Rutas** con preferencia: más rápida (OSRM), sin semáforos (compara alternativas y cuenta semáforos con Overpass), alta velocidad o baja velocidad (Valhalla).
- **Modo conducción** con el mapa a pantalla completa y el HUD flotando encima: la próxima señal como tarjeta de aviso (la protagonista), el giro y un velocímetro circular con el límite. Las señales siguientes, los datos del viaje y la hora con los testigos se activan en Ajustes. Funciona en vertical y en horizontal, y tiene un simulador.
- **Semáforos y señales en el mapa** (OpenStreetMap vía Overpass), ocultos salvo que los actives en Ajustes.

Los datos de tráfico vienen de OpenStreetMap: pueden faltar o estar desactualizados. Es una ayuda, no un navegador homologado.

## Desarrollo

```bash
npm install
npm run dev
```

Cada push a `main` se publica en GitHub Pages con `.github/workflows/publicar.yml`.
