import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// --- ESTADO GLOBAL E DICIONÁRIO DE MÉTRICAS ---
let globalDb = null;
let globalConn = null;
let selectedMetric = 'Productivity_Score'; // Métrica inicial

// Mapeamento amigável para a interface
const metricsMap = {
    'Productivity_Score': 'Produtividade',
    'Energy_Level_Score': 'Nível de Energia',
    'Health_Score': 'Saúde Geral',
    'Mood_Score': 'Humor',
    'Stress_Level': 'Nível de Estresse'
};

// Variáveis de referência do D3 para o gráfico de tendência (Visão 2)
let trendSvg, trendXScale, trendYScale, xAxisGroup, yAxisGroup, linePath, areaPath;
const trendMargin = { top: 30, right: 30, bottom: 50, left: 60 };
const trendWidth = 800 - trendMargin.left - trendMargin.right;
const trendHeight = 450 - trendMargin.top - trendMargin.bottom;

// --- INICIALIZAÇÃO DO MOTOR DE DADOS ---
async function initEngine() {
    const MANUAL_BUNDLES = {
        mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
        eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker }
    };
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    globalDb = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker);
    await globalDb.instantiate(bundle.mainModule, bundle.pthreadWorker);
    globalConn = await globalDb.connect();

    // Carrega e registra os dados
    const res = await fetch('/early_wakeup_health_dataset.csv');
    const text = await res.text();
    await globalDb.registerFileText('dataset.csv', text);
    
// Etapa 1: Transformação Limpa no Banco (Extração de Tempo Nativa)
    await globalConn.query(`
        CREATE TABLE health_data AS 
        SELECT 
            *,
            -- Derivação Elegante: Extrai a hora e o minuto nativamente do tipo TIME
            EXTRACT(HOUR FROM Wake_Up_Time) + 
            (EXTRACT(MINUTE FROM Wake_Up_Time) / 60.0) AS Wake_Hour
        FROM read_csv_auto('dataset.csv', header=true)
    `);
    // Inicia a renderização do Dashboard
    initTrendSVG();
    await renderDivergingBars();
    await updateTrendChart(selectedMetric);
}

// --- VISÃO 1: BARRAS DIVERGENTES (EFEITO E COMPARAÇÃO) ---
async function renderDivergingBars() {
    // Calcula o Effect Size (Diferença das médias: Early - Late) para cada métrica
    const queries = Object.keys(metricsMap).map(metric => `
        SELECT 
            '${metric}' AS metric_id,
            (SELECT AVG(${metric}) FROM health_data WHERE Early_Waker = 'Yes') - 
            (SELECT AVG(${metric}) FROM health_data WHERE Early_Waker = 'No') AS diff
    `);
    
    const result = await globalConn.query(queries.join(' UNION ALL '));
    const effectData = result.toArray().map(row => row.toJSON()).sort((a, b) => b.diff - a.diff);

    const container = d3.select("#bar-chart");
    const width = 350;
    const height = 450;
    const margin = { top: 40, right: 20, bottom: 20, left: 100 };

    const svg = container.append("svg").attr("width", width).attr("height", height);

    const xScale = d3.scaleLinear()
        .domain(d3.extent(effectData, d => d.diff)).nice()
        .range([margin.left, width - margin.right]);

    const yScale = d3.scaleBand()
        .domain(effectData.map(d => metricsMap[d.metric_id]))
        .range([margin.top, height - margin.bottom])
        .padding(0.3);

    // Eixo X centralizado (Linha Zero)
    svg.append("g")
        .attr("transform", `translate(0,${margin.top - 10})`)
        .call(d3.axisTop(xScale).ticks(5))
        .append("text")
        .attr("x", width/2)
        .attr("y", -25)
        .attr("fill", "#333")
        .style("text-anchor", "middle")
        .text("Vantagem (Early - Late)");

    svg.append("line")
        .attr("x1", xScale(0)).attr("x2", xScale(0))
        .attr("y1", margin.top).attr("y2", height - margin.bottom)
        .attr("stroke", "#333").attr("stroke-dasharray", "4,4");

    // Eixo Y (Rótulos das Métricas)
    svg.append("g")
        .attr("transform", `translate(${margin.left},0)`)
        .call(d3.axisLeft(yScale).tickSize(0))
        .select(".domain").remove();

    // Renderização das Barras e Interação de Controle de Estado
    svg.selectAll(".bar")
        .data(effectData)
        .join("rect")
        .attr("class", "bar")
        .attr("x", d => Math.min(xScale(0), xScale(d.diff)))
        .attr("y", d => yScale(metricsMap[d.metric_id]))
        .attr("width", d => Math.abs(xScale(d.diff) - xScale(0)))
        .attr("height", yScale.bandwidth())
        .attr("fill", d => d.diff > 0 ? "#2ecc71" : "#e74c3c")
        .attr("opacity", d => d.metric_id === selectedMetric ? 1 : 0.4)
        .style("cursor", "pointer")
        .on("click", async function(event, d) {
            // Atualiza estado e interface visual (Linked Views via click)
            selectedMetric = d.metric_id;
            svg.selectAll(".bar").attr("opacity", 0.4);
            d3.select(this).attr("opacity", 1);
            
            // Dispara recalculo no DuckDB e transição no D3
            await updateTrendChart(selectedMetric);
        });
}

