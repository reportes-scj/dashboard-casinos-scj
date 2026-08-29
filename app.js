(function () {
  'use strict';

  const DATA_URL = 'data/scj_data.json';
  const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

  const HOLDING_ORDER = [
    'Enjoy', 'Casinos de Chile', 'Dreams', 'Marina del Sol', 'Luckia',
    'Corporación Meier', 'Boldt - Invergaming', 'Fundación Cardoen', 'Simunovic - Enjoy',
  ];
  const GRUPO_ORDER = ['Enjoy', 'Casinos de Chile', 'Dreams', 'Marina del Sol', 'Otros'];
  const GRUPO_GRANDE_MAP = {
    'Enjoy': 'Enjoy', 'Casinos de Chile': 'Casinos de Chile', 'Dreams': 'Dreams',
    'Marina del Sol': 'Marina del Sol', 'Luckia': 'Otros', 'Corporación Meier': 'Otros',
    'Boldt - Invergaming': 'Otros', 'Fundación Cardoen': 'Otros', 'Simunovic - Enjoy': 'Otros',
  };
  // Paleta para el Resumen Mensual (año contra año): de más antiguo (claro) a más reciente
  // (oscuro), dentro de la paleta "Finanzas & Banca" (navy/celeste).
  const YEAR_COLORS = ['#a9c9e3', '#1F4E78', '#0B1F33'];
  // Degradado de azules ("Finanzas & Banca": navy oscuro → celeste claro) para rankings
  // ordenados por valor, del más alto (oscuro) al más bajo (claro). Reemplaza la paleta
  // categórica multicolor en gráficos donde solo importa el orden, no la identidad fija de
  // cada entidad (para identidad fija por holding, ver HOLDING_TONES más abajo).
  function brandShades(n) {
    if (n <= 1) return ['#1F4E78'];
    const out = [];
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const lightness = 14 + t * 55; // 14% (navy oscuro) → 69% (celeste claro)
      out.push(`hsl(209, 55%, ${lightness}%)`);
    }
    return out;
  }

  // Tono de azul fijo por holding (misma identidad en toda la app: Resumen Ejecutivo, Holdings,
  // Equipamiento), en vez de la paleta categórica multicolor que tenía antes cada holding.
  // El orden es el de HOLDING_ORDER (Tabla N°2 SCJ), no un ranking por tamaño, para que un mismo
  // holding conserve siempre el mismo tono sin importar la vista o el período.
  const HOLDING_TONES = {};
  brandShades(HOLDING_ORDER.length).forEach((color, i) => { HOLDING_TONES[HOLDING_ORDER[i]] = color; });

  let RAW = null;
  let CASINOS = [];       // metadata array
  let CASINO_INDEX = {};  // casino -> {Holding, Tier, Ciudad, OE_UF, OE_CLP}
  let TREE = {};          // casino -> year -> month -> indicador -> valor
  let YEARS = [];         // sorted unique years with any data
  let EQUIPAMIENTO = [];  // {casino, anio, mesas_total, mesas_por_tipo, bingo_mesas, maquinas_azar, fuente_tabla, notas}
  let LIVE_DEFLACTOR = null;
  let LIVE_UF = null;
  let LIVE_USD = null;

  const CACHE_KEY = 'scj_indicadores_cache_v1';
  const OVERRIDE_KEY = 'scj_data_override_v1';
  const ADM_PASSWORD = 'SCJ';
  let admAuth = false;

  function cargarOverrideAdmin() {
    try {
      const raw = localStorage.getItem(OVERRIDE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return (parsed && parsed.records) || [];
    } catch (e) {
      return [];
    }
  }
  function infoOverrideAdmin() {
    try {
      const raw = localStorage.getItem(OVERRIDE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function guardarOverrideAdmin(nuevos) {
    try {
      const existing = cargarOverrideAdmin();
      const map = {};
      existing.forEach((r) => { map[`${r.Casino}|${r.Año}|${r.Mes}|${r.Indicador}`] = r; });
      nuevos.forEach((r) => { map[`${r.Casino}|${r.Año}|${r.Mes}|${r.Indicador}`] = r; });
      localStorage.setItem(OVERRIDE_KEY, JSON.stringify({ records: Object.values(map), timestamp: new Date().toISOString() }));
    } catch (e) { /* localStorage no disponible (modo privado, cuota, etc.) */ }
  }
  function limpiarOverrideAdmin() {
    try { localStorage.removeItem(OVERRIDE_KEY); } catch (e) { /* no-op */ }
  }

  function guardarCacheIndicadores() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        deflactor: LIVE_DEFLACTOR, uf: LIVE_UF, usd: LIVE_USD, timestamp: new Date().toISOString(),
      }));
    } catch (e) { /* localStorage no disponible (modo privado, cuota, etc.) */ }
  }

  function cargarCacheIndicadores() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function aplicarCacheIndicadores() {
    const cache = cargarCacheIndicadores();
    if (!cache) return null;
    if (cache.deflactor) LIVE_DEFLACTOR = cache.deflactor;
    if (cache.uf) LIVE_UF = cache.uf;
    if (cache.usd) LIVE_USD = cache.usd;
    return cache;
  }

  const state = {
    valueMode: 'nominal',
    yearFrom: null,
    yearTo: null,
    view: 'resumen',
    casinosSeleccionados: [],
    mensualScope: 'industria',
    mensualEntidad: null,
    mensualYears: null,
    industriaGranularidad: 'anual',
    excluirPandemia: false,
    trendFrom: null,
    periodMode: 'anual',
  };

  function yearsInRange(yFrom, yTo) {
    const arr = [];
    for (let y = yFrom; y <= yTo; y++) {
      if (state.excluirPandemia && (y === 2020 || y === 2021)) continue;
      arr.push(y);
    }
    return arr;
  }

  const charts = {};

  // ---------------------------------------------------------------------
  // Carga e indexación
  // ---------------------------------------------------------------------

  async function loadData() {
    const res = await fetch(DATA_URL);
    if (!res.ok) throw new Error('No se pudo cargar ' + DATA_URL);
    RAW = await res.json();
    CASINOS = RAW.casinos;
    EQUIPAMIENTO = RAW.equipamiento || [];
    CASINO_INDEX = {};
    CASINOS.forEach((c) => { CASINO_INDEX[c.Casino] = c; });

    TREE = {};
    const yearSet = new Set();
    RAW.records.forEach((r) => {
      yearSet.add(r['Año']);
      const casino = r['Casino'];
      const year = r['Año'];
      const month = r['Mes'];
      const ind = r['Indicador'];
      if (!TREE[casino]) TREE[casino] = {};
      if (!TREE[casino][year]) TREE[casino][year] = {};
      if (!TREE[casino][year][month]) TREE[casino][year][month] = {};
      TREE[casino][year][month][ind] = r['Valor'];
    });
    YEARS = Array.from(yearSet).sort((a, b) => a - b);

    // Aplica sobre los datos base cualquier carga manual guardada por el administrador
    // en este navegador (ver módulo de Administración, más abajo).
    const overrides = cargarOverrideAdmin();
    if (overrides.length) {
      overrides.forEach((r) => aplicarRegistroEnArbol(r));
      const yearSet2 = new Set(YEARS);
      overrides.forEach((r) => yearSet2.add(r['Año']));
      YEARS = Array.from(yearSet2).sort((a, b) => a - b);
    }
  }

  function aplicarRegistroEnArbol(r) {
    const casino = r.Casino, anio = r['Año'], mes = r.Mes, ind = r.Indicador;
    if (!TREE[casino]) TREE[casino] = {};
    if (!TREE[casino][anio]) TREE[casino][anio] = {};
    if (!TREE[casino][anio][mes]) TREE[casino][anio][mes] = {};
    TREE[casino][anio][mes][ind] = r.Valor;
  }

  function deflactorFactor(year) {
    const table = LIVE_DEFLACTOR || RAW.deflactor;
    const f = table[String(year)];
    return f === undefined ? 1 : f;
  }

  function ufReferencia() {
    return LIVE_UF ? LIVE_UF.valor : RAW.conversion.uf_promedio;
  }
  function usdReferencia() {
    return LIVE_USD ? LIVE_USD.valor : RAW.conversion.usd_promedio;
  }

  function deflate(valorNominal, year) {
    if (valorNominal === null || valorNominal === undefined) return null;
    if (state.valueMode === 'real') return valorNominal * deflactorFactor(year);
    if (state.valueMode === 'uf') return valorNominal / ufReferencia();
    if (state.valueMode === 'usd') return valorNominal / usdReferencia();
    return valorNominal;
  }

  // ---------------------------------------------------------------------
  // Agregación
  // ---------------------------------------------------------------------

  function monthValue(casino, year, month, indicador) {
    const v = TREE[casino] && TREE[casino][year] && TREE[casino][year][month]
      ? TREE[casino][year][month][indicador]
      : undefined;
    return v === undefined ? null : v;
  }

  function casinosFor(scope, key) {
    if (scope === 'industria') return CASINOS.map((c) => c.Casino);
    if (scope === 'holding') return CASINOS.filter((c) => c.Holding === key).map((c) => c.Casino);
    if (scope === 'grupo') return CASINOS.filter((c) => GRUPO_GRANDE_MAP[c.Holding] === key).map((c) => c.Casino);
    if (scope === 'tier') return CASINOS.filter((c) => c.Tier === key).map((c) => c.Casino);
    if (scope === 'casino') return [key];
    return [];
  }

  // Suma nominal de un indicador de flujo para un conjunto de casinos, en un año,
  // opcionalmente limitado a un rango de meses [1..hastaMes]. Devuelve {valor, meses}.
  function sumFlowNominal(casinoList, year, indicador, hastaMes) {
    let total = 0;
    let meses = 0;
    let any = false;
    const limMes = hastaMes || 12;
    casinoList.forEach((casino) => {
      for (let m = 1; m <= limMes; m++) {
        const v = monthValue(casino, year, m, indicador);
        if (v !== null && v !== undefined) {
          total += v;
          any = true;
        }
      }
    });
    // meses con al menos un dato en la industria/holding, usado para detectar años parciales
    for (let m = 1; m <= limMes; m++) {
      const hasAny = casinoList.some((c) => monthValue(c, year, m, indicador) !== null);
      if (hasAny) meses++;
    }
    return { valor: any ? total : null, meses };
  }

  function aggFlowReal(casinoList, year, indicador, hastaMes) {
    const { valor, meses } = sumFlowNominal(casinoList, year, indicador, hastaMes);
    if (valor === null) return { valor: null, meses };
    return { valor: deflate(valor, year), meses };
  }

  function ticketPromedio(winTotal, visitas) {
    if (winTotal === null || visitas === null || !visitas) return null;
    return winTotal / visitas;
  }

  function monthsWithData(casinoList, year, indicador) {
    let n = 0;
    for (let m = 1; m <= 12; m++) {
      if (casinoList.some((c) => monthValue(c, year, m, indicador) !== null)) n++;
    }
    return n;
  }

  function latestYearInfo() {
    const all = CASINOS.map((c) => c.Casino);
    const maxYear = YEARS[YEARS.length - 1];
    let meses = monthsWithData(all, maxYear, 'Visitas');
    if (meses === 0) {
      const y = maxYear - 1;
      return { year: y, meses: monthsWithData(all, y, 'Visitas') };
    }
    return { year: maxYear, meses };
  }

  // ---------------------------------------------------------------------
  // Formato
  // ---------------------------------------------------------------------

  const nfCLP = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 });
  const nfDec = new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1, minimumFractionDigits: 1 });

  function fmtCLP(v) { return v === null || v === undefined ? '—' : '$' + nfCLP.format(Math.round(v)); }
  function fmtMM(v) { return v === null || v === undefined ? '—' : '$' + nfCLP.format(Math.round(v / 1e6)) + ' MM'; }
  function fmtNum(v) { return v === null || v === undefined ? '—' : nfCLP.format(Math.round(v)); }
  // Variantes sensibles al modo de valor (nominal/real/UF/USD), para cifras ya convertidas vía deflate().
  function fmtMoney(v) {
    if (v === null || v === undefined) return '—';
    const n = nfCLP.format(Math.round(v));
    if (state.valueMode === 'uf') return n + ' UF';
    if (state.valueMode === 'usd') return 'US$' + n;
    return '$' + n;
  }
  function fmtMoneyMM(v) {
    if (v === null || v === undefined) return '—';
    const n = nfCLP.format(Math.round(v / 1e6));
    if (state.valueMode === 'uf') return n + ' MM UF';
    if (state.valueMode === 'usd') return 'US$' + n + ' MM';
    return '$' + n + ' MM';
  }
  // fmtMoneyMM asume magnitudes de industria (miles de millones); para un casino individual
  // o un holding pequeño el mismo monto puede quedar por debajo del millón y mostrarse como
  // "0 MM". fmtMoneyAuto elige automáticamente entre fmtMoney y fmtMoneyMM según la magnitud.
  function fmtMoneyAuto(v) {
    if (v === null || v === undefined) return '—';
    return Math.abs(v) >= 1e6 ? fmtMoneyMM(v) : fmtMoney(v);
  }
  function valueModeLabel() {
    switch (state.valueMode) {
      case 'real': return 'reales (pesos actuales)';
      case 'uf': return 'en UF';
      case 'usd': return 'en dólares (USD)';
      default: return 'nominales';
    }
  }
  // Unidad monetaria a la que corresponde la abreviatura MM (fmtMoneyMM), según el modo de valor vigente.
  function moneyMMUnitLabel() {
    switch (state.valueMode) {
      case 'uf': return 'millones de UF';
      case 'usd': return 'millones de dólares (USD)';
      default: return 'millones de pesos';
    }
  }
  function fmtPct(v, decimals) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(decimals === undefined ? 1 : decimals) + '%';
  }
  function fmtPctPlain(v, decimals) {
    if (v === null || v === undefined || isNaN(v)) return '—';
    return (v * 100).toFixed(decimals === undefined ? 1 : decimals) + '%';
  }
  function deltaClass(v) {
    if (v === null || v === undefined || isNaN(v)) return 'neutral';
    return v > 0.0005 ? 'positive' : (v < -0.0005 ? 'negative' : 'neutral');
  }
  function yoy(curr, prev) {
    if (curr === null || prev === null || !prev) return null;
    return (curr - prev) / prev;
  }
  function deltaIcon(v) {
    if (v === null || v === undefined || isNaN(v)) return '';
    return v > 0.0005 ? '▲ ' : (v < -0.0005 ? '▼ ' : '● ');
  }
  // Semáforo de 3 tramos: positivo (verde), alerta (amarillo, caída leve), negativo (rojo, caída fuerte).
  function statusTier(v) {
    if (v === null || v === undefined || isNaN(v)) return 'neutral';
    if (v >= 0) return 'positive';
    return v >= -0.05 ? 'warning' : 'negative';
  }
  function fmtPctDelta(v, decimals) {
    if (v === null || v === undefined || isNaN(v)) return '<span class="delta-inline neutral">—</span>';
    const cls = statusTier(v);
    return `<span class="delta-inline ${cls}">${deltaIcon(v)}${fmtPct(v, decimals)}</span>`;
  }

  // ---------------------------------------------------------------------
  // Charts helpers
  // ---------------------------------------------------------------------

  function destroyChart(key) {
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
  }

  // Regresión lineal simple (mínimos cuadrados) sobre los puntos no nulos de la serie.
  // `years` (opcional) es el año correspondiente a cada punto; si se entrega `fromYear`,
  // los puntos anteriores a ese año quedan fuera del ajuste y no se dibujan.
  function trendlineData(values, years, fromYear) {
    const points = [];
    values.forEach((v, i) => {
      if (v === null || v === undefined || isNaN(v)) return;
      if (fromYear && years && years[i] !== undefined && years[i] < fromYear) return;
      points.push({ x: i, y: v });
    });
    if (points.length < 2) return values.map(() => null);
    const n = points.length;
    const sumX = points.reduce((a, p) => a + p.x, 0);
    const sumY = points.reduce((a, p) => a + p.y, 0);
    const sumXY = points.reduce((a, p) => a + p.x * p.y, 0);
    const sumXX = points.reduce((a, p) => a + p.x * p.x, 0);
    const denom = n * sumXX - sumX * sumX;
    if (!denom) return values.map(() => null);
    const slope = (n * sumXY - sumX * sumY) / denom;
    const intercept = (sumY - slope * sumX) / n;
    return values.map((_, i) => {
      if (fromYear && years && years[i] !== undefined && years[i] < fromYear) return null;
      return slope * i + intercept;
    });
  }

  function trendGrowthPct(trendLine) {
    const nonNull = trendLine.filter((v) => v !== null && v !== undefined && !isNaN(v));
    if (nonNull.length < 2) return null;
    const first = nonNull[0], last = nonNull[nonNull.length - 1];
    if (!first) return null;
    return (last - first) / first;
  }

  // Interpolación lineal de huecos internos (null) acotados por un valor conocido antes y después
  // (ej. 2018-2020 sin dato de mesas físicas, entre 2017 y 2021 con dato). No extrapola en los bordes:
  // si el hueco está al inicio o al final de la serie, se deja en null. Devuelve el arreglo relleno
  // (redondeado, ya que son unidades discretas) y un arreglo paralelo que marca qué puntos son estimados.
  function interpolateGaps(values) {
    const out = values.slice();
    const isInterp = values.map(() => false);
    let i = 0;
    while (i < out.length) {
      if (out[i] === null || out[i] === undefined) {
        const prevIdx = i - 1;
        if (prevIdx < 0 || out[prevIdx] === null || out[prevIdx] === undefined) { i++; continue; }
        let j = i;
        while (j < out.length && (out[j] === null || out[j] === undefined)) j++;
        if (j >= out.length) { i = j; continue; }
        const prevVal = out[prevIdx], nextVal = out[j], span = j - prevIdx;
        for (let k = prevIdx + 1; k < j; k++) {
          out[k] = Math.round(prevVal + (nextVal - prevVal) * ((k - prevIdx) / span));
          isInterp[k] = true;
        }
        i = j;
      } else {
        i++;
      }
    }
    return { values: out, isInterp };
  }

  function makeLineChart(ctx, key, labels, datasets, opts, addTrend, years) {
    destroyChart(key);
    let finalDatasets = datasets;
    if (addTrend && datasets.length <= 6) {
      const yrs = years || labels.map((l) => parseInt(l, 10));
      const fromYear = state.trendFrom;
      const trendDatasets = datasets.map((ds) => {
        const trendLine = trendlineData(ds.data, yrs, fromYear);
        const growth = trendGrowthPct(trendLine);
        const growthLabel = growth === null ? '' : ` (${fmtPct(growth)})`;
        return {
          label: `Tendencia · ${ds.label}${growthLabel}`,
          data: trendLine,
          borderColor: ds.borderColor,
          borderDash: [6, 4],
          borderWidth: 1.5,
          pointRadius: 0,
          fill: false,
          isTrend: true,
        };
      });
      finalDatasets = datasets.concat(trendDatasets);
    }
    charts[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets: finalDatasets },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: { y: { ticks: { callback: (v) => shortNum(v) } } },
      }, opts || {}),
    });
  }

  // Plugin de instancia (no registrado globalmente) que dibuja el valor de cada punto sobre la
  // línea, alternando arriba/abajo por dataset (dataset 0 arriba, dataset 1 abajo) para reducir
  // superposición cuando ambas series se cruzan. Con halo blanco detrás del texto para legibilidad
  // sobre la grilla.
  function pointLabelsPlugin(fmtFn) {
    return {
      id: 'pointLabels',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '600 9px "Segoe UI", Arial, sans-serif';
        ctx.textAlign = 'center';
        chart.data.datasets.forEach((ds, dsIndex) => {
          const meta = chart.getDatasetMeta(dsIndex);
          if (meta.hidden) return;
          const arriba = dsIndex % 2 === 0;
          ctx.textBaseline = arriba ? 'alphabetic' : 'hanging';
          const yOff = arriba ? -7 : 9;
          ds.data.forEach((v, i) => {
            if (v === null || v === undefined) return;
            const point = meta.data[i];
            if (!point) return;
            const text = fmtFn(v);
            ctx.lineWidth = 3;
            ctx.strokeStyle = 'rgba(255,255,255,0.92)';
            ctx.strokeText(text, point.x, point.y + yOff);
            ctx.fillStyle = ds.borderColor || '#333';
            ctx.fillText(text, point.x, point.y + yOff);
          });
        });
        ctx.restore();
      },
    };
  }

  // Igual que makeLineChart, pero con etiquetas de dato en cada punto (pointLabelsPlugin).
  // Se usa en el comparador de Resumen Mensual, donde solo hay 2 series y el detalle punto a
  // punto importa más que en los gráficos de tendencia general del resto del dashboard.
  function makeComparadorLineChart(ctx, key, labels, datasets, opts, fmtFn) {
    destroyChart(key);
    charts[key] = new Chart(ctx, {
      type: 'line',
      data: { labels, datasets },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { top: 16, bottom: 6, left: 8, right: 8 } },
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        },
        scales: { y: { ticks: { callback: (v) => shortNum(v) } } },
      }, opts || {}),
      plugins: [pointLabelsPlugin(fmtFn)],
    });
  }

  function makeBarChart(ctx, key, labels, datasets, opts) {
    destroyChart(key);
    charts[key] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: Object.assign({
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } } },
        scales: { y: { ticks: { callback: (v) => shortNum(v) } } },
      }, opts || {}),
    });
  }

  function makeDoughnut(ctx, key, labels, data, colors, plain) {
    destroyChart(key);
    const fmt = plain ? shortNumPlain : shortNum;
    const total = data.reduce((a, b) => a + (b || 0), 0);
    charts[key] = new Chart(ctx, {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: colors, borderWidth: 1, borderColor: '#fff' }] },
      options: {
        responsive: true, maintainAspectRatio: false, cutout: '55%',
        plugins: {
          legend: {
            position: 'right', labels: {
              boxWidth: 12, font: { size: 11.5 },
              generateLabels: (chart) => chart.data.labels.map((label, i) => {
                const value = chart.data.datasets[0].data[i] || 0;
                const pct = total ? (value / total * 100).toFixed(1) : '0.0';
                return {
                  text: `${label} (${pct}%)`,
                  fillStyle: colors[i],
                  strokeStyle: colors[i],
                  index: i,
                };
              }),
            },
          },
          tooltip: {
            callbacks: {
              label: (item) => {
                const value = item.raw || 0;
                const pct = total ? (value / total * 100).toFixed(1) : '0.0';
                return `${item.label}: ${fmt(value)} (${pct}%)`;
              },
            },
          },
        },
      },
    });
  }

  function makeHBar(ctx, key, labels, data, colors, tickFmt) {
    const fmtTick = tickFmt || shortNum;
    destroyChart(key);
    charts[key] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets: [{ data, backgroundColor: colors }] },
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (item) => fmtTick(item.raw || 0) } },
        },
        scales: {
          x: { ticks: { callback: (v) => fmtTick(v), font: { size: 10.5 }, maxRotation: 0, minRotation: 0 } },
          y: { ticks: { font: { size: 11 }, autoSkip: false } },
        },
      },
    });
  }

  // Mini-gráfico de tendencia para KPI cards: sin ejes, sin leyenda, sin tooltip.
  function makeSparkline(ctx, key, labels, data, color) {
    destroyChart(key);
    charts[key] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data, borderColor: color, backgroundColor: color + '22',
          borderWidth: 2, pointRadius: 0, fill: true, tension: 0.3,
        }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { enabled: false } },
        scales: { x: { display: false }, y: { display: false } },
        elements: { point: { hoverRadius: 0 } },
      },
    });
  }

  // Gráfico de barras mensuales agrupadas por año, con una línea punteada de promedio del
  // período. La variación % mes a mes entre años consecutivos se muestra en la tabla de detalle
  // debajo del gráfico (ver mensualVariationTableHtml), no superpuesta sobre las barras, para
  // evitar que las burbujas de variación se amontonen cuando se comparan 3 años a la vez.
  function makeYoyBarChart(ctx, key, labels, datasets, fmtFn, axisFmt) {
    destroyChart(key);
    charts[key] = new Chart(ctx, {
      type: 'bar',
      data: { labels, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        layout: { padding: { top: 16 } },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtFn(item.raw)}` } },
        },
        scales: { y: { ticks: { callback: (v) => axisFmt(v) } } },
      },
      plugins: [yoyAverageLinePlugin(datasets)],
    });
  }

  function yoyAverageLinePlugin(datasets) {
    return {
      id: 'yoyAverageLine',
      afterDatasetsDraw(chart) {
        const ctx = chart.ctx;
        const allVals = [];
        datasets.forEach((ds) => ds.data.forEach((v) => { if (v !== null && v !== undefined) allVals.push(v); }));
        if (!allVals.length) return;
        const avg = allVals.reduce((a, b) => a + b, 0) / allVals.length;
        const yPix = chart.scales.y.getPixelForValue(avg);
        ctx.save();
        ctx.setLineDash([5, 4]);
        ctx.strokeStyle = '#7a5b00';
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(chart.chartArea.left, yPix);
        ctx.lineTo(chart.chartArea.right, yPix);
        ctx.stroke();
        ctx.restore();
      },
    };
  }

  function shortNum(v) {
    const isUf = state.valueMode === 'uf', isUsd = state.valueMode === 'usd';
    const prefix = isUsd ? 'US$' : (isUf ? '' : '$');
    const suffix = isUf ? ' UF' : '';
    if (Math.abs(v) >= 1e9) return prefix + (v / 1e9).toFixed(1) + 'MM' + suffix;
    if (Math.abs(v) >= 1e6) return prefix + (v / 1e6).toFixed(0) + 'M' + suffix;
    if (Math.abs(v) >= 1e3) return prefix + (v / 1e3).toFixed(0) + 'k' + suffix;
    return prefix + v + suffix;
  }
  function shortNumPlain(v) {
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(1) + 'MM';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + 'M';
    if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + 'k';
    return String(v);
  }

  // ---------------------------------------------------------------------
  // Vista: Resumen Ejecutivo
  // ---------------------------------------------------------------------

  // Últimos hasta `n` años con datos, limitados a `uptoYear` (usado para las sparklines de KPI).
  function lastNYears(uptoYear, n) {
    return YEARS.filter((y) => y <= uptoYear).slice(-n);
  }

  function renderResumen() {
    const el = document.getElementById('view-resumen');
    const info = latestYearInfo();
    const year = info.year, hastaMes = info.meses;
    const prevYear = year - 1;
    const all = CASINOS.map((c) => c.Casino);

    const win = aggFlowReal(all, year, 'Win Total', hastaMes);
    const winPrev = aggFlowReal(all, prevYear, 'Win Total', hastaMes);
    const vis = sumFlowNominal(all, year, 'Visitas', hastaMes);
    const visPrev = sumFlowNominal(all, prevYear, 'Visitas', hastaMes);
    const ticket = ticketPromedio(win.valor, vis.valor);
    const ticketPrev = ticketPromedio(winPrev.valor, visPrev.valor);

    const periodoLabel = hastaMes === 12 ? `Año ${year} completo` : `Acumulado Ene-${MONTHS_ES[hastaMes - 1]} ${year}`;

    const sparkYears = lastNYears(year, 5);
    const hasSpark = sparkYears.length >= 2;
    const sparkVis = sparkYears.map((y) => sumFlowNominal(all, y, 'Visitas', hastaMes).valor);
    const sparkWin = sparkYears.map((y) => aggFlowReal(all, y, 'Win Total', hastaMes).valor);
    const sparkTicket = sparkYears.map((y, i) => ticketPromedio(sparkWin[i], sparkVis[i]));

    // Ranking horizontal — todos los casinos, por Visitas
    const rankingVis = CASINOS.map((c) => ({
      casino: c.Casino,
      valor: sumFlowNominal([c.Casino], year, 'Visitas', hastaMes).valor || 0,
    })).sort((a, b) => b.valor - a.valor);

    // Ranking horizontal — todos los casinos, por Ingresos Brutos
    const ranking = CASINOS.map((c) => ({
      casino: c.Casino,
      valor: aggFlowReal([c.Casino], year, 'Win Total', hastaMes).valor || 0,
    })).sort((a, b) => b.valor - a.valor);

    // Holding con mayor y menor Var.% de Ingresos Brutos, para el panel de narrativa.
    const holdingMovers = HOLDING_ORDER.map((h) => {
      const casinosH = casinosFor('holding', h);
      const act = aggFlowReal(casinosH, year, 'Win Total', hastaMes).valor || 0;
      const prev = aggFlowReal(casinosH, prevYear, 'Win Total', hastaMes).valor || 0;
      return { h, act, delta: yoy(act, prev) };
    }).filter((r) => r.delta !== null && r.act > 0);
    const bestHolding = holdingMovers.length ? holdingMovers.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
    const worstHolding = holdingMovers.length ? holdingMovers.reduce((a, b) => (b.delta < a.delta ? b : a)) : null;

    const totalWinAct = ranking.reduce((a, r) => a + r.valor, 0);
    const leaderShare = totalWinAct ? ranking[0].valor / totalWinAct : null;

    const bullets = [
      `Las visitas ${deltaClass(yoy(vis.valor, visPrev.valor)) === 'negative' ? 'cayeron' : 'crecieron'} ${fmtPctDelta(yoy(vis.valor, visPrev.valor))} y los ingresos brutos del juego ${deltaClass(yoy(win.valor, winPrev.valor)) === 'negative' ? 'cayeron' : 'crecieron'} ${fmtPctDelta(yoy(win.valor, winPrev.valor))} respecto a igual período de ${prevYear}.`,
      ranking.length ? `<strong>${ranking[0].casino}</strong> lidera el ranking de ingresos brutos con ${fmtMoneyMM(ranking[0].valor)} (${fmtPctPlain(leaderShare)} de participación de la industria).` : '',
      bestHolding && worstHolding && bestHolding.h !== worstHolding.h
        ? `Por holding, <strong>${bestHolding.h}</strong> mostró el mayor crecimiento (${fmtPctDelta(bestHolding.delta)}), mientras <strong>${worstHolding.h}</strong> registró la mayor caída (${fmtPctDelta(worstHolding.delta)}).`
        : '',
    ];

    el.innerHTML = `
      <div class="section-title">Resumen Ejecutivo</div>
      <div class="section-sub">${periodoLabel} vs. igual período ${prevYear} · valores ${valueModeLabel()}</div>
      ${insightsPanel(bullets)}
      <div class="kpi-grid">
        ${kpiCard('Visitas totales', fmtNum(vis.valor), yoy(vis.valor, visPrev.valor), false, hasSpark ? 'spark-vis' : null)}
        ${kpiCard('Ingresos Brutos del Juego', fmtMoneyMM(win.valor), yoy(win.valor, winPrev.valor), false, hasSpark ? 'spark-win' : null)}
        ${kpiCard('Gasto promedio por visita', fmtMoney(ticket), yoy(ticket, ticketPrev), false, hasSpark ? 'spark-ticket' : null)}
        ${kpiCard('Casinos activos', String(all.length), null, true)}
      </div>

      <div class="grid-2" style="margin-top:22px;">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Ranking de casinos — Visitas ${periodoLabel}</div>
          <div class="chart-wrap tall" style="height:${Math.max(420, all.length * 22)}px;"><canvas id="chart-resumen-ranking-visitas"></canvas></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Ranking de casinos — Ingresos Brutos ${periodoLabel}</div>
          <p class="small muted" style="margin:-6px 0 10px;">Cifras en MM = ${moneyMMUnitLabel()}</p>
          <div class="chart-wrap tall" style="height:${Math.max(420, all.length * 22)}px;"><canvas id="chart-resumen-ranking"></canvas></div>
        </div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0;">Participación de mercado por ingresos brutos del juego</div>
        <div class="table-scroll" id="tabla-resumen-grupos"></div>
      </div>

      <div class="card">
        <div class="section-title" style="margin-top:0;">Visitas por holding</div>
        <div class="table-scroll" id="tabla-resumen-visitas"></div>
      </div>
    `;

    if (hasSpark) {
      const yearLabels = sparkYears.map(String);
      makeSparkline(document.getElementById('spark-vis'), 'sparkVis', yearLabels, sparkVis, '#1F4E78');
      makeSparkline(document.getElementById('spark-win'), 'sparkWin', yearLabels, sparkWin, '#0B1F33');
      makeSparkline(document.getElementById('spark-ticket'), 'sparkTicket', yearLabels, sparkTicket, '#5B9BD5');
    }

    // Rankings horizontales (Visitas e Ingresos Brutos) — datos ya calculados arriba para el panel de narrativa.
    makeHBar(document.getElementById('chart-resumen-ranking-visitas'), 'resumenRankingVisitas',
      rankingVis.map((r) => r.casino), rankingVis.map((r) => r.valor), brandShades(rankingVis.length), fmtNum);

    makeHBar(document.getElementById('chart-resumen-ranking'), 'resumenRanking',
      ranking.map((r) => r.casino), ranking.map((r) => r.valor), brandShades(ranking.length), fmtMoneyMM);

    renderTablaGrupos(document.getElementById('tabla-resumen-grupos'), year, prevYear, hastaMes);
    renderTablaGruposVisitas(document.getElementById('tabla-resumen-visitas'), year, prevYear, hastaMes);
  }

  function kpiCard(label, value, delta, noDelta, sparkId) {
    const cls = deltaClass(delta);
    const deltaHtml = noDelta ? '' : `<div class="kpi-delta ${cls}">${delta === null ? 'sin comparación' : deltaIcon(delta) + fmtPct(delta) + ' vs. año anterior'}</div>`;
    const sparkHtml = sparkId ? `<div class="kpi-sparkline"><canvas id="${sparkId}"></canvas></div>` : '';
    return `<div class="kpi-card"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${deltaHtml}${sparkHtml}</div>`;
  }

  // Panel de narrativa: 1-3 frases con el hallazgo principal de la vista, en lenguaje natural en
  // vez de obligar al lector a leerlo desde la tabla/gráfico. Se ubica arriba de cada vista
  // analítica, antes de los KPI/gráficos/tablas de detalle (jerarquía: primero la conclusión,
  // después la evidencia). Reutiliza la clase .insights-panel ya definida en styles.css.
  function insightsPanel(bullets) {
    const items = bullets.filter(Boolean);
    if (!items.length) return '';
    return `<div class="card insights-panel">
      <div class="section-title" style="margin-top:0;">Lo más relevante</div>
      <ul>${items.map((b) => `<li>${b}</li>`).join('')}</ul>
    </div>`;
  }

  function renderTablaGrupos(container, year, prevYear, hastaMes) {
    let totalAct = 0, totalPrev = 0;
    const rows = HOLDING_ORDER.map((h) => {
      const casinosH = casinosFor('holding', h);
      const act = aggFlowReal(casinosH, year, 'Win Total', hastaMes).valor || 0;
      const prev = aggFlowReal(casinosH, prevYear, 'Win Total', hastaMes).valor || 0;
      totalAct += act; totalPrev += prev;
      return { g: h, act, prev };
    });
    let html = `<table class="data-table"><thead><tr>
      <th>Holding</th><th class="num">Total ${year}</th><th class="num">Total ${prevYear}</th><th class="num">Var.%</th>
      <th class="num">% particip. ${year}</th><th class="num">% particip. ${prevYear}</th>
    </tr></thead><tbody>`;
    rows.sort((a, b) => b.act - a.act).forEach((r) => {
      html += `<tr>
        <td><span class="legend-dot" style="background:${HOLDING_TONES[r.g]}"></span>${r.g}</td>
        <td class="num">${fmtMoneyMM(r.act)}</td><td class="num">${fmtMoneyMM(r.prev)}</td>
        <td class="num">${fmtPctDelta(yoy(r.act, r.prev))}</td>
        <td class="num">${fmtPctPlain(totalAct ? r.act / totalAct : null)}</td>
        <td class="num">${fmtPctPlain(totalPrev ? r.prev / totalPrev : null)}</td>
      </tr>`;
    });
    html += `<tr class="total-row"><td>Total Industria</td><td class="num">${fmtMoneyMM(totalAct)}</td><td class="num">${fmtMoneyMM(totalPrev)}</td><td class="num">${fmtPctDelta(yoy(totalAct, totalPrev))}</td><td class="num">100%</td><td class="num">100%</td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderTablaGruposVisitas(container, year, prevYear, hastaMes) {
    let totalAct = 0, totalPrev = 0;
    const rows = HOLDING_ORDER.map((h) => {
      const casinosH = casinosFor('holding', h);
      const act = sumFlowNominal(casinosH, year, 'Visitas', hastaMes).valor || 0;
      const prev = sumFlowNominal(casinosH, prevYear, 'Visitas', hastaMes).valor || 0;
      totalAct += act; totalPrev += prev;
      return { g: h, act, prev };
    });
    let html = `<table class="data-table"><thead><tr>
      <th>Holding</th><th class="num">Visitas ${year}</th><th class="num">Visitas ${prevYear}</th><th class="num">Var.%</th>
      <th class="num">% particip. ${year}</th><th class="num">% particip. ${prevYear}</th>
    </tr></thead><tbody>`;
    rows.sort((a, b) => b.act - a.act).forEach((r) => {
      html += `<tr>
        <td><span class="legend-dot" style="background:${HOLDING_TONES[r.g]}"></span>${r.g}</td>
        <td class="num">${fmtNum(r.act)}</td><td class="num">${fmtNum(r.prev)}</td>
        <td class="num">${fmtPctDelta(yoy(r.act, r.prev))}</td>
        <td class="num">${fmtPctPlain(totalAct ? r.act / totalAct : null)}</td>
        <td class="num">${fmtPctPlain(totalPrev ? r.prev / totalPrev : null)}</td>
      </tr>`;
    });
    html += `<tr class="total-row"><td>Total Industria</td><td class="num">${fmtNum(totalAct)}</td><td class="num">${fmtNum(totalPrev)}</td><td class="num">${fmtPctDelta(yoy(totalAct, totalPrev))}</td><td class="num">100%</td><td class="num">100%</td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Vista: Industria
  // ---------------------------------------------------------------------

  function renderIndustria() {
    const el = document.getElementById('view-industria');
    const yFrom = state.yearFrom, yTo = state.yearTo;
    const all = CASINOS.map((c) => c.Casino);
    // Si el año más reciente del rango está en curso (datos parciales, p. ej. solo hasta abril),
    // se limita la comparación ANUAL a ese mismo período acumulado en TODOS los años de la serie
    // (no solo año actual vs. anterior como en las tablas), para que la tendencia no muestre una
    // caída artificial por comparar años completos contra un año parcial. Mismo criterio que ya
    // usan las tablas del dashboard (ver monthsWithData/hastaMes en renderCasinos, tablaHoldingsPorMetrica).
    const hastaMesInd = monthsWithData(all, yTo, 'Visitas') || 12;
    const acumNoteInd = hastaMesInd < 12
      ? ` · comparación acumulada Ene–${MONTHS_ES[hastaMesInd - 1]} en todos los años (${yTo} en curso)`
      : '';

    // Serie anual completa del rango (independiente de la granularidad elegida para el gráfico),
    // usada solo para el panel de narrativa: variación interanual y tendencia de largo plazo.
    const yearsList = yearsInRange(yFrom, yTo);
    const ingresosAnual = yearsList.map((y) => aggFlowReal(all, y, 'Win Total', hastaMesInd).valor);
    const visitasAnual = yearsList.map((y) => sumFlowNominal(all, y, 'Visitas', hastaMesInd).valor);
    const nInd = yearsList.length;
    const yoyWinInd = nInd >= 2 ? yoy(ingresosAnual[nInd - 1], ingresosAnual[nInd - 2]) : null;
    const yoyVisInd = nInd >= 2 ? yoy(visitasAnual[nInd - 1], visitasAnual[nInd - 2]) : null;
    const trendWinInd = trendGrowthPct(trendlineData(ingresosAnual, yearsList, state.trendFrom));
    const bulletsInd = [
      nInd >= 2 ? `En ${yearsList[nInd - 1]}, los ingresos brutos del juego ${deltaClass(yoyWinInd) === 'negative' ? 'cayeron' : 'crecieron'} ${fmtPctDelta(yoyWinInd)} y las visitas ${deltaClass(yoyVisInd) === 'negative' ? 'cayeron' : 'crecieron'} ${fmtPctDelta(yoyVisInd)} respecto al año anterior.` : '',
      trendWinInd !== null ? `La tendencia de largo plazo de los ingresos brutos es de ${fmtPctDelta(trendWinInd)} entre ${yearsList[0]} y ${yearsList[nInd - 1]}.` : '',
    ];

    el.innerHTML = `
      <div class="section-title">Industria — Serie Histórica</div>
      <div class="section-sub">${yFrom}–${yTo} · valores ${valueModeLabel()}${acumNoteInd}</div>
      ${insightsPanel(bulletsInd)}
      <div class="filter-row">
        <label>Granularidad</label>
        <select id="sel-granularidad">
          <option value="anual" ${state.industriaGranularidad === 'anual' ? 'selected' : ''}>Anual</option>
          <option value="mensual" ${state.industriaGranularidad === 'mensual' ? 'selected' : ''}>Mensual</option>
        </select>
      </div>
      <div class="grid-2">
        <div class="card"><div class="section-title" style="margin-top:0;">Ingresos Brutos del Juego</div><div class="chart-wrap"><canvas id="chart-ind-ingresos"></canvas></div></div>
        <div class="card"><div class="section-title" style="margin-top:0;">Visitas</div><div class="chart-wrap"><canvas id="chart-ind-visitas"></canvas></div></div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0;">Resumen anual</div>
        <div class="table-scroll" id="tabla-industria-anual"></div>
      </div>
    `;
    document.getElementById('sel-granularidad').addEventListener('change', (e) => {
      state.industriaGranularidad = e.target.value;
      renderIndustria();
    });

    if (state.industriaGranularidad === 'anual') {
      const labels = [];
      const ingresos = [], visitas = [];
      yearsInRange(yFrom, yTo).forEach((y) => {
        labels.push(String(y));
        ingresos.push(aggFlowReal(all, y, 'Win Total', hastaMesInd).valor);
        visitas.push(sumFlowNominal(all, y, 'Visitas', hastaMesInd).valor);
      });
      const sufijoLabel = hastaMesInd < 12 ? ` (Acum. ${MONTHS_ES[hastaMesInd - 1]})` : '';
      makeLineChart(document.getElementById('chart-ind-ingresos'), 'indIngresos', labels,
        [{ label: 'Ingresos Brutos' + sufijoLabel, data: ingresos, borderColor: '#0B1F33', backgroundColor: 'rgba(11,31,51,.12)', fill: true, tension: 0.25 }],
        null, true);
      makeLineChart(document.getElementById('chart-ind-visitas'), 'indVisitas', labels,
        [{ label: 'Visitas' + sufijoLabel, data: visitas, borderColor: '#5B9BD5', backgroundColor: 'rgba(91,155,213,.12)', fill: true, tension: 0.25 }],
        { scales: { y: { ticks: { callback: (v) => shortNumPlain(v) } } } }, true);
    } else {
      const labels2 = [], ing2 = [], vis2 = [], years2 = [];
      yearsInRange(yFrom, yTo).forEach((y) => {
        for (let m = 1; m <= 12; m++) {
          const wSum = all.reduce((acc, c) => {
            const v = monthValue(c, y, m, 'Win Total');
            return acc + (v || 0);
          }, 0);
          const anyData = all.some((c) => monthValue(c, y, m, 'Win Total') !== null);
          if (!anyData) continue;
          const vSum = all.reduce((acc, c) => acc + (monthValue(c, y, m, 'Visitas') || 0), 0);
          labels2.push(MONTHS_ES[m - 1] + ' ' + String(y).slice(2));
          ing2.push(deflate(wSum, y));
          vis2.push(vSum);
          years2.push(y);
        }
      });
      makeLineChart(document.getElementById('chart-ind-ingresos'), 'indIngresos', labels2,
        [{ label: 'Ingresos Brutos', data: ing2, borderColor: '#0B1F33', backgroundColor: 'rgba(11,31,51,.12)', fill: true, tension: 0.2, pointRadius: 0 }],
        null, true, years2);
      makeLineChart(document.getElementById('chart-ind-visitas'), 'indVisitas', labels2,
        [{ label: 'Visitas', data: vis2, borderColor: '#5B9BD5', backgroundColor: 'rgba(91,155,213,.12)', fill: true, tension: 0.2, pointRadius: 0 }],
        { scales: { y: { ticks: { callback: (v) => shortNumPlain(v) } } } }, true, years2);
    }

    renderTablaIndustriaAnual(document.getElementById('tabla-industria-anual'), yFrom, yTo, hastaMesInd);
  }

  function renderTablaIndustriaAnual(container, yFrom, yTo, hastaMes) {
    const all = CASINOS.map((c) => c.Casino);
    let html = `<table class="data-table"><thead><tr>
      <th>Año</th><th class="num">Ingresos Brutos</th><th class="num">Var.%</th>
      <th class="num">Visitas</th><th class="num">Var.% Visitas</th><th class="num">Gasto promedio</th>
    </tr></thead><tbody>`;
    let prevVal = null, prevVis = null;
    for (let y = yFrom; y <= yTo; y++) {
      const nom = sumFlowNominal(all, y, 'Win Total', hastaMes).valor;
      const val = deflate(nom, y);
      const vis = sumFlowNominal(all, y, 'Visitas', hastaMes).valor;
      const ticket = ticketPromedio(val, vis);
      html += `<tr>
        <td>${y}</td><td class="num">${fmtMoneyMM(val)}</td>
        <td class="num">${fmtPctDelta(yoy(val, prevVal))}</td>
        <td class="num">${fmtNum(vis)}</td><td class="num">${fmtPctDelta(yoy(vis, prevVis))}</td>
        <td class="num">${fmtMoney(ticket)}</td>
      </tr>`;
      prevVal = val; prevVis = vis;
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Filtro compartido: por año vs. promedio/total del período seleccionado
  // ---------------------------------------------------------------------

  function periodModeSelectHtml(id) {
    const yFrom = state.yearFrom, yTo = state.yearTo;
    const modo = state.periodMode || 'anual';
    return `<div class="filter-row" style="margin-bottom:10px;">
      <label for="${id}">Vista de la tabla</label>
      <select id="${id}">
        <option value="anual" ${modo === 'anual' ? 'selected' : ''}>Por año (año actual vs. año anterior)</option>
        <option value="promedio" ${modo === 'promedio' ? 'selected' : ''}>Promedio anual del período ${yFrom}–${yTo}</option>
        <option value="total" ${modo === 'total' ? 'selected' : ''}>Total del período ${yFrom}–${yTo}</option>
      </select>
    </div>`;
  }

  function wirePeriodModeSelect(id) {
    document.getElementById(id).addEventListener('change', (e) => {
      state.periodMode = e.target.value;
      renderCurrentView();
    });
  }

  // ---------------------------------------------------------------------
  // Vista: Holdings
  // ---------------------------------------------------------------------

  function renderHoldings() {
    const el = document.getElementById('view-holdings');
    const yFrom = state.yearFrom, yTo = state.yearTo;
    // Mismo criterio de período acumulado equivalente que renderIndustria(): si yTo está en
    // curso, se corta la evolución de TODOS los años al mismo mes para no comparar años completos
    // contra un año parcial en la línea de tendencia.
    const hastaMesHold = monthsWithData(CASINOS.map((c) => c.Casino), yTo, 'Visitas') || 12;
    const acumNoteHold = hastaMesHold < 12
      ? ` · comparación acumulada Ene–${MONTHS_ES[hastaMesHold - 1]} en todos los años (${yTo} en curso)`
      : '';

    // Panel de narrativa: líder de participación y mayor/menor variación interanual, para no
    // obligar al lector a recorrer las dos tablas de abajo para encontrar el dato relevante.
    const prevYearHold = yTo - 1;
    const holdingRows = HOLDING_ORDER.map((h) => {
      const casinosH = casinosFor('holding', h);
      const act = aggFlowReal(casinosH, yTo, 'Win Total', hastaMesHold).valor || 0;
      const prev = aggFlowReal(casinosH, prevYearHold, 'Win Total', hastaMesHold).valor || 0;
      return { h, act, delta: yoy(act, prev) };
    });
    const totalHoldAct = holdingRows.reduce((a, r) => a + r.act, 0);
    const leaderHold = holdingRows.slice().sort((a, b) => b.act - a.act)[0];
    const movers = holdingRows.filter((r) => r.delta !== null && r.act > 0);
    const bestHold = movers.length ? movers.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
    const worstHold = movers.length ? movers.reduce((a, b) => (b.delta < a.delta ? b : a)) : null;
    const bulletsHold = [
      leaderHold ? `<strong>${leaderHold.h}</strong> lidera la industria con ${fmtMoneyMM(leaderHold.act)} en ingresos brutos (${fmtPctPlain(totalHoldAct ? leaderHold.act / totalHoldAct : null)} de participación en ${yTo}).` : '',
      bestHold && worstHold && bestHold.h !== worstHold.h
        ? `<strong>${bestHold.h}</strong> tuvo el mayor crecimiento interanual (${fmtPctDelta(bestHold.delta)}); <strong>${worstHold.h}</strong>, la mayor caída (${fmtPctDelta(worstHold.delta)}).`
        : '',
    ];

    el.innerHTML = `
      <div class="section-title">Holdings — Comparación entre grupos controladores</div>
      <div class="section-sub">Clasificación oficial según Tabla N°2, Informe Anual de la Industria 2025 (SCJ) · ${yFrom}–${yTo} · valores ${valueModeLabel()}${acumNoteHold}</div>
      ${insightsPanel(bulletsHold)}
      <div class="card">
        <div class="section-title" style="margin-top:0;">Evolución de Ingresos Brutos por Holding</div>
        <div class="chart-wrap tall"><canvas id="chart-hold-evol"></canvas></div>
      </div>
      <div class="card">
        ${periodModeSelectHtml('sel-period-mode-holdings')}
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Participación por ingresos brutos del juego</div>
          <div class="table-scroll" id="tabla-holdings-share"></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Participación por visitas</div>
          <div class="table-scroll" id="tabla-holdings-visitas"></div>
        </div>
      </div>
    `;
    wirePeriodModeSelect('sel-period-mode-holdings');

    const labels = yearsInRange(yFrom, yTo).map(String);
    const datasets = HOLDING_ORDER.map((h) => ({
      label: h, borderColor: HOLDING_TONES[h],
      backgroundColor: HOLDING_TONES[h].replace('hsl(', 'hsla(').replace(')', ', 0.13)'),
      data: labels.map((y) => aggFlowReal(casinosFor('holding', h), Number(y), 'Win Total', hastaMesHold).valor),
      tension: 0.2, fill: false,
    }));
    makeLineChart(document.getElementById('chart-hold-evol'), 'holdEvol', labels, datasets, null, true);

    document.getElementById('tabla-holdings-share').innerHTML = tablaHoldingsPorMetrica('Win Total', fmtMoneyMM);
    document.getElementById('tabla-holdings-visitas').innerHTML = tablaHoldingsPorMetrica('Visitas', fmtNum);
  }

  // Tabla de participación por holding para un indicador de flujo ('Win Total' o 'Visitas'),
  // respetando el modo de período compartido (anual / promedio / total). 'Win Total' se
  // deflacta a valores reales/UF/USD según state.valueMode; 'Visitas' se mantiene nominal.
  function tablaHoldingsPorMetrica(indicador, fmtFn) {
    const yFrom = state.yearFrom, yTo = state.yearTo;
    const sumFn = indicador === 'Win Total' ? aggFlowReal : sumFlowNominal;
    const periodMode = state.periodMode || 'anual';
    let html;
    if (periodMode === 'anual') {
      const year = yTo, prevYear = yTo - 1;
      // Si `year` es un año parcial (en curso), limitamos ambos períodos a los mismos meses
      // para que la Var.% compare períodos equivalentes (no año completo vs. año parcial).
      const hastaMesTabla = monthsWithData(CASINOS.map((c) => c.Casino), year, indicador) || 12;
      let totalAct = 0, totalPrev = 0;
      const rows = HOLDING_ORDER.map((h) => {
        const act = sumFn(casinosFor('holding', h), year, indicador, hastaMesTabla).valor || 0;
        const prev = sumFn(casinosFor('holding', h), prevYear, indicador, hastaMesTabla).valor || 0;
        totalAct += act; totalPrev += prev;
        return { h, act, prev };
      });
      html = `<table class="data-table"><thead><tr>
        <th>Holding</th><th class="num">${year}</th><th class="num">${prevYear}</th><th class="num">Var.%</th><th class="num">% ${year}</th><th class="num">% ${prevYear}</th>
      </tr></thead><tbody>`;
      rows.sort((a, b) => b.act - a.act).forEach((r) => {
        html += `<tr><td><span class="legend-dot" style="background:${HOLDING_TONES[r.h]}"></span>${r.h}</td>
          <td class="num">${fmtFn(r.act)}</td><td class="num">${fmtFn(r.prev)}</td>
          <td class="num">${fmtPctDelta(yoy(r.act, r.prev))}</td>
          <td class="num">${fmtPctPlain(totalAct ? r.act / totalAct : null)}</td>
          <td class="num">${fmtPctPlain(totalPrev ? r.prev / totalPrev : null)}</td></tr>`;
      });
      html += `<tr class="total-row"><td>Total Industria</td><td class="num">${fmtFn(totalAct)}</td><td class="num">${fmtFn(totalPrev)}</td><td class="num">${fmtPctDelta(yoy(totalAct, totalPrev))}</td><td class="num">100%</td><td class="num">100%</td></tr>`;
      html += '</tbody></table>';
    } else {
      const yrs = yearsInRange(yFrom, yTo);
      const nYrs = yrs.length || 1;
      let totalSum = 0;
      const rows = HOLDING_ORDER.map((h) => {
        const sum = yrs.reduce((a, y) => a + (sumFn(casinosFor('holding', h), y, indicador).valor || 0), 0);
        totalSum += sum;
        return { h, sum };
      });
      const colLabel = periodMode === 'promedio' ? `Promedio anual ${yFrom}–${yTo}` : `Total ${yFrom}–${yTo}`;
      html = `<table class="data-table"><thead><tr>
        <th>Holding</th><th class="num">${colLabel}</th><th class="num">% participación</th>
      </tr></thead><tbody>`;
      rows.sort((a, b) => b.sum - a.sum).forEach((r) => {
        const val = periodMode === 'promedio' ? r.sum / nYrs : r.sum;
        html += `<tr><td><span class="legend-dot" style="background:${HOLDING_TONES[r.h]}"></span>${r.h}</td>
          <td class="num">${fmtFn(val)}</td>
          <td class="num">${fmtPctPlain(totalSum ? r.sum / totalSum : null)}</td></tr>`;
      });
      const totalVal = periodMode === 'promedio' ? totalSum / nYrs : totalSum;
      html += `<tr class="total-row"><td>Total Industria</td><td class="num">${fmtFn(totalVal)}</td><td class="num">100%</td></tr>`;
      html += '</tbody></table>';
    }
    return html;
  }

  // ---------------------------------------------------------------------
  // Vista: Casinos
  // ---------------------------------------------------------------------

  function renderCasinos() {
    const el = document.getElementById('view-casinos');
    const yTo = state.yearTo;
    const prevYear = yTo - 1;
    const hastaMes = monthsWithData(CASINOS.map((c) => c.Casino), yTo, 'Visitas') || 12;
    const periodoLabel = hastaMes === 12 ? `Año ${yTo}` : `Ene-${MONTHS_ES[hastaMes - 1]} ${yTo} vs. igual período ${prevYear}`;
    if (state.casinosSeleccionados.length === 0) {
      state.casinosSeleccionados = CASINOS.filter((c) => c.Holding === 'Marina del Sol').map((c) => c.Casino);
    }

    // Ranking completo por Ingresos Brutos (todos los casinos, no solo los seleccionados en el
    // comparador), para el panel de narrativa y el resumen visual "Top 5" antes de la tabla
    // detallada — un lector puede quedarse con el resumen o profundizar en la tabla completa.
    const casinoRanking = CASINOS.map((c) => {
      const act = aggFlowReal([c.Casino], yTo, 'Win Total', hastaMes).valor || 0;
      const prev = aggFlowReal([c.Casino], prevYear, 'Win Total', hastaMes).valor || 0;
      return { casino: c.Casino, act, delta: yoy(act, prev) };
    }).sort((a, b) => b.act - a.act);
    const totalCasinoAct = casinoRanking.reduce((a, r) => a + r.act, 0);
    const casinoMovers = casinoRanking.filter((r) => r.delta !== null && r.act > 0);
    const bestCasino = casinoMovers.length ? casinoMovers.reduce((a, b) => (b.delta > a.delta ? b : a)) : null;
    const worstCasino = casinoMovers.length ? casinoMovers.reduce((a, b) => (b.delta < a.delta ? b : a)) : null;
    const bulletsCasinos = [
      casinoRanking.length ? `<strong>${casinoRanking[0].casino}</strong> lidera con ${fmtMoneyMM(casinoRanking[0].act)} en ingresos brutos (${fmtPctPlain(totalCasinoAct ? casinoRanking[0].act / totalCasinoAct : null)} de la industria).` : '',
      bestCasino && worstCasino && bestCasino.casino !== worstCasino.casino
        ? `<strong>${bestCasino.casino}</strong> tuvo el mayor crecimiento interanual (${fmtPctDelta(bestCasino.delta)}); <strong>${worstCasino.casino}</strong>, la mayor caída (${fmtPctDelta(worstCasino.delta)}).`
        : '',
    ];
    const top5Html = casinoRanking.slice(0, 5).map((r, i) => `
      <div class="top5-row">
        <span class="top5-rank">${i + 1}</span>
        <span class="top5-name">${r.casino}</span>
        <span class="top5-value">${fmtMoneyMM(r.act)}</span>
        <span class="top5-delta">${fmtPctDelta(r.delta)}</span>
      </div>`).join('');

    el.innerHTML = `
      <div class="section-title">Casinos — Comparador y detalle</div>
      <div class="section-sub">Selecciona uno o más casinos para comparar su evolución · valores ${valueModeLabel()}</div>
      ${insightsPanel(bulletsCasinos)}
      <div class="card">
        <div class="filter-row">
          <label for="sel-grupo-controlador">Seleccionar por grupo controlador</label>
          <select id="sel-grupo-controlador">
            <option value="">— Elegir grupo —</option>
            ${HOLDING_ORDER.map((h) => `<option value="${h}">${h}</option>`).join('')}
          </select>
          <span class="small muted">Carga todos los casinos del grupo; luego puedes agregar o quitar casinos individuales abajo.</span>
          <button class="btn btn-secondary" id="btn-casinos-todos" type="button" style="padding:5px 12px; font-size:12px;">Seleccionar todos</button>
          <button class="btn btn-secondary" id="btn-casinos-ninguno" type="button" style="padding:5px 12px; font-size:12px;">Quitar todos</button>
        </div>
        <div class="checkbox-list" id="casino-checklist"></div>
        <div class="section-title" style="margin-top:16px; font-size:14px;">Evolución de Ingresos Brutos del Juego por casino</div>
        <div class="chart-wrap tall"><canvas id="chart-casinos-comp"></canvas></div>
        <div class="section-title" style="margin-top:16px; font-size:14px;">Evolución de Visitas por casino</div>
        <div class="chart-wrap tall"><canvas id="chart-casinos-comp-visitas"></canvas></div>
      </div>

      <div class="section-title">Top 5 — Ingresos Brutos del Juego ${periodoLabel}</div>
      <div class="card top5-card">${top5Html}</div>

      <div class="section-title">Visitas y gasto promedio por casino${state.periodMode === 'anual' ? ` — ${periodoLabel}` : ''}</div>
      <div class="section-sub" style="margin-top:-4px;">Detalle completo de los ${CASINOS.length} casinos de la industria</div>
      <div class="card">
        ${periodModeSelectHtml('sel-period-mode-casinos')}
        <div class="table-scroll" id="tabla-visitas-casino"></div>
      </div>

      <div class="section-title">Ofertas Económicas vigentes</div>
      <div class="section-sub">Referencia SCJ 2025 · valores ${valueModeLabel()}</div>
      <div class="card"><div class="table-scroll" id="tabla-oe"></div></div>
    `;

    renderCasinoChecklist();
    renderCasinosComparador();
    renderCasinosComparadorVisitas();
    renderTablaVisitasCasino(document.getElementById('tabla-visitas-casino'), yTo, prevYear, hastaMes);
    renderTablaOE(document.getElementById('tabla-oe'));
    wirePeriodModeSelect('sel-period-mode-casinos');

    document.getElementById('sel-grupo-controlador').addEventListener('change', (ev) => {
      const holding = ev.target.value;
      if (!holding) return;
      state.casinosSeleccionados = casinosFor('holding', holding);
      ev.target.value = '';
      renderCasinoChecklist();
      renderCasinosComparador();
      renderCasinosComparadorVisitas();
    });
    document.getElementById('btn-casinos-todos').addEventListener('click', () => {
      state.casinosSeleccionados = CASINOS.map((c) => c.Casino);
      renderCasinoChecklist();
      renderCasinosComparador();
      renderCasinosComparadorVisitas();
    });
    document.getElementById('btn-casinos-ninguno').addEventListener('click', () => {
      state.casinosSeleccionados = [];
      renderCasinoChecklist();
      renderCasinosComparador();
      renderCasinosComparadorVisitas();
    });
  }

  function renderCasinoChecklist() {
    const cont = document.getElementById('casino-checklist');
    cont.innerHTML = CASINOS.map((c) => {
      const checked = state.casinosSeleccionados.includes(c.Casino);
      return `<div class="checkbox-chip ${checked ? 'checked' : ''}" data-casino="${c.Casino}">${c.Casino}</div>`;
    }).join('');
    cont.querySelectorAll('.checkbox-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const casino = chip.getAttribute('data-casino');
        const idx = state.casinosSeleccionados.indexOf(casino);
        if (idx >= 0) state.casinosSeleccionados.splice(idx, 1);
        else state.casinosSeleccionados.push(casino);
        renderCasinoChecklist();
        renderCasinosComparador();
        renderCasinosComparadorVisitas();
      });
    });
  }

  function renderCasinosComparador() {
    const yFrom = state.yearFrom, yTo = state.yearTo;
    // Mismo criterio de período acumulado equivalente que renderIndustria(): si yTo está en
    // curso, se corta la evolución de TODOS los años al mismo mes.
    const hastaMes = monthsWithData(CASINOS.map((c) => c.Casino), yTo, 'Visitas') || 12;
    const sufijoLabel = hastaMes < 12 ? ` (Acum. ${MONTHS_ES[hastaMes - 1]})` : '';
    const labels = yearsInRange(yFrom, yTo).map(String);
    // Degradado de azules por orden de selección (mismo criterio que Equipamiento): un mismo
    // casino queda con el mismo tono en este gráfico y en el de Visitas de abajo (ambos recorren
    // state.casinosSeleccionados en el mismo orden).
    const casinoTones = brandShades(state.casinosSeleccionados.length);
    const datasets = state.casinosSeleccionados.map((casino, i) => ({
      label: casino + sufijoLabel, borderColor: casinoTones[i],
      backgroundColor: casinoTones[i].replace('hsl(', 'hsla(').replace(')', ', 0.13)'),
      data: labels.map((y) => aggFlowReal([casino], Number(y), 'Win Total', hastaMes).valor),
      tension: 0.2, fill: false,
    }));
    makeLineChart(document.getElementById('chart-casinos-comp'), 'casinosComp', labels, datasets, null, true);
  }

  // Igual que renderCasinosComparador, pero para Visitas. Usa sumFlowNominal (no aggFlowReal):
  // 'Visitas' es un conteo de personas y nunca se deflacta ni se convierte a UF/USD, siguiendo
  // el mismo criterio que el resto del dashboard (ver monthValue/mensualSeries).
  function renderCasinosComparadorVisitas() {
    const yFrom = state.yearFrom, yTo = state.yearTo;
    const hastaMes = monthsWithData(CASINOS.map((c) => c.Casino), yTo, 'Visitas') || 12;
    const sufijoLabel = hastaMes < 12 ? ` (Acum. ${MONTHS_ES[hastaMes - 1]})` : '';
    const labels = yearsInRange(yFrom, yTo).map(String);
    const casinoTones = brandShades(state.casinosSeleccionados.length);
    const datasets = state.casinosSeleccionados.map((casino, i) => ({
      label: casino + sufijoLabel, borderColor: casinoTones[i],
      backgroundColor: casinoTones[i].replace('hsl(', 'hsla(').replace(')', ', 0.13)'),
      data: labels.map((y) => sumFlowNominal([casino], Number(y), 'Visitas', hastaMes).valor),
      tension: 0.2, fill: false,
    }));
    makeLineChart(document.getElementById('chart-casinos-comp-visitas'), 'casinosCompVisitas', labels, datasets,
      { scales: { y: { ticks: { callback: (v) => shortNumPlain(v) } } } }, true);
  }

  function renderTablaVisitasCasino(container, year, prevYear, hastaMes) {
    const periodMode = state.periodMode || 'anual';
    if (periodMode !== 'anual') {
      renderTablaVisitasCasinoPeriodo(container, periodMode);
      return;
    }
    const rows19995 = [], rowsMunicipal = [];
    let tot19995Vis = 0, totMunVis = 0, tot19995Win = 0, totMunWin = 0;
    let tot19995VisPrev = 0, totMunVisPrev = 0, tot19995WinPrev = 0, totMunWinPrev = 0;
    CASINOS.forEach((c) => {
      const vis = sumFlowNominal([c.Casino], year, 'Visitas', hastaMes).valor || 0;
      const win = aggFlowReal([c.Casino], year, 'Win Total', hastaMes).valor || 0;
      const visPrev = sumFlowNominal([c.Casino], prevYear, 'Visitas', hastaMes).valor || 0;
      const winPrev = aggFlowReal([c.Casino], prevYear, 'Win Total', hastaMes).valor || 0;
      const row = { casino: c.Casino, vis, win, visPrev, winPrev };
      if (c.Tier === 'municipal') {
        rowsMunicipal.push(row); totMunVis += vis; totMunWin += win; totMunVisPrev += visPrev; totMunWinPrev += winPrev;
      } else {
        rows19995.push(row); tot19995Vis += vis; tot19995Win += win; tot19995VisPrev += visPrev; tot19995WinPrev += winPrev;
      }
    });
    const totalVis = tot19995Vis + totMunVis;
    const gasto = (vis, win) => vis ? win / vis : null;

    function bloque(rows, label, totVis, totWin, totVisPrev, totWinPrev) {
      let html = '';
      rows.sort((a, b) => b.vis - a.vis).forEach((r) => {
        html += `<tr><td>${r.casino}</td><td class="num">${fmtNum(r.vis)}</td>
          <td class="num">${fmtNum(r.visPrev)}</td>
          <td class="num">${fmtPctDelta(yoy(r.vis, r.visPrev))}</td>
          <td class="num">${fmtPctPlain(totalVis ? r.vis / totalVis : null)}</td>
          <td class="num">${fmtMoney(gasto(r.vis, r.win))}</td>
          <td class="num">${fmtMoney(gasto(r.visPrev, r.winPrev))}</td>
          <td class="num">${fmtMoneyMM(r.win)}</td>
          <td class="num">${fmtMoneyMM(r.winPrev)}</td>
          <td class="num">${fmtPctDelta(yoy(r.win, r.winPrev))}</td></tr>`;
      });
      html += `<tr class="subtotal-row"><td>Sub total ${label}</td><td class="num">${fmtNum(totVis)}</td>
        <td class="num">${fmtNum(totVisPrev)}</td>
        <td class="num">${fmtPctDelta(yoy(totVis, totVisPrev))}</td>
        <td class="num">${fmtPctPlain(totalVis ? totVis / totalVis : null)}</td>
        <td class="num">${fmtMoney(gasto(totVis, totWin))}</td>
        <td class="num">${fmtMoney(gasto(totVisPrev, totWinPrev))}</td>
        <td class="num">${fmtMoneyMM(totWin)}</td>
        <td class="num">${fmtMoneyMM(totWinPrev)}</td>
        <td class="num">${fmtPctDelta(yoy(totWin, totWinPrev))}</td></tr>`;
      return html;
    }

    const totalVisPrev = tot19995VisPrev + totMunVisPrev;
    const totalWin = tot19995Win + totMunWin;
    const totalWinPrev = tot19995WinPrev + totMunWinPrev;
    let html = `<table class="data-table"><thead><tr>
      <th>Nombre comercial</th><th class="num">Visitas ${year}</th><th class="num">Visitas ${prevYear}</th>
      <th class="num">Var.%</th><th class="num">Participación industria</th>
      <th class="num">Gasto promedio ${year}</th><th class="num">Gasto promedio ${prevYear}</th>
      <th class="num">Ingresos Brutos ${year}</th><th class="num">Ingresos Brutos ${prevYear}</th><th class="num">Var.%</th>
    </tr></thead><tbody>`;
    html += bloque(rows19995, 'casinos 19.995', tot19995Vis, tot19995Win, tot19995VisPrev, tot19995WinPrev);
    html += bloque(rowsMunicipal, 'casinos municipales', totMunVis, totMunWin, totMunVisPrev, totMunWinPrev);
    html += `<tr class="total-row"><td>Total industria</td><td class="num">${fmtNum(totalVis)}</td>
      <td class="num">${fmtNum(totalVisPrev)}</td>
      <td class="num">${fmtPctDelta(yoy(totalVis, totalVisPrev))}</td><td class="num">100%</td>
      <td class="num">${fmtMoney(gasto(totalVis, totalWin))}</td>
      <td class="num">${fmtMoney(gasto(totalVisPrev, totalWinPrev))}</td>
      <td class="num">${fmtMoneyMM(totalWin)}</td>
      <td class="num">${fmtMoneyMM(totalWinPrev)}</td>
      <td class="num">${fmtPctDelta(yoy(totalWin, totalWinPrev))}</td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderTablaVisitasCasinoPeriodo(container, periodMode) {
    const yFrom = state.yearFrom, yTo = state.yearTo;
    const yrs = yearsInRange(yFrom, yTo);
    const nYrs = yrs.length || 1;
    const rows19995 = [], rowsMunicipal = [];
    let tot19995Vis = 0, totMunVis = 0, tot19995Win = 0, totMunWin = 0;
    CASINOS.forEach((c) => {
      let vis = 0, win = 0;
      yrs.forEach((y) => {
        vis += sumFlowNominal([c.Casino], y, 'Visitas').valor || 0;
        win += aggFlowReal([c.Casino], y, 'Win Total').valor || 0;
      });
      const row = { casino: c.Casino, vis, win };
      if (c.Tier === 'municipal') { rowsMunicipal.push(row); totMunVis += vis; totMunWin += win; }
      else { rows19995.push(row); tot19995Vis += vis; tot19995Win += win; }
    });
    const totalVis = tot19995Vis + totMunVis;
    const totalWin = tot19995Win + totMunWin;
    const gasto = (vis, win) => vis ? win / vis : null;
    const visVal = (v) => periodMode === 'promedio' ? v / nYrs : v;

    function bloque(rows, label, totVis, totWin) {
      let html = '';
      rows.sort((a, b) => b.vis - a.vis).forEach((r) => {
        html += `<tr><td>${r.casino}</td><td class="num">${fmtNum(visVal(r.vis))}</td>
          <td class="num">${fmtPctPlain(totalVis ? r.vis / totalVis : null)}</td>
          <td class="num">${fmtMoney(gasto(r.vis, r.win))}</td></tr>`;
      });
      html += `<tr class="subtotal-row"><td>Sub total ${label}</td><td class="num">${fmtNum(visVal(totVis))}</td>
        <td class="num">${fmtPctPlain(totalVis ? totVis / totalVis : null)}</td>
        <td class="num">${fmtMoney(gasto(totVis, totWin))}</td></tr>`;
      return html;
    }

    const colLabel = periodMode === 'promedio' ? `Visitas — promedio anual ${yFrom}–${yTo}` : `Visitas — total ${yFrom}–${yTo}`;
    let html = `<table class="data-table"><thead><tr>
      <th>Nombre comercial</th><th class="num">${colLabel}</th>
      <th class="num">Participación industria</th><th class="num">Gasto promedio del período</th>
    </tr></thead><tbody>`;
    html += bloque(rows19995, 'casinos 19.995', tot19995Vis, tot19995Win);
    html += bloque(rowsMunicipal, 'casinos municipales', totMunVis, totMunWin);
    html += `<tr class="total-row"><td>Total industria</td><td class="num">${fmtNum(visVal(totalVis))}</td>
      <td class="num">100%</td>
      <td class="num">${fmtMoney(gasto(totalVis, totalWin))}</td></tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function convertirDesdeUF(ufValue) {
    if (ufValue === null || ufValue === undefined) return null;
    if (state.valueMode === 'uf') return ufValue;
    const pesos = ufValue * ufReferencia();
    if (state.valueMode === 'usd') return pesos / usdReferencia();
    return pesos;
  }

  function convertirUFaUSD(ufValue) {
    if (ufValue === null || ufValue === undefined) return null;
    return (ufValue * ufReferencia()) / usdReferencia();
  }

  function renderTablaOE(container) {
    const ufLabel = LIVE_UF ? `UF hoy (${LIVE_UF.fecha.slice(0, 10)})` : `UF promedio 2025`;
    const usdLabel = LIVE_USD ? `Dólar hoy (${LIVE_USD.fecha.slice(0, 10)})` : `Dólar promedio 2025`;
    // La UF y el dólar se muestran siempre; la tercera columna solo se agrega cuando el modo
    // seleccionado es pesos nominales/reales, para no duplicar la UF o el USD ya visibles.
    const showPesos = state.valueMode === 'nominal' || state.valueMode === 'real';
    const colLabelPesos = `${ufLabel} → valores ${valueModeLabel()}`;
    let total = 0, totalUsd = 0, totalConv = 0;
    let html = `<table class="data-table"><thead><tr>
      <th>Casino</th><th class="num">Oferta Económica (UF)</th><th class="num">Oferta Económica (${usdLabel})</th>${showPesos ? `<th class="num">${colLabelPesos}</th>` : ''}
    </tr></thead><tbody>`;
    CASINOS.filter((c) => c.OE_UF).sort((a, b) => b.OE_UF - a.OE_UF).forEach((c) => {
      const usd = convertirUFaUSD(c.OE_UF);
      total += c.OE_UF; totalUsd += usd;
      let fila = `<tr><td>${c.Casino}</td><td class="num">${fmtNum(c.OE_UF)}</td><td class="num">US$${fmtNum(usd)}</td>`;
      if (showPesos) {
        const conv = convertirDesdeUF(c.OE_UF);
        totalConv += conv;
        fila += `<td class="num">${fmtMoney(conv)}</td>`;
      }
      fila += '</tr>';
      html += fila;
    });
    html += `<tr class="total-row"><td>Total</td><td class="num">${fmtNum(total)}</td><td class="num">US$${fmtNum(totalUsd)}</td>${showPesos ? `<td class="num">${fmtMoney(totalConv)}</td>` : ''}</tr>`;
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Vista: Resumen Mensual (comparación año contra año, estilo informe MDS)
  // ---------------------------------------------------------------------

  // Agrega un indicador mes a mes para el alcance/entidad indicados, en cada uno de los
  // años solicitados. Aplica deflate() para 'Win Total' (respeta el toggle nominal/real/UF/USD);
  // 'Visitas' se reporta siempre en unidades. Devuelve la serie mensual y el último mes con
  // dato de cada año (para detectar años parciales / "Acum." y comparar períodos equivalentes).
  function mensualSeries(scope, key, indicador, years) {
    const casinoList = casinosFor(scope, key);
    const monthlyByYear = {}, hastaMesByYear = {};
    years.forEach((y) => {
      const vals = [];
      let hastaMes = 0;
      for (let m = 1; m <= 12; m++) {
        let suma = null;
        casinoList.forEach((c) => {
          const v = monthValue(c, y, m, indicador);
          if (v !== null) { suma = (suma || 0) + v; }
        });
        if (suma !== null) {
          vals.push(indicador === 'Win Total' ? deflate(suma, y) : suma);
          hastaMes = m;
        } else {
          vals.push(null);
        }
      }
      monthlyByYear[y] = vals;
      hastaMesByYear[y] = hastaMes;
    });
    return { years, monthlyByYear, hastaMesByYear };
  }

  // Máximo de años comparables a la vez: el estilo de flechas curvas apiladas (ver
  // yoyAnnotationsPlugin) se vuelve ilegible con más de 3 años en el mismo gráfico.
  const MENSUAL_MAX_YEARS = 3;

  function renderResumenMensual() {
    const el = document.getElementById('view-mensual');
    if (!state.mensualScope) state.mensualScope = 'industria';
    // state.mensualYears guarda los años puntuales elegidos (no necesariamente los últimos ni
    // consecutivos). Se valida contra los años con datos disponibles y, si queda vacío o
    // inválido, se inicializa con los últimos 3 (comportamiento por defecto).
    if (!Array.isArray(state.mensualYears) || !state.mensualYears.length ||
        state.mensualYears.some((y) => !YEARS.includes(y))) {
      state.mensualYears = YEARS.slice(-MENSUAL_MAX_YEARS);
    }

    el.innerHTML = `
      <div class="section-title">Resumen Mensual — comparación año contra año</div>
      <div class="section-sub">Visitas e Ingresos Brutos del Juego por mes · valores ${valueModeLabel()}</div>
      <div class="card">
        <div class="filter-row">
          <label for="sel-mensual-scope">Alcance</label>
          <select id="sel-mensual-scope">
            <option value="industria">Industria (todos los casinos)</option>
            <option value="holding">Grupo controlador</option>
            <option value="casino">Casino</option>
          </select>
          <div id="mensual-entidad-wrap" class="filter-row" style="margin:0;"></div>
        </div>
        <div class="filter-row">
          <label>Años a comparar (elige entre 1 y ${MENSUAL_MAX_YEARS})</label>
          <div class="checkbox-list" id="mensual-years-checklist"></div>
        </div>
      </div>
      <div class="section-title">Visitas</div>
      <div class="card">
        <div class="yoy-legend" id="mensual-legend-visitas"></div>
        <div class="chart-wrap tall"><canvas id="chart-mensual-visitas"></canvas></div>
        <div class="yoy-monthly-table" id="mensual-table-visitas"></div>
      </div>
      <div class="section-title">Ingresos Brutos del Juego</div>
      <div class="card">
        <div class="yoy-legend" id="mensual-legend-ingresos"></div>
        <div class="chart-wrap tall"><canvas id="chart-mensual-ingresos"></canvas></div>
        <div class="yoy-monthly-table" id="mensual-table-ingresos"></div>
      </div>
      <div class="section-title">Comparar grupo controlador o casino</div>
      <div class="section-sub">Compara un grupo controlador o un casino contra otro grupo, otro casino o el promedio de la industria, en el año o mes que elijas.</div>
      <div class="card">
        <div class="filter-row">
          <label for="comp-a-tipo">Entidad A</label>
          <select id="comp-a-tipo">
            <option value="holding">Grupo controlador</option>
            <option value="casino">Casino</option>
          </select>
          <select id="comp-a-entidad"></select>
        </div>
        <div class="filter-row">
          <label for="comp-b-tipo">Comparar contra</label>
          <select id="comp-b-tipo">
            <option value="holding">Otro grupo controlador</option>
            <option value="casino">Otro casino</option>
            <option value="industria_prom">Promedio de la industria (por casino)</option>
          </select>
          <select id="comp-b-entidad"></select>
        </div>
        <div class="filter-row">
          <label for="comp-periodo-tipo">Período</label>
          <select id="comp-periodo-tipo">
            <option value="anio">Año completo</option>
            <option value="mes">Mes específico</option>
          </select>
          <select id="comp-periodo-anio"></select>
          <select id="comp-periodo-mes"></select>
        </div>
        <div id="comp-resultado"></div>
        <div id="comp-chart-titulo" class="section-sub" style="margin-top:14px;"></div>
        <div class="chart-wrap"><canvas id="comp-chart-visitas"></canvas></div>
        <div class="chart-wrap" style="margin-top:10px;"><canvas id="comp-chart-ingresos"></canvas></div>
      </div>
    `;

    document.getElementById('sel-mensual-scope').value = state.mensualScope;
    renderMensualEntidadSelector();
    renderMensualYearsChecklist();
    drawResumenMensual();
    renderMensualComparador();

    document.getElementById('sel-mensual-scope').addEventListener('change', (ev) => {
      state.mensualScope = ev.target.value;
      state.mensualEntidad = null;
      renderMensualEntidadSelector();
      drawResumenMensual();
    });
  }

  function renderMensualYearsChecklist() {
    const cont = document.getElementById('mensual-years-checklist');
    cont.innerHTML = YEARS.map((y) => {
      const checked = state.mensualYears.includes(y);
      return `<div class="checkbox-chip ${checked ? 'checked' : ''}" data-year="${y}">${y}</div>`;
    }).join('');
    cont.querySelectorAll('.checkbox-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const year = Number(chip.getAttribute('data-year'));
        const idx = state.mensualYears.indexOf(year);
        if (idx >= 0) {
          // No permitir dejar la comparación sin ningún año seleccionado.
          if (state.mensualYears.length === 1) return;
          state.mensualYears.splice(idx, 1);
        } else {
          // Máximo 3 años simultáneos (ver MENSUAL_MAX_YEARS).
          if (state.mensualYears.length >= MENSUAL_MAX_YEARS) return;
          state.mensualYears.push(year);
          state.mensualYears.sort((a, b) => a - b);
        }
        renderMensualYearsChecklist();
        drawResumenMensual();
      });
    });
  }

  function renderMensualEntidadSelector() {
    const wrap = document.getElementById('mensual-entidad-wrap');
    if (state.mensualScope === 'industria') { wrap.innerHTML = ''; return; }
    const options = state.mensualScope === 'holding' ? HOLDING_ORDER : CASINOS.map((c) => c.Casino);
    if (!state.mensualEntidad || !options.includes(state.mensualEntidad)) state.mensualEntidad = options[0];
    wrap.innerHTML = `<label for="sel-mensual-entidad">${state.mensualScope === 'holding' ? 'Grupo controlador' : 'Casino'}</label>
      <select id="sel-mensual-entidad">${options.map((o) => `<option value="${o}" ${o === state.mensualEntidad ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    document.getElementById('sel-mensual-entidad').addEventListener('change', (ev) => {
      state.mensualEntidad = ev.target.value;
      drawResumenMensual();
    });
  }

  function drawResumenMensual() {
    // state.mensualYears ya viene ordenado ascendente (ver renderMensualYearsChecklist), lo que
    // determina el orden izquierda→derecha de las barras y la paleta YEAR_COLORS (claro→oscuro).
    const years = state.mensualYears;
    const scope = state.mensualScope;
    const key = scope === 'industria' ? null : state.mensualEntidad;

    const visSeries = mensualSeries(scope, key, 'Visitas', years);
    const ingSeries = mensualSeries(scope, key, 'Win Total', years);
    // Eje del gráfico: 'Visitas' es un conteo (shortNumPlain, sin prefijo de moneda);
    // 'Ingresos Brutos' respeta el modo de valor vigente (shortNum, con $/UF/US$).
    // Cada fila tiene su propia leyenda de años (mensual-legend-*), pegada al título de su
    // propio gráfico, para que no se confunda con la leyenda de la otra fila. Los totales y
    // variaciones % ya no se muestran junto al gráfico: quedan en la tabla de detalle mensual
    // al pie (ver mensualVariationTableHtml), que incluye la misma información sin duplicarla.
    drawYoyRow('chart-mensual-visitas', 'mensualVisitas', years, visSeries, fmtNum, shortNumPlain, 'mensual-legend-visitas', 'mensual-table-visitas');
    drawYoyRow('chart-mensual-ingresos', 'mensualIngresos', years, ingSeries, fmtMoneyAuto, shortNum, 'mensual-legend-ingresos', 'mensual-table-ingresos');
  }

  function drawYoyRow(canvasId, chartKey, years, series, fmtFn, axisFmt, legendId, tableContainerId) {
    const datasets = years.map((y, i) => ({
      label: String(y),
      data: series.monthlyByYear[y],
      backgroundColor: YEAR_COLORS[i % YEAR_COLORS.length],
      borderRadius: 3,
      maxBarThickness: 26,
    }));
    document.getElementById(legendId).innerHTML = years.map((y, i) =>
      `<span><span class="legend-dot" style="background:${YEAR_COLORS[i % YEAR_COLORS.length]}"></span>${y}</span>`
    ).join('');
    makeYoyBarChart(document.getElementById(canvasId), chartKey, MONTHS_ES, datasets, fmtFn, axisFmt);

    // El total comparado debe cortar TODOS los años en el mismo mes que el año más reciente
    // (p. ej. "Acum. Abr"), igual que el resto del dashboard (ver periodoLabel en renderCasinos);
    // de lo contrario se compararía un año parcial contra un año completo.
    const lastYear = years[years.length - 1];
    const cutoff = series.hastaMesByYear[lastYear] || 12;
    const parcial = cutoff > 0 && cutoff < 12;
    const totalHasta = (y) => {
      const vals = series.monthlyByYear[y].slice(0, cutoff);
      const any = vals.some((v) => v !== null && v !== undefined);
      if (!any) return null;
      return vals.reduce((a, v) => a + (v || 0), 0);
    };

    document.getElementById(tableContainerId).innerHTML = mensualVariationTableHtml(years, series, fmtFn, cutoff, parcial, totalHasta);
  }

  // Tabla de detalle mensual al pie del gráfico: meses en columnas (igual que el eje del
  // gráfico) y años + variación % en filas — una fila por año con sus 12 valores mensuales, y
  // entre cada par de años consecutivos una fila de Var.% mes a mes (el mismo dato que antes
  // mostraban las flechas/burbujas sobre las barras, ahora en formato tabla para que no se
  // amontone al comparar 3 años a la vez).
  function mensualVariationTableHtml(years, series, fmtFn, cutoff, parcial, totalHasta) {
    const totalLabel = `Total ${parcial ? 'Acum. ' + MONTHS_ES[cutoff - 1] : 'Año'}`;
    const thead = '<th>Año</th>' + MONTHS_ES.map((m) => `<th class="num">${m}</th>`).join('') +
      `<th class="num">${totalLabel}</th>`;
    let rows = '';
    years.forEach((y, i) => {
      let row = `<td><span class="legend-dot" style="background:${YEAR_COLORS[i % YEAR_COLORS.length]}"></span>${y}</td>`;
      for (let m = 0; m < 12; m++) {
        const val = series.monthlyByYear[y][m];
        row += `<td class="num">${val === null || val === undefined ? '—' : fmtFn(val)}</td>`;
      }
      const total = totalHasta(y);
      row += `<td class="num"><strong>${total === null || total === undefined ? '—' : fmtFn(total)}</strong></td>`;
      rows += `<tr>${row}</tr>`;

      if (i > 0) {
        let vrow = `<td>Var.% ${years[i - 1]}→${y}</td>`;
        for (let m = 0; m < 12; m++) {
          const val = series.monthlyByYear[y][m];
          const prevVal = series.monthlyByYear[years[i - 1]][m];
          const delta = (val === null || val === undefined) ? null : yoy(val, prevVal);
          vrow += `<td class="num">${fmtPctDelta(delta)}</td>`;
        }
        const prevTotal = totalHasta(years[i - 1]);
        vrow += `<td class="num">${fmtPctDelta(yoy(total, prevTotal))}</td>`;
        rows += `<tr class="subtotal-row">${vrow}</tr>`;
      }
    });
    return `<div class="table-scroll"><table class="data-table"><thead><tr>${thead}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ---------------------------------------------------------------------
  // Resumen Mensual: comparador libre (grupo/casino vs. grupo/casino/promedio industria)
  // ---------------------------------------------------------------------

  // Opciones de entidad disponibles para el selector, según el tipo elegido ('holding'/'casino').
  // 'industria_prom' no tiene lista de entidades: siempre representa el promedio de todos los casinos.
  function compEntidadOptions(tipo) {
    if (tipo === 'holding') return HOLDING_ORDER;
    if (tipo === 'casino') return CASINOS.map((c) => c.Casino);
    return [];
  }

  // Para 'holding' se aclara "(promedio por casino)" porque el valor mostrado NO es la suma
  // del grupo (que siempre ganaría por volumen frente a un solo casino), sino el promedio por
  // casino dentro del grupo — mismo criterio que 'industria_prom', para que la comparación sea
  // justa sin importar cuántas propiedades tenga cada lado.
  function compEntidadLabel(entity) {
    if (entity.tipo === 'casino') return entity.key;
    if (entity.tipo === 'holding') return `${entity.key} (promedio por casino)`;
    return 'Promedio de la industria (por casino)';
  }

  function entidadCasinoList(entity) {
    if (entity.tipo === 'holding') return casinosFor('holding', entity.key);
    if (entity.tipo === 'casino') return casinosFor('casino', entity.key);
    if (entity.tipo === 'industria_prom') return casinosFor('industria', null);
    return [];
  }

  // Valor de un indicador para una entidad (grupo/casino/promedio industria) en un período
  // (año completo o mes específico). El total siempre se divide por la cantidad de casinos que
  // efectivamente reportaron datos en ese período (no por el tamaño nominal del grupo), de modo
  // que 'holding' e 'industria_prom' queden expresados como promedio por casino: así un grupo de
  // varias propiedades no le "gana" a un solo casino solo por volumen. Para 'casino' la lista
  // tiene un único elemento, así que dividir por nConDatos no cambia el valor.
  function valorEntidadPeriodo(entity, periodo, indicador) {
    const casinoList = entidadCasinoList(entity);
    if (!casinoList.length) return null;
    let valorNominal = null;
    let nConDatos = 0;
    if (periodo.tipo === 'mes') {
      casinoList.forEach((c) => {
        const v = monthValue(c, periodo.anio, periodo.mes, indicador);
        if (v !== null) { valorNominal = (valorNominal || 0) + v; nConDatos++; }
      });
    } else {
      casinoList.forEach((c) => {
        let sumaCasino = null;
        for (let m = 1; m <= 12; m++) {
          const v = monthValue(c, periodo.anio, m, indicador);
          if (v !== null) sumaCasino = (sumaCasino || 0) + v;
        }
        if (sumaCasino !== null) { valorNominal = (valorNominal || 0) + sumaCasino; nConDatos++; }
      });
    }
    if (valorNominal === null) return null;
    let valor = indicador === 'Win Total' ? deflate(valorNominal, periodo.anio) : valorNominal;
    if (nConDatos > 0) valor = valor / nConDatos;
    return valor;
  }

  function periodoLabelComp(periodo) {
    if (periodo.tipo === 'mes') return `${MONTHS_ES_FULL[periodo.mes - 1]} de ${periodo.anio}`;
    return `año ${periodo.anio}`;
  }

  // Cantidad de meses con datos de Visitas informados para toda la industria en un año dado
  // (se usa como "corte" común al comparar años completos, para que un año en curso con solo
  // algunos meses informados se compare de forma pareja contra años ya cerrados).
  function mesesDisponiblesAnio(anio) {
    const meses = monthsWithData(CASINOS.map((c) => c.Casino), anio, 'Visitas');
    return meses || 12;
  }

  // Igual que valorEntidadPeriodo (rama 'año'), pero limitando la suma a los primeros
  // `hastaMes` meses del año, para poder comparar años parejos entre sí en la gráfica histórica.
  function valorEntidadAnioHasta(entity, anio, hastaMes, indicador) {
    const casinoList = entidadCasinoList(entity);
    if (!casinoList.length) return null;
    let valorNominal = null;
    let nConDatos = 0;
    casinoList.forEach((c) => {
      let sumaCasino = null;
      for (let m = 1; m <= hastaMes; m++) {
        const v = monthValue(c, anio, m, indicador);
        if (v !== null) sumaCasino = (sumaCasino || 0) + v;
      }
      if (sumaCasino !== null) { valorNominal = (valorNominal || 0) + sumaCasino; nConDatos++; }
    });
    if (valorNominal === null) return null;
    let valor = indicador === 'Win Total' ? deflate(valorNominal, anio) : valorNominal;
    if (nConDatos > 0) valor = valor / nConDatos;
    return valor;
  }

  // Serie de los últimos 12 meses (terminando en anioFin/mesFin) para una entidad e indicador,
  // usada en el gráfico histórico del comparador cuando el período elegido es "mes específico".
  function comparadorSerieMeses(entity, indicador, anioFin, mesFin) {
    const casinoList = entidadCasinoList(entity);
    const seq = [];
    let y = anioFin, m = mesFin;
    for (let i = 0; i < 12; i++) {
      seq.unshift({ y, m });
      m--;
      if (m < 1) { m = 12; y--; }
    }
    const data = seq.map((p) => {
      if (!casinoList.length) return null;
      let valorNominal = null;
      let nConDatos = 0;
      casinoList.forEach((c) => {
        const v = monthValue(c, p.y, p.m, indicador);
        if (v !== null) { valorNominal = (valorNominal || 0) + v; nConDatos++; }
      });
      if (valorNominal === null) return null;
      let valor = indicador === 'Win Total' ? deflate(valorNominal, p.y) : valorNominal;
      if (nConDatos > 0) valor = valor / nConDatos;
      return valor;
    });
    const labels = seq.map((p) => `${MONTHS_ES[p.m - 1]} ${String(p.y).slice(-2)}`);
    return { labels, data };
  }

  // Serie de los últimos 5 años con datos (terminando en anioFin) para una entidad e indicador,
  // usada en el gráfico histórico del comparador cuando el período elegido es "año completo".
  // Si el año más reciente no tiene los 12 meses informados, todos los años se acumulan solo
  // hasta ese mismo mes de corte, para que la comparación sea pareja.
  function comparadorSerieAnios(entity, indicador, anioFin) {
    const hastaMes = mesesDisponiblesAnio(anioFin);
    const anios = YEARS.filter((y) => y <= anioFin).slice(-5);
    const data = anios.map((y) => valorEntidadAnioHasta(entity, y, hastaMes, indicador));
    const labels = anios.map((y) => (hastaMes < 12 ? `${y} (a ${MONTHS_ES[hastaMes - 1]})` : `${y}`));
    return { labels, data };
  }

  function renderMensualComparador() {
    if (!state.compA) state.compA = { tipo: 'holding', key: HOLDING_ORDER[0] };
    if (!state.compB) state.compB = { tipo: 'holding', key: HOLDING_ORDER[1] || HOLDING_ORDER[0] };
    if (!state.compPeriodo) {
      const info = latestYearInfo();
      state.compPeriodo = { tipo: 'mes', anio: info.year, mes: info.meses || 12 };
    }

    const aTipoSel = document.getElementById('comp-a-tipo');
    const aEntSel = document.getElementById('comp-a-entidad');
    const bTipoSel = document.getElementById('comp-b-tipo');
    const bEntSel = document.getElementById('comp-b-entidad');
    const perTipoSel = document.getElementById('comp-periodo-tipo');
    const perAnioSel = document.getElementById('comp-periodo-anio');
    const perMesSel = document.getElementById('comp-periodo-mes');
    if (!aTipoSel) return; // la vista no está montada (p.ej. se cambió de pestaña)

    function fillEntidadSelect(sel, tipo, current) {
      const options = compEntidadOptions(tipo);
      if (!options.length) { sel.style.display = 'none'; sel.innerHTML = ''; return null; }
      sel.style.display = '';
      if (!current || !options.includes(current)) current = options[0];
      sel.innerHTML = options.map((o) => `<option value="${o}" ${o === current ? 'selected' : ''}>${o}</option>`).join('');
      return current;
    }

    aTipoSel.value = state.compA.tipo;
    state.compA.key = fillEntidadSelect(aEntSel, state.compA.tipo, state.compA.key);

    bTipoSel.value = state.compB.tipo;
    state.compB.key = fillEntidadSelect(bEntSel, state.compB.tipo, state.compB.key);

    perTipoSel.value = state.compPeriodo.tipo;
    perAnioSel.innerHTML = YEARS.map((y) => `<option value="${y}" ${y === state.compPeriodo.anio ? 'selected' : ''}>${y}</option>`).join('');
    perMesSel.innerHTML = MONTHS_ES_FULL.map((m, i) => {
      const mesNum = i + 1;
      const label = m.charAt(0).toUpperCase() + m.slice(1);
      return `<option value="${mesNum}" ${mesNum === state.compPeriodo.mes ? 'selected' : ''}>${label}</option>`;
    }).join('');
    perMesSel.style.display = state.compPeriodo.tipo === 'mes' ? '' : 'none';

    aTipoSel.onchange = () => { state.compA = { tipo: aTipoSel.value, key: null }; renderMensualComparador(); };
    aEntSel.onchange = () => { state.compA.key = aEntSel.value; drawMensualComparador(); };
    bTipoSel.onchange = () => { state.compB = { tipo: bTipoSel.value, key: null }; renderMensualComparador(); };
    bEntSel.onchange = () => { state.compB.key = bEntSel.value; drawMensualComparador(); };
    perTipoSel.onchange = () => { state.compPeriodo.tipo = perTipoSel.value; renderMensualComparador(); };
    perAnioSel.onchange = () => { state.compPeriodo.anio = Number(perAnioSel.value); drawMensualComparador(); };
    perMesSel.onchange = () => { state.compPeriodo.mes = Number(perMesSel.value); drawMensualComparador(); };

    drawMensualComparador();
  }

  function drawMensualComparador() {
    const cont = document.getElementById('comp-resultado');
    if (!cont) return;
    const a = state.compA, b = state.compB, periodo = state.compPeriodo;
    const labelA = compEntidadLabel(a);
    const labelB = compEntidadLabel(b);
    const perLabel = periodoLabelComp(periodo);

    const visA = valorEntidadPeriodo(a, periodo, 'Visitas');
    const visB = valorEntidadPeriodo(b, periodo, 'Visitas');
    const ingA = valorEntidadPeriodo(a, periodo, 'Win Total');
    const ingB = valorEntidadPeriodo(b, periodo, 'Win Total');

    const row = (label, valA, valB, fmtFn) => `<tr>
        <td>${label}</td>
        <td class="num">${fmtFn(valA)}</td>
        <td class="num">${fmtFn(valB)}</td>
        <td class="num">${fmtPctDelta(yoy(valA, valB))}</td>
      </tr>`;

    let html = `<p class="small muted" style="margin:0 0 10px;">Comparando <strong>${labelA}</strong> contra <strong>${labelB}</strong> — ${perLabel}.</p>`;
    html += `<table class="data-table"><thead><tr>
        <th>Indicador</th><th class="num">${labelA}</th><th class="num">${labelB}</th><th class="num">Var.% (A vs. B)</th>
      </tr></thead><tbody>`;
    html += row('Visitas', visA, visB, fmtNum);
    html += row('Ingresos Brutos del Juego', ingA, ingB, fmtMoneyAuto);
    html += '</tbody></table>';
    cont.innerHTML = html;

    drawComparadorCharts(a, b, periodo, labelA, labelB);
  }

  // Gráficos históricos del comparador: últimos 12 meses (si el período elegido es un mes
  // específico) o últimos 5 años (si el período elegido es año completo, acumulando todos los
  // años solo hasta el mismo mes de corte que tenga el año más reciente disponible).
  function drawComparadorCharts(a, b, periodo, labelA, labelB) {
    const tituloEl = document.getElementById('comp-chart-titulo');
    const canvasVis = document.getElementById('comp-chart-visitas');
    const canvasIng = document.getElementById('comp-chart-ingresos');
    if (!canvasVis || !canvasIng) return;

    let serieVisA, serieVisB, serieIngA, serieIngB, tituloRango;
    if (periodo.tipo === 'mes') {
      serieVisA = comparadorSerieMeses(a, 'Visitas', periodo.anio, periodo.mes);
      serieVisB = comparadorSerieMeses(b, 'Visitas', periodo.anio, periodo.mes);
      serieIngA = comparadorSerieMeses(a, 'Win Total', periodo.anio, periodo.mes);
      serieIngB = comparadorSerieMeses(b, 'Win Total', periodo.anio, periodo.mes);
      tituloRango = 'Evolución de los últimos 12 meses';
    } else {
      serieVisA = comparadorSerieAnios(a, 'Visitas', periodo.anio);
      serieVisB = comparadorSerieAnios(b, 'Visitas', periodo.anio);
      serieIngA = comparadorSerieAnios(a, 'Win Total', periodo.anio);
      serieIngB = comparadorSerieAnios(b, 'Win Total', periodo.anio);
      tituloRango = 'Evolución de los últimos ' + serieVisA.labels.length + ' años';
    }
    if (tituloEl) tituloEl.textContent = `${tituloRango} — ${labelA} vs. ${labelB}`;

    const dsVis = [
      { label: labelA, data: serieVisA.data, borderColor: '#0B1F33', backgroundColor: '#0B1F3322', tension: 0.25, pointRadius: 2 },
      { label: labelB, data: serieVisB.data, borderColor: '#5B9BD5', backgroundColor: '#5B9BD522', tension: 0.25, pointRadius: 2 },
    ];
    const dsIng = [
      { label: labelA, data: serieIngA.data, borderColor: '#0B1F33', backgroundColor: '#0B1F3322', tension: 0.25, pointRadius: 2 },
      { label: labelB, data: serieIngB.data, borderColor: '#5B9BD5', backgroundColor: '#5B9BD522', tension: 0.25, pointRadius: 2 },
    ];
    makeComparadorLineChart(canvasVis, 'comp-chart-visitas', serieVisA.labels, dsVis, {
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        title: { display: true, text: 'Visitas', font: { size: 12 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtNum(item.raw)}` } },
      },
      scales: { x: { offset: true }, y: { ticks: { callback: (v) => shortNum(v) } } },
    }, shortNum);
    makeComparadorLineChart(canvasIng, 'comp-chart-ingresos', serieIngA.labels, dsIng, {
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 11 } } },
        title: { display: true, text: 'Ingresos Brutos del Juego', font: { size: 12 } },
        tooltip: { callbacks: { label: (item) => `${item.dataset.label}: ${fmtMoneyAuto(item.raw)}` } },
      },
      scales: { x: { offset: true }, y: { ticks: { callback: (v) => shortNum(v) } } },
    }, shortNum);
  }

  // ---------------------------------------------------------------------
  // Vista: Equipamiento (máquinas de azar, mesas de juego y bingo)
  // ---------------------------------------------------------------------

  function equipYears() {
    return Array.from(new Set(EQUIPAMIENTO.map((r) => r.anio))).sort((a, b) => a - b);
  }

  function renderEquipamiento() {
    const el = document.getElementById('view-equipamiento');
    const years = equipYears();
    if (!years.length) {
      el.innerHTML = '<div class="card">No hay datos de equipamiento cargados.</div>';
      return;
    }
    const yFrom = Math.max(state.yearFrom, years[0]);
    const yTo = Math.min(state.yearTo, years[years.length - 1]);
    const yearSet = new Set(years);
    const effYears = yearsInRange(yFrom, yTo).filter((y) => yearSet.has(y));
    const yLatest = effYears.length ? effYears[effYears.length - 1] : years[years.length - 1];

    // Series totales por año — calculadas antes del HTML para poder alimentar el panel de
    // narrativa (además del gráfico, que las recalcula desde EQUIPAMIENTO más abajo).
    const totMaquinasEq = [], totBingoEq = [];
    effYears.forEach((y) => {
      const rows = EQUIPAMIENTO.filter((r) => r.anio === y);
      const anyMaq = rows.some((r) => r.maquinas_azar !== null && r.maquinas_azar !== undefined);
      const anyBingo = rows.some((r) => r.bingo_mesas !== null && r.bingo_mesas !== undefined);
      totMaquinasEq.push(anyMaq ? rows.reduce((a, r) => a + (r.maquinas_azar || 0), 0) : null);
      totBingoEq.push(anyBingo ? rows.reduce((a, r) => a + (r.bingo_mesas || 0), 0) : null);
    });
    const nEq = effYears.length;
    const trendMaq = trendGrowthPct(trendlineData(totMaquinasEq, effYears, null));
    const trendBingo = trendGrowthPct(trendlineData(totBingoEq, effYears, null));
    const yoyMaqLast = nEq >= 2 ? yoy(totMaquinasEq[nEq - 1], totMaquinasEq[nEq - 2]) : null;
    const bulletsEq = [
      trendMaq !== null ? `Las máquinas de azar muestran una tendencia de ${fmtPctDelta(trendMaq)} entre ${effYears[0]} y ${yLatest}, con ${fmtNum(totMaquinasEq[nEq - 1])} unidades en ${yLatest}${nEq >= 2 ? ` (${fmtPctDelta(yoyMaqLast)} vs. ${effYears[nEq - 2]})` : ''}.` : '',
      trendBingo !== null ? `Las posiciones de bingo muestran una tendencia de ${fmtPctDelta(trendBingo)} en el mismo período, con ${fmtNum(totBingoEq[nEq - 1])} posiciones en ${yLatest}.` : '',
    ];

    el.innerHTML = `
      <div class="section-title">Equipamiento — Máquinas de azar, mesas de juego y bingo</div>
      <div class="section-sub">Fuente: Tablas de equipamiento de los Informes Anuales de la Industria, SCJ (${years[0]}–${years[years.length - 1]}) · ${yFrom}–${yTo}</div>
      ${insightsPanel(bulletsEq)}
      <div class="card">
        <div class="section-title" style="margin-top:0;">Evolución de la industria</div>
        <div class="chart-wrap tall"><canvas id="chart-equip-evol"></canvas></div>
        <p class="small muted" style="margin-bottom:0;">* Los Informes Anuales SCJ 2018, 2019 y 2020 no reportaron mesas de juego físicas (solo posiciones de juego). Las barras de "Mesas de juego" en tono más claro (2018–2020) son una estimación por interpolación lineal entre 2017 y 2021, no un dato oficial. Máquinas de azar y posiciones de bingo sí están disponibles para todo el período.</p>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Participación de máquinas de azar por holding — Año ${yLatest}</div>
          <div class="chart-wrap"><canvas id="chart-equip-donut-maquinas"></canvas></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Evolución de máquinas de azar — por holding</div>
          <div class="chart-wrap"><canvas id="chart-equip-casinos-maquinas"></canvas></div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Participación de mesas de juego por holding — Año ${yLatest}</div>
          <div class="chart-wrap"><canvas id="chart-equip-donut-mesas"></canvas></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Evolución de mesas de juego — por holding</div>
          <div class="chart-wrap"><canvas id="chart-equip-casinos-mesas"></canvas></div>
          <p class="small muted" style="margin:8px 0 0;">* Tramo 2018–2020 (línea segmentada) estimado por interpolación lineal entre 2017 y 2021 — los Informes SCJ de esos años no reportan mesas físicas, solo posiciones de juego. No es dato oficial.</p>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Participación de posiciones de bingo por holding — Año ${yLatest}</div>
          <div class="chart-wrap"><canvas id="chart-equip-donut-bingo"></canvas></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Evolución de posiciones de bingo — por holding</div>
          <div class="chart-wrap"><canvas id="chart-equip-casinos-bingo"></canvas></div>
        </div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0;">Detalle por casino — Año ${yLatest}</div>
        <div class="table-scroll" id="tabla-equip-casinos"></div>
      </div>
    `;

    const labels = effYears.map(String);
    const totMaquinas = [], totMesas = [], totBingo = [];
    effYears.forEach((y) => {
      const rows = EQUIPAMIENTO.filter((r) => r.anio === y);
      const anyMaq = rows.some((r) => r.maquinas_azar !== null && r.maquinas_azar !== undefined);
      const anyMesas = rows.some((r) => r.mesas_total !== null && r.mesas_total !== undefined);
      const anyBingo = rows.some((r) => r.bingo_mesas !== null && r.bingo_mesas !== undefined);
      totMaquinas.push(anyMaq ? rows.reduce((a, r) => a + (r.maquinas_azar || 0), 0) : null);
      totMesas.push(anyMesas ? rows.reduce((a, r) => a + (r.mesas_total || 0), 0) : null);
      totBingo.push(anyBingo ? rows.reduce((a, r) => a + (r.bingo_mesas || 0), 0) : null);
    });

    const totMesasInterp = interpolateGaps(totMesas);
    // Años con "Mesas de juego" estimada por interpolación (sin dato oficial SCJ) se pintan en un
    // tono más claro dentro de la misma serie, para distinguirlas sin necesitar una leyenda aparte.
    const mesasColors = effYears.map((_, i) => totMesasInterp.isInterp[i] ? 'rgba(31,78,120,.4)' : '#1F4E78');
    makeBarChart(document.getElementById('chart-equip-evol'), 'equipEvol', labels, [
      { label: 'Máquinas de azar', data: totMaquinas, backgroundColor: '#0B1F33' },
      { label: 'Mesas de juego', data: totMesasInterp.values, backgroundColor: mesasColors },
      { label: 'Posiciones de bingo', data: totBingo, backgroundColor: '#5B9BD5' },
    ], { scales: { x: { stacked: true }, y: { stacked: true, ticks: { callback: (v) => fmtNum(v) } } } });

    const byCasinoLatest = {};
    EQUIPAMIENTO.filter((r) => r.anio === yLatest).forEach((r) => { byCasinoLatest[r.casino] = r; });

    renderEquipMetricCharts('maquinas_azar', 'chart-equip-donut-maquinas', 'chart-equip-casinos-maquinas', effYears, labels, byCasinoLatest);
    renderEquipMetricCharts('mesas_total', 'chart-equip-donut-mesas', 'chart-equip-casinos-mesas', effYears, labels, byCasinoLatest);
    renderEquipMetricCharts('bingo_mesas', 'chart-equip-donut-bingo', 'chart-equip-casinos-bingo', effYears, labels, byCasinoLatest);

    renderTablaEquipCasinos(document.getElementById('tabla-equip-casinos'), yLatest);
  }

  function renderEquipMetricCharts(metricKey, donutId, lineId, effYears, labels, byCasinoLatest) {
    const holdingTotalsOrdered = HOLDING_ORDER.map((h) => ({
      h, total: casinosFor('holding', h).reduce((a, c) => a + ((byCasinoLatest[c] && byCasinoLatest[c][metricKey]) || 0), 0),
    })).sort((a, b) => b.total - a.total);
    makeDoughnut(document.getElementById(donutId), 'equipDonut_' + metricKey,
      holdingTotalsOrdered.map((r) => r.h), holdingTotalsOrdered.map((r) => r.total),
      holdingTotalsOrdered.map((r) => HOLDING_TONES[r.h]), true);

    const datasetsHoldings = HOLDING_ORDER.map((h) => {
      const casinosH = casinosFor('holding', h);
      const rawData = effYears.map((y) => {
        const rows = casinosH.map((c) => EQUIPAMIENTO.find((rr) => rr.anio === y && rr.casino === c));
        const anyVal = rows.some((r) => r && r[metricKey] !== null && r[metricKey] !== undefined);
        return anyVal ? rows.reduce((a, r) => a + ((r && r[metricKey]) || 0), 0) : null;
      });
      // 'mesas_total' tiene un hueco real 2018-2020 (informes SCJ sin conteo físico de mesas);
      // se interpola linealmente entre los años conocidos más cercanos y se marca la línea como segmentada.
      const interp = metricKey === 'mesas_total' ? interpolateGaps(rawData) : null;
      return {
        label: h,
        borderColor: HOLDING_TONES[h],
        // brandShades() devuelve hsl(...), no hex, así que la transparencia se agrega con
        // hsla(...) en vez del sufijo hex de 2 dígitos que usa el resto del dashboard con hex.
        backgroundColor: HOLDING_TONES[h].replace('hsl(', 'hsla(').replace(')', ', 0.13)'),
        data: interp ? interp.values : rawData,
        tension: 0.2, fill: false,
        segment: interp ? { borderDash: (ctx) => (interp.isInterp[ctx.p0DataIndex] || interp.isInterp[ctx.p1DataIndex]) ? [6, 4] : undefined } : undefined,
      };
    });
    makeLineChart(document.getElementById(lineId), 'equipCasinos_' + metricKey, labels, datasetsHoldings,
      { scales: { y: { ticks: { callback: (v) => fmtNum(v) } } } }, true);
  }

  function renderTablaEquipCasinos(container, year) {
    const byCasino = {};
    EQUIPAMIENTO.filter((r) => r.anio === year).forEach((r) => { byCasino[r.casino] = r; });
    let totMesas = 0, totRuleta = 0, totCartas = 0, totDados = 0, totBingo = 0, totMaq = 0, anyMaqNull = false;
    let html = `<table class="data-table"><thead><tr>
      <th>Casino</th><th>Holding</th><th class="num">Ruleta</th><th class="num">Cartas</th><th class="num">Dados</th>
      <th class="num">Mesas total</th><th class="num">Posiciones de bingo</th><th class="num">Máquinas de azar</th>
    </tr></thead><tbody>`;
    const filas = CASINOS.map((c) => ({ c, r: byCasino[c.Casino] })).filter((f) => f.r);
    filas.sort((a, b) => {
      const ma = a.r.maquinas_azar, mb = b.r.maquinas_azar;
      if (ma === null || ma === undefined) return mb === null || mb === undefined ? 0 : 1;
      if (mb === null || mb === undefined) return -1;
      return mb - ma;
    });
    filas.forEach(({ c, r }) => {
      const t = r.mesas_por_tipo || {};
      const maq = r.maquinas_azar;
      const flag = r.notas ? ` <span class="small muted" title="${r.notas}">⚠</span>` : '';
      html += `<tr><td>${c.Casino}${flag}</td><td>${c.Holding}</td>
        <td class="num">${fmtNum(t.Ruleta || 0)}</td><td class="num">${fmtNum(t.Cartas || 0)}</td><td class="num">${fmtNum(t.Dados || 0)}</td>
        <td class="num">${fmtNum(r.mesas_total)}</td><td class="num">${fmtNum(r.bingo_mesas)}</td>
        <td class="num">${maq === null || maq === undefined ? '—' : fmtNum(maq)}</td></tr>`;
      totMesas += r.mesas_total || 0; totRuleta += t.Ruleta || 0; totCartas += t.Cartas || 0; totDados += t.Dados || 0;
      totBingo += r.bingo_mesas || 0;
      if (maq === null || maq === undefined) anyMaqNull = true; else totMaq += maq;
    });
    html += `<tr class="total-row"><td>Total industria</td><td></td>
      <td class="num">${fmtNum(totRuleta)}</td><td class="num">${fmtNum(totCartas)}</td><td class="num">${fmtNum(totDados)}</td>
      <td class="num">${fmtNum(totMesas)}</td><td class="num">${fmtNum(totBingo)}</td>
      <td class="num">${fmtNum(totMaq)}${anyMaqNull ? '*' : ''}</td></tr>`;
    html += '</tbody></table>';
    if (anyMaqNull) html += '<p class="small muted">* Total parcial: uno o más casinos no reportan un valor confiable de máquinas de azar para este año (ver ⚠ en la fila correspondiente).</p>';
    container.innerHTML = html;
  }

  // ---------------------------------------------------------------------
  // Vista: Datos y Actualización
  // ---------------------------------------------------------------------

  function renderDatos() {
    const el = document.getElementById('view-datos');
    el.innerHTML = `
      <div class="section-title">Datos y Actualización</div>
      <div class="section-sub">Fuente primaria: planilla mensual entregada por la SCJ. Última carga: ${RAW.generated_at}.</div>

      <div class="card">
        <div class="section-title" style="margin-top:0;">Actualización de indicadores económicos (IPC / UF / Dólar)</div>
        <p class="small muted" style="margin-top:0;">Consulta en vivo a <strong>mindicador.cl</strong> (Banco Central de Chile) para incorporar la inflación acumulada del año en curso al factor de conversión a valores reales, y los valores de UF y dólar del día para las conversiones de Ofertas Económicas y de cifras a UF/USD. Se actualiza automáticamente al abrir la aplicación; si no hay conexión, se usa la última actualización guardada en este navegador.</p>
        <button class="btn" id="btn-actualizar-ipc">Actualizar desde mindicador.cl</button>
        <div class="status-line" id="status-actualizacion"></div>
        <div class="kpi-grid" id="kpi-indicadores" style="margin-top:14px;"></div>
      </div>

      <div class="grid-2">
        <div class="card">
          <div class="section-title" style="margin-top:0;">Factor deflactor por año (base 2026 = 1,000000)</div>
          <div class="table-scroll" id="tabla-deflactor"></div>
        </div>
        <div class="card">
          <div class="section-title" style="margin-top:0;">Cobertura de datos por casino</div>
          <div class="table-scroll" id="tabla-cobertura"></div>
        </div>
      </div>
    `;
    document.getElementById('btn-actualizar-ipc').addEventListener('click', actualizarIndicadores);
    renderTablaDeflactor();
    renderTablaCobertura();
    renderIndicadoresActuales();
  }

  function renderIndicadoresActuales() {
    const cont = document.getElementById('kpi-indicadores');
    if (!cont) return;
    const ufFuente = LIVE_UF ? `UF hoy · ${LIVE_UF.fecha.slice(0, 10)}` : 'UF promedio 2025 (dato base del informe, sin actualización en vivo)';
    const usdFuente = LIVE_USD ? `Dólar hoy · ${LIVE_USD.fecha.slice(0, 10)}` : 'Dólar promedio 2025 (dato base del informe, sin actualización en vivo)';
    cont.innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">UF utilizada en conversiones</div>
        <div class="kpi-value">${fmtCLP(ufReferencia())}</div>
        <div class="kpi-delta neutral">${ufFuente}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Dólar utilizado en conversiones</div>
        <div class="kpi-value">${fmtCLP(usdReferencia())}</div>
        <div class="kpi-delta neutral">${usdFuente}</div>
      </div>
    `;
  }

  function renderTablaDeflactor() {
    const table = LIVE_DEFLACTOR || RAW.deflactor;
    let html = '<table class="data-table"><thead><tr><th>Año</th><th class="num">Factor</th></tr></thead><tbody>';
    Object.keys(table).sort().forEach((y) => {
      html += `<tr><td>${y}</td><td class="num">${Number(table[y]).toFixed(6)}</td></tr>`;
    });
    html += '</tbody></table>';
    document.getElementById('tabla-deflactor').innerHTML = html;
  }

  function renderTablaCobertura() {
    let html = '<table class="data-table"><thead><tr><th>Casino</th><th>Holding</th><th>Nivel</th><th class="num">Meses con dato</th></tr></thead><tbody>';
    const filas = CASINOS.map((c) => {
      let meses = 0;
      YEARS.forEach((y) => { for (let m = 1; m <= 12; m++) if (monthValue(c.Casino, y, m, 'Win Total') !== null) meses++; });
      return { c, meses };
    });
    filas.sort((a, b) => b.meses - a.meses);
    filas.forEach(({ c, meses }) => {
      const badge = c.Tier === 'municipal' ? '<span class="badge badge-municipal">Municipal</span>' : '<span class="badge badge-19995">19.995</span>';
      html += `<tr><td>${c.Casino}</td><td>${c.Holding}</td><td>${badge}</td><td class="num">${meses}</td></tr>`;
    });
    html += '</tbody></table>';
    document.getElementById('tabla-cobertura').innerHTML = html;
  }

  async function actualizarIndicadores() {
    const statusEl = document.getElementById('status-actualizacion');
    const btn = document.getElementById('btn-actualizar-ipc');
    if (btn) btn.disabled = true;
    if (statusEl) { statusEl.className = 'status-line'; statusEl.textContent = 'Consultando mindicador.cl...'; }
    try {
      const currentYear = new Date().getFullYear();
      const [ipcRes, ufRes, usdRes] = await Promise.all([
        fetch(`https://mindicador.cl/api/ipc/${currentYear}`),
        fetch('https://mindicador.cl/api/uf'),
        fetch('https://mindicador.cl/api/dolar'),
      ]);
      if (!ipcRes.ok || !ufRes.ok || !usdRes.ok) throw new Error('Respuesta no válida del servicio');
      const ipcData = await ipcRes.json();
      const ufData = await ufRes.json();
      const usdData = await usdRes.json();

      const serie = ipcData.serie || [];
      let acumulado = 1;
      serie.forEach((p) => { acumulado *= (1 + p.valor / 100); });
      acumulado -= 1;

      LIVE_DEFLACTOR = {};
      Object.keys(RAW.deflactor).forEach((y) => { LIVE_DEFLACTOR[y] = RAW.deflactor[y] * (1 + acumulado); });
      LIVE_UF = (ufData.serie && ufData.serie[0]) ? ufData.serie[0] : null;
      LIVE_USD = (usdData.serie && usdData.serie[0]) ? usdData.serie[0] : null;
      guardarCacheIndicadores();

      const fecha = new Date().toLocaleString('es-CL');
      if (statusEl) {
        statusEl.className = 'status-line ok';
        statusEl.textContent = `Actualizado ${fecha} · IPC acumulado ${currentYear} (${serie.length} meses publicados): ${fmtPct(acumulado)} · UF hoy: ${LIVE_UF ? fmtCLP(LIVE_UF.valor) : 'no disponible'} · Dólar hoy: ${LIVE_USD ? fmtCLP(LIVE_USD.valor) : 'no disponible'}`;
      }
      renderCurrentView();
    } catch (e) {
      const cache = aplicarCacheIndicadores();
      if (statusEl) {
        statusEl.className = 'status-line error';
        statusEl.textContent = cache
          ? `No se pudo actualizar (${e.message}) · usando última actualización guardada del ${new Date(cache.timestamp).toLocaleString('es-CL')}.`
          : `No se pudo actualizar (${e.message}) · usando datos base del informe.`;
      }
      if (cache) renderCurrentView();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Navegación y controles globales
  // ---------------------------------------------------------------------

  function renderCurrentView() {
    switch (state.view) {
      case 'resumen': renderResumen(); break;
      case 'industria': renderIndustria(); break;
      case 'holdings': renderHoldings(); break;
      case 'casinos': renderCasinos(); break;
      case 'mensual': renderResumenMensual(); break;
      case 'equipamiento': renderEquipamiento(); break;
      case 'datos': renderDatos(); break;
      case 'admin': renderAdmin(); break;
    }
  }

  function setupTabs() {
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
        btn.classList.add('active');
        const view = btn.getAttribute('data-view');
        document.getElementById('view-' + view).classList.add('active');
        state.view = view;
        renderCurrentView();
      });
    });
  }

  function setupValueToggle() {
    document.querySelectorAll('.toggle-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.toggle-btn').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        state.valueMode = btn.getAttribute('data-value-mode');
        renderCurrentView();
      });
    });
  }

  function setupYearSelectors() {
    const selFrom = document.getElementById('year-from');
    const selTo = document.getElementById('year-to');
    selFrom.innerHTML = YEARS.map((y) => `<option value="${y}">${y}</option>`).join('');
    selTo.innerHTML = YEARS.map((y) => `<option value="${y}">${y}</option>`).join('');
    state.yearFrom = YEARS[0];
    state.yearTo = YEARS[YEARS.length - 1];
    selFrom.value = state.yearFrom;
    selTo.value = state.yearTo;
    selFrom.addEventListener('change', () => {
      state.yearFrom = Number(selFrom.value);
      if (state.yearFrom > state.yearTo) { state.yearTo = state.yearFrom; selTo.value = state.yearTo; }
      renderCurrentView();
    });
    selTo.addEventListener('change', () => {
      state.yearTo = Number(selTo.value);
      if (state.yearTo < state.yearFrom) { state.yearFrom = state.yearTo; selFrom.value = state.yearFrom; }
      renderCurrentView();
    });
  }

  function setupTrendFromSelector() {
    const sel = document.getElementById('trend-from');
    sel.innerHTML = '<option value="">Automático</option>' + YEARS.map((y) => `<option value="${y}">${y}</option>`).join('');
    sel.addEventListener('change', () => {
      state.trendFrom = sel.value ? Number(sel.value) : null;
      renderCurrentView();
    });
  }

  function setupPandemiaToggle() {
    document.getElementById('chk-pandemia').addEventListener('change', (e) => {
      state.excluirPandemia = e.target.checked;
      renderCurrentView();
    });
  }

  // ---------------------------------------------------------------------
  // Exportación de datos a Excel — archivo .xlsx nativo (Open XML), generado
  // a mano como ZIP sin compresión (método STORE) para no depender de librerías
  // externas. Abre directamente en Excel sin advertencias de formato/extensión.
  // ---------------------------------------------------------------------

  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function concatBytes(parts) {
    let total = 0;
    parts.forEach((p) => { total += p.length; });
    const out = new Uint8Array(total);
    let off = 0;
    parts.forEach((p) => { out.set(p, off); off += p.length; });
    return out;
  }

  // Empaqueta `entries` ({name, data:Uint8Array}) como archivo ZIP válido, sin
  // comprimir (method=0/STORE). Un .xlsx no es más que un ZIP con esta estructura.
  function buildZipStore(entries) {
    const enc = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    entries.forEach((entry) => {
      const nameBytes = enc.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);
      const size = data.length;
      const local = new Uint8Array(30 + nameBytes.length);
      const dv = new DataView(local.buffer);
      dv.setUint32(0, 0x04034b50, true);
      dv.setUint16(4, 20, true);
      dv.setUint16(6, 0, true);
      dv.setUint16(8, 0, true);
      dv.setUint16(10, 0, true);
      dv.setUint16(12, 0x21, true);
      dv.setUint32(14, crc, true);
      dv.setUint32(18, size, true);
      dv.setUint32(22, size, true);
      dv.setUint16(26, nameBytes.length, true);
      dv.setUint16(28, 0, true);
      local.set(nameBytes, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBytes.length);
      const cdv = new DataView(central.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(4, 20, true);
      cdv.setUint16(6, 20, true);
      cdv.setUint16(8, 0, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint16(14, 0x21, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, size, true);
      cdv.setUint32(24, size, true);
      cdv.setUint16(28, nameBytes.length, true);
      cdv.setUint16(30, 0, true);
      cdv.setUint16(32, 0, true);
      cdv.setUint16(34, 0, true);
      cdv.setUint16(36, 0, true);
      cdv.setUint32(38, 0, true);
      cdv.setUint32(42, offset, true);
      central.set(nameBytes, 46);
      centralParts.push(central);

      offset += local.length + data.length;
    });
    const centralStart = offset;
    const centralBytes = concatBytes(centralParts);
    const eocd = new Uint8Array(22);
    const edv = new DataView(eocd.buffer);
    edv.setUint32(0, 0x06054b50, true);
    edv.setUint16(8, entries.length, true);
    edv.setUint16(10, entries.length, true);
    edv.setUint32(12, centralBytes.length, true);
    edv.setUint32(16, centralStart, true);
    return concatBytes([...localParts, centralBytes, eocd]);
  }

  function xlsxColLetter(idx) {
    let s = '', n = idx + 1;
    while (n > 0) {
      const rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function xlsxSheetXml(headers, rows, numericCols, colWidths) {
    let colsXml = '';
    if (colWidths) {
      colsXml = '<cols>' + Object.keys(colWidths).map((ci) => {
        const col1 = Number(ci) + 1;
        return `<col min="${col1}" max="${col1}" width="${colWidths[ci]}" customWidth="1"/>`;
      }).join('') + '</cols>';
    }
    let rowsXml = `<row r="1">` + headers.map((h, ci) => (
      `<c r="${xlsxColLetter(ci)}1" t="inlineStr" s="1"><is><t xml:space="preserve">${xmlEsc(h)}</t></is></c>`
    )).join('') + `</row>`;
    rows.forEach((r, ri) => {
      const rn = ri + 2;
      rowsXml += `<row r="${rn}">` + r.map((val, ci) => {
        const ref = xlsxColLetter(ci) + rn;
        if (typeof val === 'number' && !isNaN(val)) {
          const s = numericCols && numericCols.has(ci) ? ' s="2"' : '';
          return `<c r="${ref}"${s}><v>${val}</v></c>`;
        }
        const str = val === null || val === undefined ? '' : String(val);
        if (str === '') return `<c r="${ref}"/>`;
        return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(str)}</t></is></c>`;
      }).join('') + `</row>`;
    });
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowsXml}</sheetData></worksheet>`;
  }

  // sheets: [{name, headers, rows, numericCols:Set, colWidths:{colIndex:width}}] → Uint8Array de un .xlsx completo y válido.
  function buildXlsxWorkbook(sheets) {
    const enc = new TextEncoder();
    const sheetFiles = sheets.map((sh, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(xlsxSheetXml(sh.headers, sh.rows, sh.numericCols, sh.colWidths)),
    }));
    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;
    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
    const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`;
    const workbookRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF16233F"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
</styleSheet>`;
    return buildZipStore([
      { name: '[Content_Types].xml', data: enc.encode(contentTypes) },
      { name: '_rels/.rels', data: enc.encode(rootRels) },
      { name: 'xl/workbook.xml', data: enc.encode(workbookXml) },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRels) },
      { name: 'xl/styles.xml', data: enc.encode(stylesXml) },
      ...sheetFiles,
    ]);
  }

  function descargarArchivo(nombre, contenido, mime) {
    const blob = new Blob([contenido], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

  function generarExcelHistorico() {
    const INDICADORES_EXPORT = { Visitas: 'Visitas', 'Win Total': 'Ingresos Brutos' };
    const filas = [];
    Object.keys(TREE).sort().forEach((casino) => {
      const holding = (CASINO_INDEX[casino] && CASINO_INDEX[casino].Holding) || '';
      const porAnio = TREE[casino];
      Object.keys(porAnio).map(Number).sort((a, b) => a - b).forEach((anio) => {
        const porMes = porAnio[anio];
        Object.keys(porMes).map(Number).sort((a, b) => a - b).forEach((mes) => {
          const porIndicador = porMes[mes];
          Object.keys(INDICADORES_EXPORT).forEach((indicador) => {
            if (porIndicador[indicador] === undefined) return;
            filas.push([casino, holding, anio, mes, INDICADORES_EXPORT[indicador], porIndicador[indicador]]);
          });
        });
      });
    });
    const xlsx = buildXlsxWorkbook([{
      name: 'Datos históricos',
      headers: ['Casino', 'Holding', 'Año', 'Mes', 'Variable', 'Valor'],
      rows: filas,
      numericCols: new Set([5]),
      colWidths: { 0: 28, 4: 22, 5: 18 },
    }]);
    descargarArchivo(`SCJ_datos_historicos_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsx, XLSX_MIME);
  }

  function setupExportExcel() {
    document.getElementById('btn-export-excel').addEventListener('click', generarExcelHistorico);
  }

  // ---------------------------------------------------------------------
  // Descarga individual de cada tabla como Excel
  // ---------------------------------------------------------------------

  // Deriva un título legible para una tabla a partir del .section-title más cercano que la
  // precede en el orden del documento (ya sea como hermano antes de su .card, o como primer
  // hijo dentro de la propia .card — ambos patrones se usan indistintamente en el dashboard),
  // para usarlo como nombre de hoja y de archivo sin anotar manualmente cada tabla.
  function tablaTitulo(table) {
    const titulos = document.querySelectorAll('#app .section-title');
    let mejor = null;
    titulos.forEach((t) => {
      if (t.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING) mejor = t;
    });
    if (mejor) return mejor.textContent.trim();
    const vista = table.closest('.view');
    if (vista && vista.id) return vista.id.replace('view-', 'Vista ');
    return 'Tabla';
  }

  function sanitizeArchivo(s) {
    return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Tabla';
  }

  function sanitizeHoja(s) {
    const limpio = s.replace(/[[\]:*?/\\]/g, ' ').trim();
    return limpio.slice(0, 31) || 'Tabla';
  }

  // Exporta una tabla ya renderizada en el DOM (thead/tbody) a un .xlsx real, leyendo el texto
  // tal como se ve en pantalla (con $, UF, US$, %, MM y flechas ▲▼ incluidos), reutilizando la
  // infraestructura de generarExcelHistorico() — sin librerías externas, respetando la CSP.
  // Calcula un ancho de columna "autofit" (en unidades de caracteres de Excel) a partir del
  // texto más largo entre el encabezado y todos los datos de esa columna, con un mínimo y un
  // máximo razonables para que ni las columnas cortas queden angostas ni las de nombres largos
  // (p. ej. "Nombre comercial") se disparen sin control.
  function calcularAnchosColumnas(headers, rows) {
    const anchos = {};
    headers.forEach((h, ci) => {
      let max = (h || '').length;
      rows.forEach((r) => {
        const len = (r[ci] || '').length;
        if (len > max) max = len;
      });
      anchos[ci] = Math.min(Math.max(max + 3, 11), 42);
    });
    return anchos;
  }

  function exportarTablaDom(table) {
    const headers = Array.from(table.querySelectorAll('thead th')).map((th) => th.textContent.trim());
    const rows = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
      Array.from(tr.children).map((td) => td.textContent.trim())
    );
    const titulo = tablaTitulo(table);
    const colWidths = calcularAnchosColumnas(headers, rows);
    const xlsx = buildXlsxWorkbook([{ name: sanitizeHoja(titulo), headers, rows, numericCols: new Set(), colWidths }]);
    descargarArchivo(`SCJ_${sanitizeArchivo(titulo)}_${new Date().toISOString().slice(0, 10)}.xlsx`, xlsx, XLSX_MIME);
  }

  // Inserta (si falta) un botón "Descargar Excel" justo antes de cada tabla visible, anclado
  // antes del contenedor .table-scroll cuando existe (para que no quede atrapado dentro del
  // área con scroll horizontal). Se apoya en un MutationObserver porque varias tablas —el
  // comparador de Resumen Mensual entre ellas— se reconstruyen fuera de renderCurrentView()
  // mediante handlers 'onchange' directos, así que un solo punto de enganche no bastaría.
  function ensureTableExportButtons() {
    document.querySelectorAll('#app table.data-table').forEach((table) => {
      const anclaje = table.closest('.table-scroll') || table;
      const prev = anclaje.previousElementSibling;
      if (prev && prev.classList.contains('table-export-btn')) return;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'table-export-btn';
      btn.textContent = '⬇ Excel';
      btn.title = 'Descargar esta tabla como Excel';
      btn.addEventListener('click', () => exportarTablaDom(table));
      anclaje.parentNode.insertBefore(btn, anclaje);
    });
  }

  function setupTableExportButtons() {
    ensureTableExportButtons();
    const app = document.getElementById('app');
    const observer = new MutationObserver(() => ensureTableExportButtons());
    observer.observe(app, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------
  // Vista: Administración (carga manual de datos)
  // ---------------------------------------------------------------------

  function generarPlantillaExcel() {
    const info = latestYearInfo();
    let nextYear = info.year, nextMonth = info.meses + 1;
    if (nextMonth > 12) { nextMonth = 1; nextYear += 1; }
    const headers = ['Casino', 'Holding (referencial, no editar)', 'Año', 'Mes', 'Visitas', 'Ingresos Brutos (CLP nominal, sin puntos ni decimales)'];
    const rows = CASINOS.map((c) => [c.Casino, c.Holding, nextYear, nextMonth, '', '']);
    const xlsx = buildXlsxWorkbook([{ name: 'Plantilla', headers, rows, numericCols: new Set() }]);
    descargarArchivo(`SCJ_plantilla_actualizacion_${nextYear}-${String(nextMonth).padStart(2, '0')}.xlsx`, xlsx, XLSX_MIME);
  }

  // --- Lectura de archivos subidos: .xlsx nativo (ZIP) y, como respaldo, el
  // formato SpreadsheetML .xml usado por versiones anteriores de la plantilla. ---

  function parseSpreadsheetML(text) {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('El archivo no tiene un formato Excel reconocible. Descargue la plantilla nuevamente y evite cambiar el tipo de archivo al guardar.');
    }
    const rowEls = doc.getElementsByTagName('Row');
    const rows = [];
    for (let i = 0; i < rowEls.length; i++) {
      const cellEls = rowEls[i].getElementsByTagName('Cell');
      const row = [];
      let col = 0;
      for (let j = 0; j < cellEls.length; j++) {
        const cell = cellEls[j];
        const idxAttr = cell.getAttribute('ss:Index');
        if (idxAttr) col = Number(idxAttr) - 1;
        const dataEls = cell.getElementsByTagName('Data');
        row[col] = dataEls.length ? dataEls[0].textContent : '';
        col++;
      }
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c !== undefined && String(c).trim() !== ''));
  }

  function xlsxColToIndex(letters) {
    let n = 0;
    for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
    return n - 1;
  }

  // Lee el directorio central del ZIP (más confiable que las cabeceras locales).
  function zipListEntries(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const maxBack = Math.min(buf.length, 65557);
    let eocdOff = -1;
    for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocdOff = i; break; }
    }
    if (eocdOff < 0) throw new Error('El archivo .xlsx no es válido (no se encontró el índice del ZIP).');
    const totalEntries = dv.getUint16(eocdOff + 10, true);
    const centralOffset = dv.getUint32(eocdOff + 16, true);
    const entries = [];
    let off = centralOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) throw new Error('El archivo .xlsx no es válido (directorio central corrupto).');
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOffset = dv.getUint32(off + 42, true);
      const name = new TextDecoder('utf-8').decode(buf.subarray(off + 46, off + 46 + nameLen));
      entries.push({ name, method, compSize, localOffset });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function zipExtractEntry(buf, entry) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const lo = entry.localOffset;
    if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error('El archivo .xlsx no es válido (encabezado local corrupto).');
    const nameLen = dv.getUint16(lo + 26, true);
    const extraLen = dv.getUint16(lo + 28, true);
    const dataStart = lo + 30 + nameLen + extraLen;
    const compressed = buf.subarray(dataStart, dataStart + entry.compSize);
    if (entry.method === 0) return compressed;
    if (entry.method === 8) {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('Este navegador no puede leer archivos .xlsx comprimidos. Actualice a una versión reciente de Chrome, Edge o Safari.');
      }
      const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    throw new Error('El archivo .xlsx usa un método de compresión no soportado.');
  }

  function parseSharedStrings(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    return Array.from(doc.getElementsByTagName('si')).map((si) => {
      const tNodes = si.getElementsByTagName('t');
      let text = '';
      for (let i = 0; i < tNodes.length; i++) text += tNodes[i].textContent;
      return text;
    });
  }

  function parseXlsxSheetXml(xmlText, sharedStrings) {
    const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
    if (doc.getElementsByTagName('parsererror').length) {
      throw new Error('El archivo .xlsx no tiene un formato reconocible.');
    }
    const rowEls = doc.getElementsByTagName('row');
    const rows = [];
    for (let i = 0; i < rowEls.length; i++) {
      const cellEls = rowEls[i].getElementsByTagName('c');
      const row = [];
      for (let j = 0; j < cellEls.length; j++) {
        const cell = cellEls[j];
        const ref = cell.getAttribute('r') || '';
        const m = ref.match(/^([A-Z]+)(\d+)$/);
        const colIdx = m ? xlsxColToIndex(m[1]) : j;
        const type = cell.getAttribute('t');
        let value = '';
        if (type === 's') {
          const vNode = cell.getElementsByTagName('v')[0];
          const idx = vNode ? Number(vNode.textContent) : -1;
          value = sharedStrings[idx] !== undefined ? sharedStrings[idx] : '';
        } else if (type === 'inlineStr') {
          const tNodes = cell.getElementsByTagName('t');
          value = tNodes.length ? tNodes[0].textContent : '';
        } else {
          const vNode = cell.getElementsByTagName('v')[0];
          value = vNode ? vNode.textContent : '';
        }
        row[colIdx] = value;
      }
      rows.push(row);
    }
    return rows.filter((r) => r.some((c) => c !== undefined && String(c).trim() !== ''));
  }

  async function parseXlsxRows(buf) {
    const entries = zipListEntries(buf);
    const sheetEntry = entries
      .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
      .sort((a, b) => Number(a.name.match(/sheet(\d+)\.xml/)[1]) - Number(b.name.match(/sheet(\d+)\.xml/)[1]))[0];
    if (!sheetEntry) throw new Error('El archivo .xlsx no contiene hojas reconocibles.');
    const decoder = new TextDecoder('utf-8');
    const sharedEntry = entries.find((e) => e.name === 'xl/sharedStrings.xml');
    let sharedStrings = [];
    if (sharedEntry) sharedStrings = parseSharedStrings(decoder.decode(await zipExtractEntry(buf, sharedEntry)));
    return parseXlsxSheetXml(decoder.decode(await zipExtractEntry(buf, sheetEntry)), sharedStrings);
  }

  function colIndex(header, name) {
    return header.findIndex((h) => String(h).trim().toLowerCase().startsWith(name.toLowerCase()));
  }

  function procesarArchivoAdmin(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const buf = new Uint8Array(reader.result);
        // Firma "PK" = archivo ZIP (.xlsx nativo); si no, se intenta el formato .xml heredado.
        const esZip = buf.length >= 2 && buf[0] === 0x50 && buf[1] === 0x4B;
        const rows = esZip ? await parseXlsxRows(buf) : parseSpreadsheetML(new TextDecoder('utf-8').decode(buf));
        if (!rows.length) throw new Error('El archivo está vacío.');
        const header = rows[0];
        const idxCasino = colIndex(header, 'Casino');
        const idxAnio = colIndex(header, 'Año');
        const idxMes = colIndex(header, 'Mes');
        const idxVis = colIndex(header, 'Visitas');
        const idxWin = colIndex(header, 'Ingresos Brutos');
        if (idxCasino < 0 || idxAnio < 0 || idxMes < 0) {
          throw new Error('El archivo no tiene el formato esperado (deben existir columnas Casino, Año y Mes).');
        }
        const nuevos = [];
        const errores = [];
        rows.slice(1).forEach((r, i) => {
          const casino = (r[idxCasino] || '').trim();
          if (!casino) return;
          if (!CASINO_INDEX[casino]) { errores.push(`Fila ${i + 2}: casino "${casino}" no reconocido.`); return; }
          const anio = Number(r[idxAnio]);
          const mes = Number(r[idxMes]);
          if (!anio || !mes || mes < 1 || mes > 12) { errores.push(`Fila ${i + 2}: Año/Mes inválido.`); return; }
          const visRaw = idxVis >= 0 ? String(r[idxVis]).trim() : '';
          const winRaw = idxWin >= 0 ? String(r[idxWin]).trim() : '';
          if (visRaw !== '') {
            const v = Number(visRaw);
            if (isNaN(v)) errores.push(`Fila ${i + 2}: Visitas no numérico.`);
            else nuevos.push({ Casino: casino, 'Año': anio, Mes: mes, Indicador: 'Visitas', Valor: v });
          }
          if (winRaw !== '') {
            const v = Number(winRaw);
            if (isNaN(v)) errores.push(`Fila ${i + 2}: Ingresos Brutos no numérico.`);
            else nuevos.push({ Casino: casino, 'Año': anio, Mes: mes, Indicador: 'Win Total', Valor: v });
          }
        });
        if (!nuevos.length) {
          throw new Error('No se encontraron filas con datos numéricos válidos para cargar.' + (errores.length ? ' ' + errores.slice(0, 5).join(' ') : ''));
        }
        aplicarRegistrosAdmin(nuevos);
        mostrarEstadoAdmin('ok', `Se actualizaron ${nuevos.length} registro(s) de ${new Set(nuevos.map((r) => r.Casino)).size} casino(s).` + (errores.length ? ` Se omitieron ${errores.length} fila(s) con errores: ${errores.slice(0, 5).join(' ')}` : ''));
      } catch (e) {
        mostrarEstadoAdmin('error', e.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }

  function aplicarRegistrosAdmin(records) {
    records.forEach((r) => aplicarRegistroEnArbol(r));
    const yearSet = new Set(YEARS);
    records.forEach((r) => yearSet.add(r['Año']));
    YEARS = Array.from(yearSet).sort((a, b) => a - b);
    guardarOverrideAdmin(records);
    setupYearSelectors();
    renderCurrentView();
  }

  function mostrarEstadoAdmin(tipo, mensaje) {
    if (tipo === 'ok') renderAdmin();
    const el = document.getElementById('status-admin');
    if (!el) return;
    el.className = 'status-line ' + (tipo === 'ok' ? 'ok' : 'error');
    el.textContent = mensaje;
  }

  function renderAdmin() {
    const el = document.getElementById('view-admin');
    if (!el) return;
    const overrideInfo = infoOverrideAdmin();
    const hayCargas = overrideInfo && overrideInfo.records && overrideInfo.records.length;
    el.innerHTML = `
      <div class="section-title" style="justify-content:space-between;">
        <span>Administración — Actualización de datos</span>
        <button class="btn btn-secondary" id="btn-salir-admin" type="button">Salir</button>
      </div>
      <div class="section-sub">Acceso restringido · los cambios cargados aquí quedan guardados en este navegador y actualizan el dashboard de inmediato.</div>
      <div class="card">
        <div class="section-title" style="margin-top:0;">1. Descargar plantilla</div>
        <p class="small muted" style="margin-top:0;">Plantilla en Excel con todos los casinos vigentes y el próximo período pendiente de carga. Complete las columnas <strong>Visitas</strong> e <strong>Ingresos Brutos</strong> (pesos nominales, sin puntos de miles ni decimales), guarde el archivo sin cambiar su formato y súbalo en el paso siguiente.</p>
        <button class="btn" id="btn-descargar-plantilla">Descargar plantilla (Excel)</button>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0;">2. Subir datos actualizados</div>
        <p class="small muted" style="margin-top:0;">Seleccione el archivo Excel completado. Las filas se validan por nombre de casino; los períodos ya existentes se sobrescriben y los nuevos se agregan al dashboard.</p>
        <input type="file" id="input-archivo-admin" accept=".xlsx,.xml,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/xml,text/xml,application/vnd.ms-excel">
        <div class="status-line" id="status-admin"></div>
      </div>
      <div class="card">
        <div class="section-title" style="margin-top:0;">Estado de los datos</div>
        ${hayCargas
          ? `<p class="status-line ok" style="margin-top:0;">Hay ${overrideInfo.records.length} registro(s) cargados manualmente en este navegador · última carga: ${new Date(overrideInfo.timestamp).toLocaleString('es-CL')}.</p>
             <button class="btn btn-secondary" id="btn-restablecer-admin">Restablecer datos originales del informe</button>`
          : '<p class="small muted" style="margin-top:0;">No hay cargas manuales activas; el dashboard muestra los datos base del informe SCJ.</p>'}
        <p class="small muted" style="margin-top:14px; margin-bottom:0;">Nota: esta carga actualiza los datos únicamente en este navegador. Para actualizar el dashboard para todos los usuarios del sitio, reemplace <code>data/scj_data.json</code> con los nuevos datos y vuelva a publicar en Netlify.</p>
      </div>
    `;
    document.getElementById('btn-descargar-plantilla').addEventListener('click', generarPlantillaExcel);
    document.getElementById('input-archivo-admin').addEventListener('change', (ev) => {
      const file = ev.target.files[0];
      if (file) procesarArchivoAdmin(file);
      ev.target.value = '';
    });
    const btnReset = document.getElementById('btn-restablecer-admin');
    if (btnReset) {
      btnReset.addEventListener('click', () => {
        if (!confirm('¿Restablecer los datos originales del informe? Se perderán las cargas manuales guardadas en este navegador.')) return;
        limpiarOverrideAdmin();
        location.reload();
      });
    }
    document.getElementById('btn-salir-admin').addEventListener('click', salirAdmin);
  }

  function salirAdmin() {
    admAuth = false;
    const tab = document.getElementById('tab-admin');
    tab.style.display = 'none';
    document.querySelector('.tab-btn[data-view="resumen"]').click();
  }

  function setupAdmin() {
    document.getElementById('btn-adm').addEventListener('click', () => {
      const tab = document.getElementById('tab-admin');
      if (admAuth) { tab.click(); return; }
      const clave = window.prompt('Ingrese la clave de administrador:');
      if (clave === null) return;
      if (clave !== ADM_PASSWORD) { alert('Clave incorrecta.'); return; }
      admAuth = true;
      tab.style.display = '';
      tab.click();
    });
  }

  const MONTHS_ES_FULL = [
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
    'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
  ];
  function fmtFechaLarga(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y || !m || !d) return iso;
    return `${d} de ${MONTHS_ES_FULL[m - 1]} de ${y}`;
  }
  function ultimoPeriodoConDatos() {
    // Último Año/Mes con Win Total efectivamente informado (no proyectado), para mostrar
    // "información disponible hasta <mes> de <año>" junto a la fecha de verificación.
    if (!RAW || !Array.isArray(RAW.records)) return null;
    let mejor = null;
    for (const r of RAW.records) {
      if (r.Indicador !== 'Win Total' || r.Valor == null) continue;
      if (!mejor || r.Año > mejor.Año || (r.Año === mejor.Año && r.Mes > mejor.Mes)) {
        mejor = { Año: r.Año, Mes: r.Mes };
      }
    }
    return mejor;
  }
  function renderFooterActualizacion() {
    const el = document.getElementById('footer-actualizacion');
    if (!el || !RAW) return;
    // last_checked = última vez que se verificó scj.cl en busca de boletines nuevos (la ponga
    // update_from_boletin.py en cada corrida). generated_at es un respaldo para datos antiguos
    // que aún no tengan ese campo.
    const fechaVerificacion = RAW.last_checked || RAW.generated_at;
    if (!fechaVerificacion) return;
    let texto = `· Última actualización de datos: ${fmtFechaLarga(fechaVerificacion)}`;
    const periodo = ultimoPeriodoConDatos();
    if (periodo) {
      texto += ` (información disponible hasta ${MONTHS_ES_FULL[periodo.Mes - 1]} de ${periodo.Año})`;
    }
    el.textContent = texto;
  }

  async function init() {
    try {
      await loadData();
      renderFooterActualizacion();
      aplicarCacheIndicadores();
      setupYearSelectors();
      setupTrendFromSelector();
      setupTabs();
      setupValueToggle();
      setupPandemiaToggle();
      setupExportExcel();
      setupAdmin();
      renderResumen();
      actualizarIndicadores();
      setupTableExportButtons();
    } catch (e) {
      document.getElementById('app').innerHTML = `<div class="card"><strong>Error al cargar datos:</strong> ${e.message}</div>`;
      console.error(e);
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
