import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdbWasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbWasmEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import ehWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

const COLORS = { early: '#16785b', late: '#d9694b', accent: '#d7ee54', ink: '#19221d', muted: '#66736c' };
const metrics = {
  Productivity_Score: { label: 'Produtividade', short: 'Produtividade' },
  Energy_Level_Score: { label: 'Nível de energia', short: 'Energia' },
  Health_Score: { label: 'Saúde geral', short: 'Saúde' },
  Mood_Score: { label: 'Humor', short: 'Humor' },
  Stress_Level: { label: 'Nível de estresse', short: 'Estresse' }
};

// Um único estado mantém as visões coordenadas e evita filtros divergentes no DOM.
const state = { metric: 'Productivity_Score', group: 'Todos', country: null };
let connection;
const tooltip = d3.select('#tooltip');

function rows(result) {
  return result.toArray().map(row => row.toJSON()).map(row =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]))
  );
}

function filterSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  const clauses = [];
  if (state.group !== 'Todos') clauses.push(`${prefix}Early_Waker = '${state.group}'`);
  if (state.country) clauses.push(`${prefix}Country = '${state.country.replaceAll("'", "''")}'`);
  return clauses.length ? ` AND ${clauses.join(' AND ')}` : '';
}

function svgFrame(selector, height, margin) {
  const node = document.querySelector(selector);
  const width = Math.max(node.clientWidth, 320);
  d3.select(selector).selectAll('*').remove();
  const svg = d3.select(selector).append('svg').attr('viewBox', `0 0 ${width} ${height}`);
  return { svg, g: svg.append('g').attr('transform', `translate(${margin.left},${margin.top})`), width, innerWidth: width - margin.left - margin.right, innerHeight: height - margin.top - margin.bottom };
}

function showTooltip(event, html) {
  tooltip.style('display', 'block').html(html);
  const box = tooltip.node().getBoundingClientRect();
  const left = Math.min(event.clientX + 14, window.innerWidth - box.width - 12);
  const top = Math.min(event.clientY + 14, window.innerHeight - box.height - 12);
  tooltip.style('left', `${left}px`).style('top', `${top}px`);
}
function hideTooltip() { tooltip.style('display', 'none'); }
function fmt(value, digits = 1) { return d3.format(`.${digits}f`)(value); }

async function initEngine() {
  const bundles = {
    mvp: { mainModule: duckdbWasm, mainWorker: mvpWorker },
    eh: { mainModule: duckdbWasmEh, mainWorker: ehWorker }
  };
  const bundle = await duckdb.selectBundle(bundles);
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), new Worker(bundle.mainWorker));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  connection = await db.connect();
  const csv = await (await fetch('/early_wakeup_health_dataset.csv')).text();
  await db.registerFileText('dataset.csv', csv);

  // O DuckDB faz tipagem, derivação temporal e amostragem antes de qualquer desenho em D3.
  await connection.query(`
    CREATE TABLE health_data AS
    SELECT *,
      EXTRACT(HOUR FROM Wake_Up_Time) + EXTRACT(MINUTE FROM Wake_Up_Time) / 60.0 AS Wake_Hour
    FROM read_csv_auto('dataset.csv', header = true)
  `);

  bindControls();
  await renderAll();
  d3.select('#loading').remove();
}

function bindControls() {
  d3.selectAll('.filter-chip').on('click', async function () {
    state.group = this.dataset.group;
    d3.selectAll('.filter-chip').classed('active', false);
    d3.select(this).classed('active', true);
    await renderDetails();
  });
  d3.select('#clear-country').on('click', async () => {
    state.country = null;
    updateCountryButton();
    await renderDetails();
  });
  let timer;
  window.addEventListener('resize', () => {
    clearTimeout(timer);
    timer = setTimeout(renderAll, 180);
  });
}

function updateCountryButton() {
  d3.select('#clear-country').property('disabled', !state.country).text(state.country ? `× ${state.country}` : 'Todos os países');
}

async function updateSampleCount() {
  const [count] = rows(await connection.query(`SELECT COUNT(*) AS n FROM health_data WHERE 1=1 ${filterSql()}`));
  d3.select('#sample-count').text(`${d3.format(',')(count.n).replace(',', '.')} pessoas na seleção`);
}

async function renderAll() {
  await renderMetricBars();
  await renderDetails();
}

async function renderDetails() {
  updateCountryButton();
  await updateSampleCount();
  await Promise.all([renderTrend(), renderCountries(), renderHeatmap(), renderScatter()]);
}