// --- ESTRUTURA BASE DA VISÃO 2 (Criada apenas 1 vez) ---
function initTrendSVG() {
    const svgBase = d3.select("#trend-chart")
        .append("svg")
        .attr("width", trendWidth + trendMargin.left + trendMargin.right)
        .attr("height", trendHeight + trendMargin.top + trendMargin.bottom);
        
    trendSvg = svgBase.append("g")
        .attr("transform", `translate(${trendMargin.left},${trendMargin.top})`);

    // Escala X é fixa (Horas do dia de 4.0 a 11.0 baseado na exploração do dataset)
    trendXScale = d3.scaleLinear()
        .domain([4, 11])
        .range([0, trendWidth]);

    xAxisGroup = trendSvg.append("g")
        .attr("transform", `translate(0,${trendHeight})`)
        .call(d3.axisBottom(trendXScale).tickFormat(d => `${d}h`));

    trendSvg.append("text")
        .attr("x", trendWidth / 2)
        .attr("y", trendHeight + 40)
        .style("text-anchor", "middle")
        .attr("class", "axis-label")
        .text("Horário de Acordar (Wake Hour)");

    yAxisGroup = trendSvg.append("g");
    
    // Elementos que sofrerão mutação animada
    areaPath = trendSvg.append("path").attr("fill", "rgba(52, 152, 219, 0.2)");
    linePath = trendSvg.append("path").attr("fill", "none").attr("stroke", "#2980b9").attr("stroke-width", 3);
}

// --- VISÃO 2: ATUALIZAÇÃO REATIVA (Ação Exploratória) ---
async function updateTrendChart(metricId) {
    // SQL Analítico: Agrega por bins de 30 min e calcula média e desvio padrão
    const query = `
        SELECT 
            FLOOR(Wake_Hour * 2) / 2 AS bin_hour,
            AVG(${metricId}) AS avg_val,
            STDDEV_SAMP(${metricId}) AS std_val,
            COUNT(*) AS n_samples
        FROM health_data
        WHERE ${metricId} IS NOT NULL AND Wake_Hour BETWEEN 4 AND 11
        GROUP BY 1
        HAVING n_samples > 15 -- Filtra outliers/ruídos severos
        ORDER BY bin_hour
    `;
    
    const result = await globalConn.query(query);
    const trendData = result.toArray().map(row => row.toJSON());

    // Atualiza Escala Y baseada nos limites do Desvio Padrão
    const yMin = d3.min(trendData, d => d.avg_val - (d.std_val || 0));
    const yMax = d3.max(trendData, d => d.avg_val + (d.std_val || 0));
    
    trendYScale = d3.scaleLinear()
        .domain([yMin * 0.95, yMax * 1.05])
        .range([trendHeight, 0]);

    // Anima o Eixo Y
    yAxisGroup.transition().duration(750).call(d3.axisLeft(trendYScale));

    // Geradores de Geometria (Mapping de atributos visuais)
    const lineGenerator = d3.line()
        .x(d => trendXScale(d.bin_hour))
        .y(d => trendYScale(d.avg_val))
        .curve(d3.curveMonotoneX); // Suaviza a linha

    const areaGenerator = d3.area()
        .x(d => trendXScale(d.bin_hour))
        .y0(d => trendYScale(d.avg_val - (d.std_val || 0)))
        .y1(d => trendYScale(d.avg_val + (d.std_val || 0)))
        .curve(d3.curveMonotoneX);

    // Aplica as transições (A animação reduz a "cegueira à mudança" do usuário)
    linePath.datum(trendData)
        .transition().duration(750)
        .attr("d", lineGenerator);

    areaPath.datum(trendData)
        .transition().duration(750)
        .attr("d", areaGenerator);
}

// Inicializa a engine e a interface
initEngine();