"""
Convierte "Base SCJ 2009 - 2026 V.2 (Analisis).xlsx" en los JSON que consume la app.
Fuente de holdings oficiales: Tabla N2, Informe Anual de la Industria 2025 (SCJ, jul-2025).
Ejecutar: python3 scripts/build_data.py
"""
import json
import math
from pathlib import Path

import pandas as pd

SOURCE = (
    "/Users/manuelfuica/Library/CloudStorage/OneDrive-MarinadelSolS.A/MARINA DEL SOL/"
    "Base Trabajo MDS MFL/01 - GESTION CORPORATIVA/Gestión/Reportes SCJ/Boletines anuales/"
    "Data Casinos SCJ/Base SCJ 2009 - 2026 V.2 (Analisis).xlsx"
)
OUT_DIR = Path(__file__).resolve().parent.parent / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Casino (nombre en Base Excel) -> (Holding oficial, tier, ciudad ya viene del excel)
HOLDING_MAP = {
    "MDS Calama": ("Marina del Sol", "19995"),
    "MDS Chillán": ("Marina del Sol", "19995"),
    "MDS Talcahuano": ("Marina del Sol", "19995"),
    "MDS Osorno": ("Marina del Sol", "19995"),
    "Enjoy Antofagasta": ("Simunovic - Enjoy", "19995"),
    "Antay Casino & Hotel": ("Luckia", "19995"),
    "Casino Luckia Arica": ("Luckia", "19995"),
    "Ovalle Casino Resort S.A.": ("Boldt - Invergaming", "19995"),
    "Enjoy Coquimbo": ("Casinos de Chile", "19995"),
    "Enjoy San Antonio": ("Enjoy", "19995"),
    "Enjoy Viña del Mar": ("Casinos de Chile", "19995"),
    "Enjoy Santiago": ("Enjoy", "19995"),
    "Sun Monticello": ("Dreams", "19995"),
    "Casino de Colchagua": ("Fundación Cardoen", "19995"),
    "Gran Casino de Talca": ("Corporación Meier", "19995"),
    "Enjoy Los Angeles": ("Enjoy", "19995"),
    "Dreams Temuco": ("Dreams", "19995"),
    "Enjoy Pucón": ("Casinos de Chile", "19995"),
    "Dreams Valdivia": ("Dreams", "19995"),
    "Enjoy Chiloé": ("Casinos de Chile", "19995"),
    "Dreams Coyhaique": ("Dreams", "19995"),
    "Dreams Punta Arenas": ("Dreams", "19995"),
    "Dreams Iquique": ("Dreams", "municipal"),
    "Dreams Puerto Varas": ("Dreams", "municipal"),
    "Puerto Natales": ("Corporación Meier", "municipal"),
}
EXCLUDED_CASINOS = {"Termas de Chillán"}

# Tabla N7, Informe Anual Industria 2025 (SCJ): Ofertas económicas vigentes 2025, en UF.
# Casinos sin fila no pagan OE (permiso otorgado antes de la Ley 20.856 de 2015) o son municipales.
OE_UF_2025 = {
    "MDS Calama": 10641,
    "Enjoy Antofagasta": 111221,
    "Antay Casino & Hotel": 76151,
    "Enjoy Coquimbo": 481501,
    "Enjoy San Antonio": 24003,
    "Enjoy Viña del Mar": 831123,
    "Enjoy Santiago": 11117,
    "Sun Monticello": 25667,
    "Casino de Colchagua": 5452,
    "MDS Talcahuano": 10969,
    "Enjoy Los Angeles": 22532,
    "Dreams Temuco": 12667,
    "Enjoy Pucón": 121000,
    "Dreams Valdivia": 6667,
    "MDS Osorno": 6696,
    "Dreams Punta Arenas": 10667,
}
# UF promedio anual 2025 (fuente: mindicador.cl, serie diaria 2025, promedio de 365 valores).
UF_PROMEDIO_2025 = 39156.97
# Dólar observado promedio 2025 (fuente: mindicador.cl, serie 2025, promedio de 248 valores hábiles).
USD_PROMEDIO_2025 = 951.64

