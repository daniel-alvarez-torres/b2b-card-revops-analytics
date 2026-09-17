#!/bin/bash
# $1 = alto en mm, $2 = salida
xvfb-run -a wkhtmltopdf --enable-local-file-access \
  --page-width 297mm --page-height "$1mm" \
  --margin-top 8mm --margin-bottom 8mm --margin-left 10mm --margin-right 10mm \
  docs/print.html "$2" 2>/dev/null
pdfinfo "$2" | awk '/^Pages/{print $2}'