// Overview: a comparação Early-Late permanece global para funcionar como seletor de métrica.
async function renderMetricBars() {
  const query = Object.keys(metrics).map(metric => `
    SELECT '${metric}' AS metric,
      (avg_early - avg_late) /
      SQRT(((n_early - 1) * sd_early * sd_early + (n_late - 1) * sd_late * sd_late) /
        (n_early + n_late - 2)) AS difference
    FROM (
      SELECT
        AVG(CASE WHEN Early_Waker = 'Yes' THEN ${metric} END) AS avg_early,
        AVG(CASE WHEN Early_Waker = 'No' THEN ${metric} END) AS avg_late,
        STDDEV_SAMP(CASE WHEN Early_Waker = 'Yes' THEN ${metric} END) AS sd_early,
        STDDEV_SAMP(CASE WHEN Early_Waker = 'No' THEN ${metric} END) AS sd_late,
        COUNT(CASE WHEN Early_Waker = 'Yes' THEN 1 END) AS n_early,
        COUNT(CASE WHEN Early_Waker = 'No' THEN 1 END) AS n_late
      FROM health_data
    ) AS stats
  `).join(' UNION ALL ');
  const data = rows(await connection.query(query)).sort((a, b) => b.difference - a.difference);
  const margin = { top: 30, right: 28, bottom: 52, left: 96 };
  const { g, innerWidth, innerHeight } = svgFrame('#bar-chart', 340, margin);
  const extent = d3.max(data, d => Math.abs(d.difference)) || 1;
  const x = d3.scaleLinear().domain([-extent, extent]).nice().range([0, innerWidth]);
  const y = d3.scaleBand().domain(data.map(d => metrics[d.metric].short)).range([0, innerHeight]).padding(.38);

  g.append('g').attr('class', 'axis grid').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x).ticks(5).tickSize(-innerHeight).tickFormat(d3.format('+.1f')));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).tickSize(0)).call(group => group.select('.domain').remove());
  g.append('text').attr('class', 'axis-label').attr('x', innerWidth / 2).attr('y', innerHeight + 43).attr('text-anchor', 'middle').text('Efeito padronizado (desvios-padrão)');
  g.append('line').attr('x1', x(0)).attr('x2', x(0)).attr('y2', innerHeight).attr('stroke', COLORS.ink).attr('stroke-width', 1.2);

  g.selectAll('.bar').data(data).join('rect')
    .attr('class', 'bar').attr('x', d => Math.min(x(0), x(d.difference))).attr('y', d => y(metrics[d.metric].short))
    .attr('width', d => Math.max(2, Math.abs(x(d.difference) - x(0)))).attr('height', y.bandwidth()).attr('rx', 3)
    .attr('fill', d => d.difference >= 0 ? COLORS.early : COLORS.late).attr('opacity', d => d.metric === state.metric ? 1 : .35)
    .style('cursor', 'pointer')
    .on('mousemove', (event, d) => showTooltip(event, `<strong>${metrics[d.metric].label}</strong>Efeito padronizado: ${d3.format('+.2f')(d.difference)} desvios-padrão`))
    .on('mouseleave', hideTooltip)
    .on('click', async (_, d) => { state.metric = d.metric; await renderAll(); });
}

