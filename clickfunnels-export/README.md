# Exportado para ClickFunnels

Un par de archivos por página: `-head.html` (fuentes + estilos) y `-body.html`
(todo el contenido + el JS). Las imágenes del logo ya no son base64 — apuntan
a `https://thomasaguero009-cyber.github.io/step-her-up/images/brand/`, así
que los archivos son livianos para pegar y el logo se sigue viendo aunque el
sitio viva en ClickFunnels.

## Cómo pegarlos en ClickFunnels (por cada página del funnel)

1. Creá la página en blanco en ClickFunnels.
2. En la configuración de la página (Settings → Tracking Code / Custom Code,
   el que inyecta código en el `<head>`), pegá el contenido de `*-head.html`.
3. Agregá un elemento **Custom HTML** que ocupe toda la página y pegá ahí el
   contenido de `*-body.html` completo (incluye el `<script>` al final).

## Mapeo de páginas

| Archivo de acá | Página del funnel |
|---|---|
| `index-*` | Landing / VSL |
| `testimonios-*` | Testimonios |
| `formulario-*` | Quiz de calificación |
| `calendario-*` | Calendario |
| `gracias-*` | Gracias |

## Links que hay que actualizar a mano (3 en total)

Estos archivos tienen un link "duro" a otra página del sitio, escrito como
nombre de archivo (`formulario.html`, etc.) — hay que cambiarlos por la URL
real que le asigne ClickFunnels a cada página:

- **`index-body.html`** — el botón "Aplicar al programa" apunta a
  `formulario.html`.
- **`formulario-body.html`** (línea ~174) — al terminar el quiz, un
  `window.location.href = "calendario.html";` en el JS.
- **`calendario-body.html`** — el link de "Gracias" apunta a `gracias.html`.

Buscá esas 3 líneas en cada archivo y reemplazá el nombre de archivo por la
URL final de esa página dentro de ClickFunnels.
