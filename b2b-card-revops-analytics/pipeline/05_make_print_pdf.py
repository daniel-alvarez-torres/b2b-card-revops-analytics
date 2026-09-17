"""
Prepara el dashboard para impresion.

wkhtmltopdf corre sobre Qt WebKit, que no soporta CSS grid ni el atajo `inset`.
En pantalla el layout se sostiene con seis grids; al imprimirlo sin traducir,
esos bloques colapsan uno debajo del otro y el documento pierde la forma.
La traduccion se hace en una hoja anexa al final del <style>, para no tocar
el archivo original que Daniel ya puede abrir en un navegador.
"""
src = open('docs/dashboard.html').read()

PRINT_CSS = """
/* ---- capa de impresion (Qt WebKit) ---- */
html,body{background:#07070A !important}
.wrap{max-width:1010px;margin:0 auto;padding:0 6px 10px}

/* grid -> tabla */
.kpis{display:table;table-layout:fixed;width:100%;border-spacing:0;
border:1px solid var(--line)}
.kpi{display:table-cell;border-left:1px solid var(--line);padding:12px 12px}
.kpi:first-child{border-left:0}
.kpi .v{font-size:19px}
.kpi .k{font-size:10.5px}

.rb-row{display:table;width:100%;table-layout:fixed;border-spacing:0}
.rb-row>*{display:table-cell;vertical-align:middle;padding-right:12px}
.rb-row>*:first-child{width:200px}
.rb-row>*:last-child{width:92px;padding-right:0}

.frow{display:table;width:100%;table-layout:fixed;border-spacing:0}
.frow>*{display:table-cell;vertical-align:middle;padding-right:12px}
.frow>*:first-child{width:186px}
.frow>*:last-child{width:132px;padding-right:0}

.crow{display:table;width:100%;table-layout:fixed;border-spacing:0}
.crow>*{display:table-cell;vertical-align:middle;padding-right:10px}
.crow>*:first-child{width:44px}
.crow>*:nth-child(3){width:48px}
.crow>*:last-child{padding-right:0}

.ledger{display:block;font-size:0}
.led{display:inline-block;width:32.4%;margin:0 1.4% 10px 0;vertical-align:top;
font-size:12px}
.led:nth-child(3n){margin-right:0}

.cols{display:table;width:100%;border-spacing:0}
.cols>*{display:table-cell;width:50%;vertical-align:top;padding-right:26px}
.cols>*:last-child{padding-right:0;padding-left:26px}

/* El grafico de 24 meses apila barras con alturas en porcentaje dentro de un
   contenedor flex. Qt WebKit no resuelve ese porcentaje y las barras salen
   con altura cero: el grafico aparece vacio y solo quedan las etiquetas.
   Abajo pasa a tabla con celdas alineadas al fondo; las alturas se reescriben
   a pixeles mas adelante en este mismo script. */
.trend{display:table;table-layout:fixed;width:100%;border-spacing:1px 0;height:auto}
.tcol{display:table-cell;vertical-align:bottom;height:auto;float:none}
.tstack{display:block;font-size:0;height:auto}
.td,.tp{display:block;width:100%}
.tq{font-size:9px}
.legend{display:block;font-size:11px}
.legend>span{margin-right:16px}

/* `inset` no existe en este motor: las barras dentro de las tablas
   dependen de el y sin esto quedan invisibles */
.s-tot,.s-par,.s-att{top:0;bottom:0;left:0;right:auto}

/* Los degradados salen en blanco en el visor de PDF de iOS: el motor de
   wkhtmltopdf los escribe como un patron que PDFKit no dibuja, y la barra
   queda del color del papel. Color plano en su lugar. */
.fbar{background:var(--gold)}
.fbar.nr{background:var(--clay)}

/* Una sola pagina continua.
   Con hojas A4 y una seccion por pagina, tres cuartos de cada hoja quedaban
   vacios: en un telefono eso se lee como un documento roto. Una sola pagina
   alta se desliza como una web y no tiene cortes que arreglar. La altura se
   calcula por busqueda binaria en el script de render. */
section{margin-top:46px}
footer{margin-top:44px}
"""

marker = '</style></head>'
assert marker in src, 'no encontre el cierre del <style>'
out = src.replace(marker, PRINT_CSS + marker)

# El bloque responsive a 620px se dispara segun el ancho del papel y
# esconde columnas que si caben; fuera para la version impresa.
import re
def strip_media(css, needle):
    """Corta un bloque @media contando llaves.

    La version con expresion regular fallaba en silencio: el bloque termina con
    dos llaves en la misma linea y el patron esperaba una sola al inicio de
    linea. El resultado era que `.barcell{display:none}` sobrevivia y las barras
    de las tablas desaparecian del PDF sin ningun error.
    """
    i = css.find(needle)
    if i == -1:
        raise SystemExit('no encontre el bloque ' + needle)
    j = css.index('{', i)
    depth, k = 0, j
    while k < len(css):
        if css[k] == '{':
            depth += 1
        elif css[k] == '}':
            depth -= 1
            if depth == 0:
                break
        k += 1
    return css[:i] + css[k + 1:]

out = strip_media(out, '@media(max-width:620px)')
out = out.replace('@media(max-width:760px){.cols{grid-template-columns:1fr;gap:40px}}', '')

# Alturas del grafico de tendencia: de porcentaje a pixeles.
# Solo dentro del bloque .trend, para no tocar otras alturas del documento.
STACK_PX = 150.0
i = out.find('<div class="trend">')
j = out.find('</div>', out.find('class="legend"', i))
if i == -1 or j == -1:
    raise SystemExit('no ubique el bloque de tendencia')
block = out[i:j]
n = [0]
def to_px(m):
    n[0] += 1
    return 'height:%.1fpx' % (float(m.group(1)) / 100.0 * STACK_PX)
block = re.sub(r'height:([0-9.]+)%', to_px, block)
out = out[:i] + block + out[j:]
print('barras convertidas a pixeles:', n[0])

open('docs/print.html','w').write(out)
print('docs/print.html listo:', len(out), 'bytes')
