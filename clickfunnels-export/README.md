# Exportado para ClickFunnels (vía iframe)

Cambiamos de enfoque respecto a la primera versión: en vez de pegar todo el
código (head + body) dentro de ClickFunnels, cada página de ClickFunnels
muestra la página real embebida — sigue viviendo en nuestro repo, no en
ClickFunnels.

**Por qué así:** si pegás el código a mano dentro de ClickFunnels, cada vez
que hagamos un cambio en el diseño (algo que va a seguir pasando seguido) hay
que volver a copiar y pegar todo de nuevo. Con el iframe, nosotros seguimos
editando acá, pusheamos, y el cambio aparece solo en ClickFunnels — nadie
tiene que volver a tocar nada ahí.

## Cómo usarlo (por cada página del funnel)

1. Creá la página en blanco en ClickFunnels.
2. Agregá un elemento **Custom HTML** que ocupe toda la página.
3. Pegá ahí el contenido completo del archivo `*-embed.html` correspondiente
   — son solo unas pocas líneas, no hace falta tocar nada más de esa página
   en ClickFunnels (ni "head code" ni nada).
4. La página se ajusta sola de alto automáticamente, no queda con scroll
   doble ni espacio vacío abajo.

## Mapeo de páginas

| Archivo | Página del funnel |
|---|---|
| `landing-embed.html` | Landing / VSL |
| `testimonios-embed.html` | Testimonios |
| `formulario-embed.html` | Quiz de calificación |
| `calendario-embed.html` | Calendario |
| `gracias-embed.html` | Gracias |

## Un solo paso pendiente: avisarme las URLs finales

El botón "Aplicar al programa" (landing → formulario), el paso que redirige
al calendario al terminar el quiz, y el botón de "Ya agendé mi llamada"
(calendario → gracias) necesitan saber la URL real que ClickFunnels le pone
a cada página para poder navegar ahí. Una vez que tengas las 5 páginas
creadas en ClickFunnels, pasame esas URLs y actualizo esos 3 links en el
código — no hay que tocar nada dentro de ClickFunnels para eso, se
actualiza solo en cuanto lo publico.
