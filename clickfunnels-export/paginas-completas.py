#!/usr/bin/env python3
"""Genera las páginas COMPLETAS para pegar en ClickFunnels ("Custom HTML page"), sin iframe.

Todo el embudo vive en un solo dominio de ClickFunnels (shu.stepherup.com), así que la lead pasa de un paso
al otro por localStorage del mismo origen: no hace falta el código de traspaso (/lead-pase) del Worker.
Rutas de ClickFunnels: /class (VSL), /form, /calendar (sin barra final ni .html).

Uso:  python3 -I clickfunnels-export/paginas-completas.py      (desde la raíz del repo step-her-up)
Salida: clickfunnels-export/completa-<paso>.html  (para copiar con pbcopy y pegar en ClickFunnels)
"""
import pathlib, re

RAIZ = pathlib.Path(__file__).resolve().parent.parent
SALIDA = RAIZ / "clickfunnels-export"
BASE = "https://thomasaguero009-cyber.github.io/step-her-up/"  # imágenes y videos siguen en el repo del funnel


def absolutas(s):
    s = re.sub(r'(src|href|poster)="((?:assets|images)/[^"]+)"', lambda m: f'{m.group(1)}="{BASE}{m.group(2)}"', s)
    assert 'src="assets/' not in s and 'src="images/' not in s and 'poster="assets/' not in s
    return s


def reemplazar(s, pares):
    for antes, despues in pares:
        assert s.count(antes) == 1, f"no encontré una sola vez: {antes!r}"
        s = s.replace(antes, despues)
    return s


def vsl():
    s = absolutas((RAIZ / "index.html").read_text(encoding="utf-8"))
    s = reemplazar(s, [
        ('id="applyBtn" href="formulario.html" target="_self"', 'id="applyBtn" href="/form" target="_self"'),
        ('applyBtn.href = "formulario.html?" + q.toString();', 'applyBtn.href = "/form?" + q.toString();'),
        # mismo dominio: el formulario lee la lead de localStorage, no hace falta pedir el código al Worker
        ("    prepararPase();\n", ""),
        # Meta: la persona dejó sus datos en la VSL
        ('      localStorage.setItem("shu_vsl_lead", JSON.stringify(lead));\n    } catch (e) {}\n',
         '      localStorage.setItem("shu_vsl_lead", JSON.stringify(lead));\n    } catch (e) {}\n    try { window.fbq && fbq("track", "Lead"); } catch (e) {}\n'),
    ])
    return s


def formulario():
    s = absolutas((RAIZ / "formulario.html").read_text(encoding="utf-8"))
    antes = 'window.location.href = "calendario.html" + qs;'
    assert s.count(antes) == 2, antes  # salto normal y respaldo
    s = s.replace(antes, 'window.location.href = "/calendar" + qs;')
    # Meta: terminó las 9 preguntas
    return reemplazar(s, [("  function finish() {\n", '  function finish() {\n    try { window.fbq && fbq("track", "SubmitApplication"); } catch (e) {}\n')])


def calendario():
    # Sin links internos: al reservar muestra la confirmación en la misma página.
    s = absolutas((RAIZ / "calendario.html").read_text(encoding="utf-8"))
    # Meta: reservó la llamada
    return reemplazar(s, [("        if (body.ok) {\n          renderReservado();\n",
                           '        if (body.ok) {\n          try { window.fbq && fbq("track", "Schedule"); } catch (e) {}\n          renderReservado();\n')])


PAGINAS = {"vsl": vsl, "formulario": formulario, "calendario": calendario}

# Token de cada página (ClickFunnels → paso → Settings → "Page token tag"). Con el SDK, ClickFunnels cuenta visitas y opt-ins.
TOKENS = {
    "vsl": "cfp_4IO29ZxD5M2LbXnaFc19jFz9",
    "formulario": "cfp_o5GfrFhqo3XLL1LlsJ4fpXoX",
    "calendario": "cfp_zGxmQtQEOTntRT8Z9BReOlSx",
}
SDK = '<script src="https://sdk.myclickfunnels.com/sdk.js" defer></script>'
PIXEL_META = "2379181872915932"
PIXEL = ("<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};"
         "if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;"
         "s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');"
         f"fbq('init','{PIXEL_META}');fbq('track','PageView');</script>"
         f'<noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id={PIXEL_META}&ev=PageView&noscript=1"/></noscript>')


def con_sdk(nombre, s):
    t = TOKENS.get(nombre)
    if not t:
        return s
    m = re.search(r"<head[^>]*>", s)
    assert m, "sin <head>"
    return s[: m.end()] + f'\n<meta name="cf-page-token" content="{t}">\n{SDK}\n{PIXEL}' + s[m.end():]


if __name__ == "__main__":
    for nombre, fn in PAGINAS.items():
        destino = SALIDA / f"completa-{nombre}.html"
        destino.write_text(con_sdk(nombre, fn()), encoding="utf-8")
        print(destino.name, destino.stat().st_size, "bytes")
