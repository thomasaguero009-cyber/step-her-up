#!/bin/bash
# Publica el dashboard en https://dash.stepherup.com
# Copia dashboard.html de este repo al repo del dominio (../step-her-up-dash) y lo sube.
# Uso: ./scripts/publicar-dashboard.sh "mensaje del cambio"
set -e
AQUI="$(cd "$(dirname "$0")/.." && pwd)"
DESTINO="$AQUI/../step-her-up-dash"
[ -d "$DESTINO/.git" ] || { echo "No encuentro $DESTINO (repo thomasaguero009-cyber/step-her-up-dash)"; exit 1; }
cp "$AQUI/dashboard.html" "$DESTINO/index.html"
cd "$DESTINO"
if git diff --quiet -- index.html; then echo "dash.stepherup.com ya está al día."; exit 0; fi
git add index.html
git commit -q -m "${1:-Actualizar dashboard}"
git push -q origin main
echo "Publicado. En 1 o 2 minutos se ve en https://dash.stepherup.com"