# Nombre del casino tal como aparece en los 16 informes anuales SCJ (data/equipamiento_casinos_raw.json)
# -> nombre canónico usado en HOLDING_MAP. Cubre cambios de marca/operador a través de los años
# (ej. "Casino Sol Calama" antes de la marca MDS, "Arica" durante la transición del casino
# municipal al operador Luckia, etc). None = casino fuera del listado canónico de la app.
EQUIPAMIENTO_NAME_MAP = {
    "Casino Sol Calama": "MDS Calama",
    "Marina del Sol Calama": "MDS Calama",
    "Casino Sol Osorno": "MDS Osorno",
    "Marina del Sol Osorno": "MDS Osorno",
    "Marina del Sol": "MDS Talcahuano",
    "Marina del Sol Talcahuano": "MDS Talcahuano",
    "Marina del Sol Chillán": "MDS Chillán",
    "Enjoy Antofagasta": "Enjoy Antofagasta",
    "Antay Casino & Hotel": "Antay Casino & Hotel",
    "Arica": "Casino Luckia Arica",
    "Casino Arica": "Casino Luckia Arica",
    "Casino Municipal de Arica": "Casino Luckia Arica",
    "Casino Luckia Arica": "Casino Luckia Arica",
    "Ovalle Casino & Resort": "Ovalle Casino Resort S.A.",
    "Coquimbo": "Enjoy Coquimbo",
    "Enjoy Coquimbo": "Enjoy Coquimbo",
    "Casino de Juegos del Pacífico": "Enjoy San Antonio",
    "Enjoy Viña": "Enjoy Viña del Mar",
    "Enjoy Viña del Mar": "Enjoy Viña del Mar",
    "Casino Rinconada": "Enjoy Santiago",
    "Casino de Juego de Rinconada": "Enjoy Santiago",
    "Enjoy Santiago": "Enjoy Santiago",
    "Monticello Grand Casino": "Sun Monticello",
    "Casino Monticello": "Sun Monticello",
    "Sun Monticello": "Sun Monticello",
    "Casino de Colchagua": "Casino de Colchagua",
    "Casino Colchagua": "Casino de Colchagua",
    "Gran Casino de Talca": "Gran Casino de Talca",
    "Casino de Juego Talca": "Gran Casino de Talca",
    "Casino Gran Los Angeles": "Enjoy Los Angeles",
    "Casino Gran Los Ángeles": "Enjoy Los Angeles",
    "Dreams Temuco": "Dreams Temuco",
    "Casino Dreams Temuco": "Dreams Temuco",
    "Enjoy Pucón": "Enjoy Pucón",
    "Pucón": "Enjoy Pucón",
    "Dreams Valdivia": "Dreams Valdivia",
    "Casino Dreams Valdivia": "Dreams Valdivia",
    "Enjoy Chiloé": "Enjoy Chiloé",
    "Dreams Coyhaique": "Dreams Coyhaique",
    "Casino Dreams Coyhaique": "Dreams Coyhaique",
    "Dreams Punta Arenas": "Dreams Punta Arenas",
    "Casino Dreams Punta Arenas": "Dreams Punta Arenas",
    "Casino Dreams Iquique": "Dreams Iquique",
    "Iquique": "Dreams Iquique",
    "Casino Dreams Puerto Varas": "Dreams Puerto Varas",
    "Puerto Varas": "Dreams Puerto Varas",
    "Casino de Puerto Natales": "Puerto Natales",
    "Casino Municipal Puerto Natales": "Puerto Natales",
    "Natales": "Puerto Natales",
    "Termas de Chillán": None,
}


def load_equipamiento():
    """Reconcilia data/equipamiento_casinos_raw.json (extraído de los 16 informes anuales SCJ,
    nombres de casino históricos) contra el listado canónico. Entre 2018 y 2021 el casino de
    Arica aparece dos veces por año (el operador municipal saliente y Casino Luckia Arica
    entrante); en esos casos se conserva solo el registro de Casino Luckia Arica."""
    raw_path = OUT_DIR / "equipamiento_casinos_raw.json"
    if not raw_path.exists():
        return []
    raw = json.loads(raw_path.read_text(encoding="utf-8"))
    by_key = {}
    for r in raw:
        canon = EQUIPAMIENTO_NAME_MAP.get(r["casino_informe"])
        if canon is None:
            continue
        key = (r["anio"], canon)
        if key in by_key and r["casino_informe"] != "Casino Luckia Arica":
            continue  # descarta el operador saliente en años de transición
        by_key[key] = {
            "casino": canon,
            "anio": r["anio"],
            "mesas_total": r["mesas_total"],
            "mesas_por_tipo": r["mesas_por_tipo"],
            "bingo_mesas": r["bingo_mesas"],
            "maquinas_azar": r["maquinas_azar"],
            "fuente_tabla": r["fuente_tabla"],
            "notas": r.get("notas"),
        }
    return sorted(by_key.values(), key=lambda r: (r["anio"], r["casino"]))