async function renderTrend() {
  const data = rows(await connection.query(`
    SELECT FLOOR(Wake_Hour * 2) / 2 AS hour_bin, AVG(${state.metric}) AS average,
      1.96 * STDDEV_SAMP(${state.metric}) / SQRT(COUNT(*)) AS ci, COUNT(*) AS n
    FROM health_data WHERE ${state.metric} IS NOT NULL AND Wake_Hour BETWEEN 4 AND 11 ${filterSql()}
    GROUP BY 1 HAVING COUNT(*) >= 12 ORDER BY 1
  `));
  d3.select('#trend-title').text(`${metrics[state.metric].label} ao longo da manhã`);
  const margin = { top: 18, right: 24, bottom: 52, left: 64 };
  const { g, innerWidth, innerHeight } = svgFrame('#trend-chart', 350, margin);
  if (!data.length) return g.append('text').attr('class', 'empty-state').text('Sem dados suficientes para esta seleção.');
  
  const x = d3.scaleLinear().domain([4, 11]).range([0, innerWidth]);
  const y = d3.scaleLinear().domain(d3.extent(data.flatMap(d => [d.average - d.ci, d.average + d.ci]))).nice().range([innerHeight, 0]);
  
  g.append('g').attr('class', 'axis grid').call(d3.axisLeft(y).ticks(5).tickSize(-innerWidth));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x).ticks(7).tickFormat(d => `${d}h`));
  g.append('text').attr('class', 'axis-label').attr('x', innerWidth / 2).attr('y', innerHeight + 43).attr('text-anchor', 'middle').text('Horário de acordar');
  g.append('text').attr('class', 'axis-label').attr('transform', 'rotate(-90)').attr('x', -innerHeight / 2).attr('y', -48).attr('text-anchor', 'middle').text(metrics[state.metric].label);
  
  // --- LINHA DE THRESHOLD (06:30 = 6.5) ---
  g.append('line')
    .attr('x1', x(6.5)).attr('x2', x(6.5))
    .attr('y1', 0).attr('y2', innerHeight)
    .attr('stroke', COLORS.ink)
    .attr('stroke-width', 1.5)
    .attr('stroke-dasharray', '5,4')
    .attr('opacity', 0.7);
    
  g.append('text')
    .attr('x', x(6.5) + 6)
    .attr('y', 12)
    .attr('fill', COLORS.ink)
    .attr('font-size', 10)
    .attr('font-weight', 'bold')
    .text('06:30 (Threshold)');

  const curve = d3.curveMonotoneX;
  g.append('path').datum(data).attr('fill', '#bfe3d4').attr('d', d3.area().x(d => x(d.hour_bin)).y0(d => y(d.average - d.ci)).y1(d => y(d.average + d.ci)).curve(curve));
  g.append('path').datum(data).attr('fill', 'none').attr('stroke', COLORS.early).attr('stroke-width', 3).attr('d', d3.line().x(d => x(d.hour_bin)).y(d => y(d.average)).curve(curve));
  g.selectAll('circle').data(data).join('circle').attr('cx', d => x(d.hour_bin)).attr('cy', d => y(d.average)).attr('r', 4).attr('fill', COLORS.early)
    .on('mousemove', (event, d) => showTooltip(event, `<strong>${d.hour_bin.toFixed(1).replace('.5', 'h30').replace('.0', 'h')}</strong>Média: ${fmt(d.average, 2)}<br>IC 95%: ±${fmt(d.ci, 2)}<br>${d.n} pessoas`)).on('mouseleave', hideTooltip);
}

async function renderCountries() {
  const data = rows(await connection.query(`
    SELECT Country AS country, AVG(${state.metric}) AS average, COUNT(*) AS n
    FROM health_data WHERE ${state.metric} IS NOT NULL ${state.group !== 'Todos' ? `AND Early_Waker = '${state.group}'` : ''}
    GROUP BY 1 HAVING COUNT(*) >= 20 ORDER BY average DESC
  `));
  const margin = { top: 10, right: 58, bottom: 52, left: 92 };
  const height = Math.max(330, data.length * 27 + margin.top + margin.bottom);
  const { g, innerWidth, innerHeight } = svgFrame('#country-chart', height, margin);
  const x = d3.scaleLinear().domain(d3.extent(data, d => d.average)).nice().range([0, innerWidth]);
  const y = d3.scaleBand().domain(data.map(d => d.country)).range([0, innerHeight]).padding(.34);
  g.append('g').attr('class', 'axis grid').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x).ticks(5).tickSize(-innerHeight));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).tickSize(0)).call(group => group.select('.domain').remove());
  g.append('text').attr('class', 'axis-label').attr('x', innerWidth / 2).attr('y', innerHeight + 43).attr('text-anchor', 'middle').text(`${metrics[state.metric].label} (média)`);
  g.append('text').attr('class', 'axis-label').attr('transform', 'rotate(-90)').attr('x', -innerHeight / 2).attr('y', -76).attr('text-anchor', 'middle').text('País');
  const groups = g.selectAll('.country-row').data(data).join('g').attr('class', 'country-row').style('cursor', 'pointer')
    .attr('opacity', d => !state.country || state.country === d.country ? 1 : .28)
    .on('mousemove', (event, d) => showTooltip(event, `<strong>${d.country}</strong>${metrics[state.metric].label}: ${fmt(d.average, 2)}<br>${d.n} pessoas`))
    .on('mouseleave', hideTooltip).on('click', async (_, d) => { state.country = state.country === d.country ? null : d.country; await renderDetails(); });
  groups.append('line').attr('x1', 0).attr('x2', d => x(d.average)).attr('y1', d => y(d.country) + y.bandwidth() / 2).attr('y2', d => y(d.country) + y.bandwidth() / 2).attr('stroke', '#b9c1ba').attr('stroke-width', 2);
  groups.append('circle').attr('cx', d => x(d.average)).attr('cy', d => y(d.country) + y.bandwidth() / 2).attr('r', 6).attr('fill', d => state.country === d.country ? COLORS.accent : COLORS.early).attr('stroke', COLORS.ink).attr('stroke-width', .7);
  groups.append('text').attr('x', d => x(d.average) + 10).attr('y', d => y(d.country) + y.bandwidth() / 2 + 4).attr('fill', COLORS.muted).attr('font-size', 11).text(d => fmt(d.average, 2));
}

