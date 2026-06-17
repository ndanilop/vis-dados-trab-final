import * as d3 from 'd3';
import * as duckdb from '@duckdb/duckdb-wasm';
import duckdb_wasm from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import mvp_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdb_wasm_eh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import eh_worker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';

// 1. Configurações do D3
const margin = { top: 40, right: 40, bottom: 60, left: 60 };
const width = 800 - margin.left - margin.right;
const height = 500 - margin.top - margin.bottom;

const svg = d3.select("#viz-container")
    .append("svg")
    .attr("width", width + margin.left + margin.right)
    .attr("height", height + margin.top + margin.bottom)
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top})`);

const tooltip = d3.select("#tooltip");

// 2. Inicialização do DuckDB
async function initDuckDB() {
    const MANUAL_BUNDLES = {
        mvp: { mainModule: duckdb_wasm, mainWorker: mvp_worker },
        eh: { mainModule: duckdb_wasm_eh, mainWorker: eh_worker }
    };
    const bundle = await duckdb.selectBundle(MANUAL_BUNDLES);
    const worker = new Worker(bundle.mainWorker);
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    return db;
}

// 3. Pipeline de Dados e Visualização
async function renderChart() {
    const db = await initDuckDB();
    const conn = await db.connect();

    // Chamada de rede
    const res = await fetch('/early_wakeup_health_dataset.csv');
    const text = await res.text();
    
    if (text.trim().startsWith('<')) {
        console.error("CONTEÚDO RECEBIDO:", text.substring(0, 100));
        throw new Error("ALERTA CRÍTICO: O servidor Vite não encontrou o CSV e retornou o HTML.");
    }
    
    // Registra o arquivo em memória para o DuckDB ler
    await db.registerFileText('dataset.csv', text);

    // Consulta SQL normal
    const query = `
        SELECT 
            Occupation,
            Early_Waker,
            CAST(Sleep_Duration_Hours AS DOUBLE) AS Sleep_Duration_Hours,
            CAST(Energy_Level_Score AS DOUBLE) AS Energy_Level_Score
        FROM 'dataset.csv'
        WHERE Sleep_Duration_Hours IS NOT NULL 
          AND Energy_Level_Score IS NOT NULL
    `;
    
    // EXECUÇÃO E EXTRAÇÃO: Esta é a linha crucial que estava faltando!
    const arrowResult = await conn.query(query);
    const data = arrowResult.toArray().map(row => row.toJSON());

    await conn.close();

    // --- 4. Escalas (Com Padding para as Bordas) ---
    
    // Encontramos os limites reais dos dados
    const xExtent = d3.extent(data, d => d.Sleep_Duration_Hours);
    const yExtent = d3.extent(data, d => d.Energy_Level_Score);

    // Adicionamos um respiro (+/- 0.5 nas horas, +/- 0.5 no score) 
    // para garantir que o raio e o jitter não encostem nas bordas
    const xScale = d3.scaleLinear()
        .domain([xExtent[0] - 0.5, xExtent[1] + 0.5])
        .range([0, width]);

    const yScale = d3.scaleLinear()
        .domain([yExtent[0] - 0.5, yExtent[1] + 0.5])
        .range([height, 0]);

    const colorScale = d3.scaleOrdinal()
        .domain(["Yes", "No"])
        .range(["#2ca02c", "#1f77b4"]);

    // --- 5. Eixos e Gridlines ---
    
    svg.append("g")
        .attr("class", "grid")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(xScale)
            .tickSize(-height)
            .tickFormat("")
        )
        .selectAll("line")
        .attr("stroke", "#e0e0e0")
        .attr("stroke-dasharray", "3,3");

    svg.append("g")
        .attr("class", "grid")
        .call(d3.axisLeft(yScale)
            .tickSize(-width)
            .tickFormat("")
        )
        .selectAll("line")
        .attr("stroke", "#e0e0e0")
        .attr("stroke-dasharray", "3,3");

    svg.append("g")
        .attr("transform", `translate(0,${height})`)
        .call(d3.axisBottom(xScale))
        .append("text")
        .attr("class", "axis-label")
        .attr("x", width / 2)
        .attr("y", 40)
        .attr("fill", "black")
        .text("Duração do Sono (Horas)");

    svg.append("g")
        .call(d3.axisLeft(yScale))
        .append("text")
        .attr("class", "axis-label")
        .attr("transform", "rotate(-90)")
        .attr("y", -40)
        .attr("x", -height / 2)
        .attr("fill", "black")
        .style("text-anchor", "middle")
        .text("Nível de Energia (Score)");

    // --- 6. Marcadores (Scatterplot Otimizado) ---
    
    const jitterWidth = 10; // Jitter para revelar densidade

    svg.selectAll("circle")
        .data(data)
        .join("circle")
        .attr("cx", d => xScale(d.Sleep_Duration_Hours) + (Math.random() - 0.5) * jitterWidth)
        .attr("cy", d => yScale(d.Energy_Level_Score) + (Math.random() - 0.5) * jitterWidth)
        .attr("r", 3.5)
        .attr("fill", d => colorScale(d.Early_Waker))
        .attr("opacity", 0.4)
        
        // Interações Otimizadas (Sem manipular a estrutura do DOM)
        .on("mouseover", function(event, d) {
            d3.select(this)
                .attr("stroke", "black")
                .attr("stroke-width", 2)
                .attr("opacity", 1); 
            
            tooltip.classed("hidden", false)
                .style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY - 25) + "px")
                .html(`
                    <strong>Profissão:</strong> ${d.Occupation}<br>
                    <strong>Sono:</strong> ${d.Sleep_Duration_Hours.toFixed(1)}h<br>
                    <strong>Energia:</strong> ${d.Energy_Level_Score.toFixed(1)}
                `);
        })
        .on("mouseout", function() {
            d3.select(this)
                .attr("stroke", "none")
                .attr("opacity", 0.4);
            
            tooltip.classed("hidden", true);
        });
}

// Executa tudo
renderChart();