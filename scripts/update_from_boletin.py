"""
Revisa la sección "Boletín Estadístico" de scj.gob.cl/casinos-fisicos/ y, si existe un mes
publicado que aún no está reflejado en data/scj_data.json, descarga el Excel del boletín,
extrae Ingresos Brutos del Juego ("Win Total") y Visitas por casino, y actualiza el JSON.

Este script SOLO toca data/scj_data.json (los indicadores Win Mesas/Win Slot/Coin in/Hold Slot,
que no vienen en el boletín público mensual, no se usan en ningún lugar de app.js y se dejan
intactos). No modifica el Excel maestro "Base SCJ 2009 - 2026 V.2 (Analisis).xlsx" en OneDrive:
ese archivo sigue siendo la fuente de verdad editada manualmente; este script es un complemento
para no perder actualidad entre boletín y boletín.

Uso:
    python3 scripts/update_from_boletin.py            # aplica cambios si hay boletín nuevo
    python3 scripts/update_from_boletin.py --dry-run   # solo reporta, no escribe el JSON

Salida: imprime un resumen legible y termina con código 0 si no hubo error (haya habido o no
actualización), y código 1 si algo no se pudo validar con confianza (para que el proceso que
invoca este script sepa que NO debe hacer commit/push).
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path

import pandas as pd
import requests

AJAX_URL = "https://www.scj.gob.cl/wp-admin/admin-ajax.php"
CATEGORY_ID_BOLETIN = 23  # "Boletín Estadístico" en scj.gob.cl/casinos-fisicos/
DATA_PATH = Path(__file__).resolve().parent.parent / "data" / "scj_data.json"
UA = "Mozilla/5.0 (compatible; SCJ-Dashboard-UpdateBot/1.0)"

MESES_ES = [
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
]

# Nombre del casino tal como aparece en el boletín mensual público -> nombre canónico usado
# en la app (mismo criterio que EQUIPAMIENTO_NAME_MAP en build_data.py). Cubre las variantes
# de marca "Marina del Sol X" -> "MDS X" y los tres casinos municipales que en el boletín
# aparecen solo con el nombre de su ciudad.
NAME_MAP = {
    "Casino Luckia Arica": "Casino Luckia Arica",
    "Marina del Sol Calama": "MDS Calama",
    "Enjoy Antofagasta": "Enjoy Antofagasta",
    "Antay Casino & Hotel": "Antay Casino & Hotel",
    "Ovalle Casino Resort S.A.": "Ovalle Casino Resort S.A.",
    "Enjoy Coquimbo": "Enjoy Coquimbo",
    "Casino de Juegos del Pacífico": "Enjoy San Antonio",
    "Enjoy Viña del Mar": "Enjoy Viña del Mar",
    "Enjoy Santiago": "Enjoy Santiago",
    "Monticello": "Sun Monticello",
    "Casino de Colchagua": "Casino de Colchagua",
    "Gran Casino de Talca": "Gran Casino de Talca",
    "Marina del Sol Chillán": "MDS Chillán",
    "Marina del Sol Talcahuano": "MDS Talcahuano",
    "Casino Gran Los Ángeles": "Enjoy Los Angeles",
    "Dreams Temuco": "Dreams Temuco",
    "Enjoy Pucón": "Enjoy Pucón",
    "Dreams Valdivia": "Dreams Valdivia",
    "Marina del Sol Osorno": "MDS Osorno",
    "Enjoy Chiloé": "Enjoy Chiloé",
    "Dreams Coyhaique": "Dreams Coyhaique",
    "Dreams Punta Arenas": "Dreams Punta Arenas",
    "Iquique": "Dreams Iquique",
    "Puerto Varas": "Dreams Puerto Varas",
    "Puerto Natales": "Puerto Natales",
}
EXPECTED_CASINOS = 25


def strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def fetch_boletines(year):
    """Llama al mismo endpoint AJAX que usa el buscador de la página pública."""
    resp = requests.post(
        AJAX_URL,
        data={"action": "buscar_posts_por_categoria_y_ano", "category_id": CATEGORY_ID_BOLETIN, "year": year},
        headers={"User-Agent": UA},
        timeout=30,
    )
    resp.raise_for_status()
    html = resp.text
    items = []
    for m in re.finditer(
        r'<a href="([^"]+\.xlsx)"[^>]*>.*?<h5[^>]*>([^<]+)</h5>',
        html,
        re.DOTALL,
    ):
        url, title = m.group(1), m.group(2).strip()
        items.append({"url": url, "title": title})
    return items


MONTH_TITLE_RE = re.compile(
    r"BOLET[IÍ]N ESTAD[IÍ]STICO\s+([A-ZÑ]+)(?:\s+DE)?\s+(\d{4})", re.IGNORECASE
)
URL_YEARMONTH_RE = re.compile(r"Boletin-Estadistico-(\d{4})-(\d{2})", re.IGNORECASE)


def parse_monthly_title(title):
    """Devuelve (año, mes) si el título corresponde a un boletín MENSUAL (no trimestral/anual),
    o None si no matchea ese patrón."""
    t = strip_accents(title.upper())
    m = MONTH_TITLE_RE.search(t)
    if not m:
        return None
    mes_txt, año_txt = m.group(1).strip(), m.group(2)
    meses_upper = [strip_accents(x.upper()) for x in MESES_ES]
    if mes_txt not in meses_upper:
        return None  # p.ej. "PRIMER TRIMESTRE" no matchea ningún nombre de mes
    mes = meses_upper.index(mes_txt) + 1
    return int(año_txt), mes


def parse_url_yearmonth(url):
    """Extrae (año, mes) del nombre de archivo del boletín.
    Fallback para boletines trimestrales/semestrales cuyo título no contiene nombre de mes
    explícito (p.ej. 'SEGUNDO TRIMESTRE DE 2026' → Boletin-Estadistico-2026-06.xlsx → (2026, 6))."""
    m = URL_YEARMONTH_RE.search(url)
    if not m:
        return None
    año, mes = int(m.group(1)), int(m.group(2))
    if not (1 <= mes <= 12):
        return None
    return año, mes


def latest_month_in_data(records, año):
    meses = sorted(
        {r["Mes"] for r in records if r["Año"] == año and r["Indicador"] == "Win Total" and r["Valor"] is not None}
    )
    return meses[-1] if meses else 0


def parse_sheet(xl, sheet_name):
    """Extrae {casino_canónico: {mes: valor}} de la PRIMERA tabla de una hoja del boletín
    (columna 1 = nombre casino, columna 2 = comuna, columnas 3-14 = Enero..Diciembre).

    Las hojas 'Visitas' e 'Impuestos' del boletín público apilan varias tablas con el mismo
    formato de fila una debajo de otra en el mismo sheet (p.ej. 'Visitas' trae Número de
    Visitas, luego Impuesto por Entradas, luego Gasto Promedio por Visita). Solo nos interesa
    la primera tabla de cada hoja (la que da nombre a la hoja), así que la función localiza el
    primer encabezado 'Casinos de Juego' y deja de leer en la primera fila con la columna de
    nombre vacía (separador antes de la siguiente tabla)."""
    df = xl.parse(sheet_name, header=None)
    header_row = None
    for i in range(len(df)):
        if df.shape[1] > 1 and str(df.iat[i, 1]).strip() == "Casinos de Juego":
            header_row = i
            break
    if header_row is None:
        return {}, ['no se encontró la fila de encabezado "Casinos de Juego"']

    out = {}
    unmapped = []
    for i in range(header_row + 1, len(df)):
        nombre = df.iat[i, 1] if df.shape[1] > 1 else None
        if pd.isna(nombre):
            break  # fin de la primera tabla de la hoja
        comuna = df.iat[i, 2] if df.shape[1] > 2 else None
        if pd.isna(comuna):
            continue  # fila de sección ("Casinos municipales", "Total...", etc.), no es un casino
        nombre = str(nombre).strip()
        canon = NAME_MAP.get(nombre)
        if canon is None:
            unmapped.append(nombre)
            continue
        meses = {}
        for mes_idx in range(12):
            col = 3 + mes_idx
            if col >= df.shape[1]:
                break
            v = df.iat[i, col]
            if pd.isna(v):
                continue
            meses[mes_idx + 1] = round(float(v), 2)
        out[canon] = meses
    return out, unmapped


def build_updates(url, año, mes):
    resp = requests.get(url, headers={"User-Agent": UA}, timeout=60)
    resp.raise_for_status()
    xl = pd.ExcelFile(pd.io.common.BytesIO(resp.content))

    win, unmapped_win = parse_sheet(xl, "Ingresos Brutos del Juego")
    vis, unmapped_vis = parse_sheet(xl, "Visitas")

    problems = []
    if unmapped_win:
        problems.append(f"Casinos sin mapeo en hoja Ingresos Brutos: {sorted(set(unmapped_win))}")
    if unmapped_vis:
        problems.append(f"Casinos sin mapeo en hoja Visitas: {sorted(set(unmapped_vis))}")
    if len(win) != EXPECTED_CASINOS:
        problems.append(f"Se esperaban {EXPECTED_CASINOS} casinos en Ingresos Brutos, se leyeron {len(win)}")
    if len(vis) != EXPECTED_CASINOS:
        problems.append(f"Se esperaban {EXPECTED_CASINOS} casinos en Visitas, se leyeron {len(vis)}")
    for casino, meses in win.items():
        if mes not in meses:
            problems.append(f"{casino}: sin valor de Win Total para el mes {mes} en el boletín descargado")
    for casino, meses in vis.items():
        if mes not in meses:
            problems.append(f"{casino}: sin valor de Visitas para el mes {mes} en el boletín descargado")

    updates = []  # (casino, indicador, mes, año, valor)
    for casino, meses in win.items():
        for m, v in meses.items():
            updates.append((casino, "Win Total", m, año, v))
    for casino, meses in vis.items():
        for m, v in meses.items():
            updates.append((casino, "Visitas", m, año, v))
    return updates, problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    payload = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    records = payload["records"]
    # payload["casinos"] no trae "Grupo Grande" (ese campo solo vive en los records individuales
    # del Consolidado), así que la metadata para registros nuevos se toma del primer record ya
    # existente de cada casino, no de payload["casinos"].
    meta_by_casino = {}
    for r in records:
        meta_by_casino.setdefault(
            r["Casino"],
            {"Holding": r["Holding"], "Tier": r["Tier"], "Grupo Grande": r["Grupo Grande"], "Ciudad": r["Ciudad"]},
        )

    current_year_candidates = sorted({r["Año"] for r in records if r["Año"] >= 2024})
    import datetime
    hoy = datetime.date.today()
    years_to_check = sorted({hoy.year, hoy.year - 1})

    boletines = []
    for y in years_to_check:
        try:
            boletines += fetch_boletines(y)
        except Exception as e:
            print(f"AVISO: no se pudo consultar boletines del año {y}: {e}")

    monthly = []
    for b in boletines:
        parsed = parse_monthly_title(b["title"]) or parse_url_yearmonth(b["url"])
        if parsed:
            monthly.append((parsed[0], parsed[1], b["url"], b["title"]))

    if not monthly:
        print("No se encontraron boletines mensuales en scj.gob.cl. Nada que hacer.")
        if not args.dry_run:
            payload["last_checked"] = hoy.strftime("%Y-%m-%d")
            DATA_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 0

    monthly.sort()
    año, mes, url, title = monthly[-1]
    último_en_datos = latest_month_in_data(records, año)
    if not último_en_datos and año > 0:
        # si el año más reciente del boletín aún no tiene NINGÚN mes en los datos (p.ej. enero
        # recién publicado), comparamos igual: 0 < mes siempre es cierto, se procesa.
        pass

    print(f"Boletín más reciente detectado: '{title}' -> {MESES_ES[mes-1]} {año} ({url})")
    print(f"Último mes con datos en scj_data.json para {año}: {último_en_datos or 'ninguno'}")

    if mes <= último_en_datos:
        print("Los datos ya están al día. No se requiere actualización.")
        # Igual dejamos constancia de que hoy se verificó contra scj.cl, aunque no haya
        # cambios en los indicadores: el pie de página del dashboard usa este campo para
        # mostrar la fecha de la última verificación automática.
        if not args.dry_run:
            payload["last_checked"] = hoy.strftime("%Y-%m-%d")
            DATA_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 0

    print(f"Descargando y procesando boletín de {MESES_ES[mes-1]} {año}...")
    updates, problems = build_updates(url, año, mes)

    if problems:
        print("ERROR: la validación del boletín descargado falló, no se aplican cambios:")
        for p in problems:
            print(f"  - {p}")
        return 1

    index = {(r["Casino"], r["Indicador"], r["Mes"], r["Año"]): idx for idx, r in enumerate(records)}
    n_new, n_changed, n_same = 0, 0, 0
    cambios_detalle = []
    for casino, indicador, m, y, valor in updates:
        key = (casino, indicador, m, y)
        meta = meta_by_casino.get(casino, {})
        if key in index:
            rec = records[index[key]]
            if rec["Valor"] != valor:
                cambios_detalle.append(f"  {casino} / {indicador} / {m}-{y}: {rec['Valor']} -> {valor}")
                rec["Valor"] = valor
                n_changed += 1
            else:
                n_same += 1
        else:
            records.append({
                "Casino": casino,
                "Holding": meta.get("Holding"),
                "Tier": meta.get("Tier"),
                "Grupo Grande": meta.get("Grupo Grande"),
                "Ciudad": meta.get("Ciudad"),
                "Indicador": indicador,
                "Mes": m,
                "Año": y,
                "Valor": valor,
            })
            cambios_detalle.append(f"  {casino} / {indicador} / {m}-{y}: (nuevo) {valor}")
            n_new += 1

    print(f"Registros nuevos: {n_new} · Registros corregidos: {n_changed} · Sin cambio: {n_same}")
    for línea in cambios_detalle[:60]:
        print(línea)
    if len(cambios_detalle) > 60:
        print(f"  ... y {len(cambios_detalle) - 60} más")

    if args.dry_run:
        print("(--dry-run) No se escribió data/scj_data.json.")
        return 0

    payload["last_checked"] = hoy.strftime("%Y-%m-%d")
    if n_new == 0 and n_changed == 0:
        print("No hubo cambios reales que escribir (solo se actualiza la fecha de verificación).")
        DATA_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return 0

    payload["generated_at"] = hoy.strftime("%Y-%m-%d")
    DATA_PATH.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"OK: data/scj_data.json actualizado con el boletín de {MESES_ES[mes-1]} {año}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