async function renderHeatmap() {
  const data = rows(await connection.query(`
    SELECT FLOOR(Wake_Hour * 2) / 2 AS wake_bin, FLOOR(Sleep_Duration_Hours) AS sleep_bin,
      AVG(${state.metric}) AS average, COUNT(*) AS n
    FROM health_data WHERE Wake_Hour BETWEEN 4 AND 11 AND Sleep_Duration_Hours BETWEEN 3 AND 10 ${filterSql()}
    GROUP BY 1, 2 HAVING COUNT(*) >= 8 ORDER BY 1, 2
  `));
  const margin = { top: 18, right: 20, bottom: 55, left: 66 };
  const { svg, g, innerWidth, innerHeight } = svgFrame('#heatmap-chart', 350, margin);
  if (!data.length) return g.append('text').attr('class', 'empty-state').text('Sem dados suficientes para esta seleção.');
  
  const wakeBins = d3.range(4, 11, .5);
  const sleepBins = d3.range(3, 10);
  const x = d3.scaleBand().domain(wakeBins).range([0, innerWidth]).padding(.07);
  const y = d3.scaleBand().domain(sleepBins).range([innerHeight, 0]).padding(.07);
  const domain = d3.extent(data, d => d.average);
  const color = d3.scaleSequential(d3.interpolateYlGnBu).domain(domain);
  
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x).tickValues(wakeBins.filter((_, i) => i % 2 === 0)).tickFormat(d => `${d}h`));
  g.append('g').attr('class', 'axis').call(d3.axisLeft(y).tickFormat(d => `${d}–${d + 1}h`));
  g.append('text').attr('class', 'axis-label').attr('x', innerWidth / 2).attr('y', innerHeight + 46).attr('text-anchor', 'middle').text('Horário de acordar');
  g.append('text').attr('class', 'axis-label').attr('transform', 'rotate(-90)').attr('x', -innerHeight / 2).attr('y', -53).attr('text-anchor', 'middle').text('Duração do sono');
  
  g.selectAll('.cell').data(data).join('rect').attr('class', 'cell').attr('x', d => x(d.wake_bin)).attr('y', d => y(d.sleep_bin)).attr('width', x.bandwidth()).attr('height', y.bandwidth()).attr('rx', 2).attr('fill', d => color(d.average))
    .on('mousemove', (event, d) => showTooltip(event, `<strong>Acorda ${d.wake_bin.toFixed(1)}h · dorme ${d.sleep_bin}–${d.sleep_bin + 1}h</strong>${metrics[state.metric].label}: ${fmt(d.average, 2)}<br>${d.n} pessoas`)).on('mouseleave', hideTooltip);

  // --- LINHA DE THRESHOLD NO MAPA DE CALOR (06:30 = 6.5) ---
  const thresholdX = x(6.5);
  if (thresholdX !== undefined) {
    g.append('line')
      .attr('x1', thresholdX - (x.paddingInner() * x.step()) / 2) // Centraliza a linha entre os blocos
      .attr('x2', thresholdX - (x.paddingInner() * x.step()) / 2)
      .attr('y1', 0).attr('y2', innerHeight)
      .attr('stroke', COLORS.ink)
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', '5,4')
      .attr('opacity', 0.8)
      .attr('pointer-events', 'none'); // Evita que a linha interfira na interação dos blocos
    }

  const legendWidth = Math.min(130, innerWidth * .35);
  const gradientId = 'heat-gradient';
  const gradient = svg.append('defs').append('linearGradient').attr('id', gradientId);
  d3.range(0, 1.01, .1).forEach(t => gradient.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', d3.interpolateYlGnBu(t)));
  const legend = svg.append('g').attr('transform', `translate(${margin.left + innerWidth - legendWidth},5)`);
  legend.append('rect').attr('width', legendWidth).attr('height', 7).attr('fill', `url(#${gradientId})`);
  legend.append('text').attr('y', -3).attr('fill', COLORS.muted).attr('font-size', 9).text(`${fmt(domain[0])} → ${fmt(domain[1])}`);
}
async function renderScatter() {
  // Amostra determinística limita o custo de desenho, preservando toda a base para agregações.
  const data = rows(await connection.query(`
    SELECT Person_ID AS id, Age AS age, Gender AS gender, Country AS country, Occupation AS occupation,
      Wake_Hour AS wake_hour, Sleep_Duration_Hours AS sleep_duration, Sleep_Quality_Score AS sleep_quality,
      Early_Waker AS early_waker, ${state.metric} AS value
    FROM health_data WHERE ${state.metric} IS NOT NULL AND Sleep_Quality_Score IS NOT NULL ${filterSql()}
    ORDER BY hash(Person_ID) LIMIT 900
  `));
  const margin = { top: 16, right: 24, bottom: 50, left: 54 };
  const { g, innerWidth, innerHeight } = svgFrame('#scatter-chart', 390, margin);
  if (!data.length) return g.append('text').attr('class', 'empty-state').text('Sem pessoas para esta seleção.');
  const x = d3.scaleLinear().domain(d3.extent(data, d => d.sleep_quality)).nice().range([0, innerWidth]);
  const y = d3.scaleLinear().domain(d3.extent(data, d => d.value)).nice().range([innerHeight, 0]);
  g.append('g').attr('class', 'axis grid').call(d3.axisLeft(y).ticks(6).tickSize(-innerWidth));
  g.append('g').attr('class', 'axis').attr('transform', `translate(0,${innerHeight})`).call(d3.axisBottom(x));
  g.append('text').attr('class', 'axis-label').attr('x', innerWidth / 2).attr('y', innerHeight + 42).attr('text-anchor', 'middle').text('Qualidade do sono');
  g.append('text').attr('class', 'axis-label').attr('transform', 'rotate(-90)').attr('x', -innerHeight / 2).attr('y', -42).attr('text-anchor', 'middle').text(metrics[state.metric].label);

  // A tendência linear resume a direção da associação sem esconder a dispersão individual.
  const meanX = d3.mean(data, d => d.sleep_quality);
  const meanY = d3.mean(data, d => d.value);
  const covariance = d3.sum(data, d => (d.sleep_quality - meanX) * (d.value - meanY));
  const varianceX = d3.sum(data, d => (d.sleep_quality - meanX) ** 2);
  const varianceY = d3.sum(data, d => (d.value - meanY) ** 2);
  const slope = varianceX ? covariance / varianceX : 0;
  const correlation = varianceX && varianceY ? covariance / Math.sqrt(varianceX * varianceY) : 0;
  const [x0, x1] = x.domain();
  g.append('line')
    .attr('x1', x(x0)).attr('x2', x(x1))
    .attr('y1', y(meanY + slope * (x0 - meanX))).attr('y2', y(meanY + slope * (x1 - meanX)))
    .attr('stroke', COLORS.ink).attr('stroke-width', 2).attr('stroke-dasharray', '5,4').attr('opacity', .72);
  g.append('text').attr('x', innerWidth).attr('y', 5).attr('text-anchor', 'end')
    .attr('fill', COLORS.muted).attr('font-size', 11).attr('font-weight', 700)
    .text(`Correlação r = ${d3.format('+.2f')(correlation)}`);

  g.selectAll('.point').data(data).join('circle').attr('class', 'point').attr('cx', d => x(d.sleep_quality)).attr('cy', d => y(d.value)).attr('r', 3.3).attr('fill', d => d.early_waker === 'Yes' ? COLORS.early : COLORS.late).attr('fill-opacity', .38).attr('stroke', '#fff').attr('stroke-width', .3)
    .on('mouseenter', function (event, d) { d3.select(this).attr('r', 6).attr('fill-opacity', 1); showTooltip(event, `<strong>${d.id} · ${d.age} anos</strong>${d.gender}, ${d.occupation}<br>${d.country}<br>Acorda: ${fmt(d.wake_hour, 1)}h · Sono: ${fmt(d.sleep_duration, 1)}h<br>Qualidade: ${fmt(d.sleep_quality)} · ${metrics[state.metric].label}: ${fmt(d.value)}`); })
    .on('mousemove', (event, d) => showTooltip(event, `<strong>${d.id} · ${d.age} anos</strong>${d.gender}, ${d.occupation}<br>${d.country}<br>Acorda: ${fmt(d.wake_hour, 1)}h · Sono: ${fmt(d.sleep_duration, 1)}h<br>Qualidade: ${fmt(d.sleep_quality)} · ${metrics[state.metric].label}: ${fmt(d.value)}`))
    .on('mouseleave', function () { d3.select(this).attr('r', 3.3).attr('fill-opacity', .38); hideTooltip(); });
}

initEngine().catch(error => {
  console.error(error);
  d3.select('#loading').html('<strong>Não foi possível carregar os dados.</strong> Verifique o console do navegador.');
});