GRUPO_GRANDE_MAP = {
    "Enjoy": "Enjoy",
    "Casinos de Chile": "Casinos de Chile",
    "Dreams": "Dreams",
    "Marina del Sol": "Marina del Sol",
    "Luckia": "Otros",
    "Corporación Meier": "Otros",
    "Boldt - Invergaming": "Otros",
    "Fundación Cardoen": "Otros",
    "Simunovic - Enjoy": "Otros",
}


def load_consolidado():
    xl = pd.ExcelFile(SOURCE)
    df = xl.parse("Consolidado")
    df = df[~df["Casino"].isin(EXCLUDED_CASINOS)].copy()
    df["Indicador"] = df["Indicador"].apply(
        lambda s: "Win Total" if str(s).strip().lower() == "win total" else s
    )
    df["Holding"] = df["Casino"].map(lambda c: HOLDING_MAP.get(c, ("Sin clasificar", "19995"))[0])
    df["Tier"] = df["Casino"].map(lambda c: HOLDING_MAP.get(c, ("Sin clasificar", "19995"))[1])
    df["Grupo Grande"] = df["Holding"].map(lambda h: GRUPO_GRANDE_MAP.get(h, "Otros"))
    unmapped = sorted(set(df.loc[df["Holding"] == "Sin clasificar", "Casino"]))
    if unmapped:
        print("ADVERTENCIA - casinos sin mapeo de holding:", unmapped)
    return df


def load_deflactor():
    xl = pd.ExcelFile(SOURCE)
    df = xl.parse("Deflactor_IPC", header=3)
    df.columns = [str(c).strip() for c in df.columns]
    df = df.dropna(subset=["Año"])
    df["Año"] = df["Año"].astype(int)
    return df


def main():
    df = load_consolidado()
    deflactor = load_deflactor()

    factor_col = [c for c in deflactor.columns if "Factor" in c][0]
    factor_by_year = dict(zip(deflactor["Año"], deflactor[factor_col]))

    casinos_meta = (
        df[["Casino", "Holding", "Tier", "Ciudad"]]
        .drop_duplicates()
        .sort_values(["Holding", "Casino"])
        .to_dict(orient="records")
    )
    for c in casinos_meta:
        oe_uf = OE_UF_2025.get(c["Casino"])
        c["OE_UF"] = oe_uf
        c["OE_CLP"] = round(oe_uf * UF_PROMEDIO_2025) if oe_uf is not None else None

    records = df[["Casino", "Holding", "Tier", "Grupo Grande", "Ciudad", "Indicador", "Mes", "Año", "Valor"]]
    records = records.where(pd.notnull(records), None)
    records_list = records.to_dict(orient="records")
    for r in records_list:
        v = r["Valor"]
        r["Valor"] = None if v is None or (isinstance(v, float) and math.isnan(v)) else round(float(v), 2)

    payload = {
        "generated_at": pd.Timestamp.now().strftime("%Y-%m-%d"),
        "casinos": casinos_meta,
        "deflactor": {int(a): float(f) for a, f in factor_by_year.items()},
        "oferta_economica": {
            "año_referencia": 2025,
            "uf_promedio": UF_PROMEDIO_2025,
            "fuente_uf": "mindicador.cl (promedio de valores diarios 2025)",
            "fuente_oe": "Tabla N°7, Informe Anual de la Industria 2025, SCJ",
            "total_uf": sum(OE_UF_2025.values()),
        },
        "conversion": {
            "año_referencia": 2025,
            "uf_promedio": UF_PROMEDIO_2025,
            "usd_promedio": USD_PROMEDIO_2025,
            "fuente": "mindicador.cl (promedio de valores diarios/hábiles 2025)",
        },
        "records": records_list,
        "equipamiento": load_equipamiento(),
    }

    (OUT_DIR / "scj_data.json").write_text(
        json.dumps(payload, ensure_ascii=False),
        encoding="utf-8",
    )
    print(
        f"OK: {len(records_list)} registros, {len(casinos_meta)} casinos, "
        f"{len(payload['equipamiento'])} registros de equipamiento -> {OUT_DIR / 'scj_data.json'}"
    )


if __name__ == "__main__":
    main()
