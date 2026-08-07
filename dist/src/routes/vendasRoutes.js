var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var vendasRoutes_exports = {};
__export(vendasRoutes_exports, {
  default: () => vendasRoutes_default
});
module.exports = __toCommonJS(vendasRoutes_exports);
var import_express = require("express");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
const router = (0, import_express.Router)();
const MES_ABREV = ["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"];
const MES_NOME = [
  "Janeiro",
  "Fevereiro",
  "Mar\xE7o",
  "Abril",
  "Maio",
  "Junho",
  "Julho",
  "Agosto",
  "Setembro",
  "Outubro",
  "Novembro",
  "Dezembro"
];
const EVOLUTION_MONTHS = 6;
function lastMonths(mes, ano, count) {
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(ano, mes - 1 - i, 1);
    out.push({
      mes: d.getMonth() + 1,
      ano: d.getFullYear(),
      label: `${MES_ABREV[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`
    });
  }
  return out;
}
const num = (x) => Number(x ?? 0);
router.get("/dashboard", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const mes = Number(req.query.mes);
    const ano = Number(req.query.ano);
    if (!Number.isFinite(mes) || mes < 1 || mes > 12 || !Number.isFinite(ano)) {
      return res.status(400).json({ erro: "Par\xE2metros mes/ano inv\xE1lidos." });
    }
    const canal = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const agrupar = String(req.query.agrupar ?? "categoria") === "vendedor" ? "vendedor" : "categoria";
    const topN = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId = req.filtroVendedor ?? null;
    const grupoExpr = agrupar === "vendedor" ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))` : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;
    const baseWhere = `
      WHERE ve.mes_numero = ?
        AND ve.ano        = ?
        AND (? IS NULL OR ve.vendedor_id         = ?)
        AND (? IS NULL OR ve.canal_cliente       = ?)
        AND (? IS NULL OR ve.segmentacao_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const baseParams = [mes, ano, fvId, fvId, canal, canal, segmentacao, segmentacao, busca, busca, busca, busca, busca];
    const months = lastMonths(mes, ano, EVOLUTION_MONTHS);
    const periodoIn = months.map(() => "(?, ?)").join(", ");
    const periodoParams = months.flatMap((m) => [m.mes, m.ano]);
    const filtroPeriodo = `
        AND (? IS NULL OR ve.vendedor_id         = ?)
        AND (? IS NULL OR ve.canal_cliente       = ?)
        AND (? IS NULL OR ve.segmentacao_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const filtroPeriodoParams = [fvId, fvId, canal, canal, segmentacao, segmentacao, busca, busca, busca, busca, busca];
    const [kpisQ, devQ, resumoQ, clientesQ, evolucaoQ, tiposMensalQ] = await Promise.all([
      // ── BRUTO — só VENDA ────────────────────────────────────────────────
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS faturamento_bruto,
          COALESCE(SUM(ve.soma_caixas), 0)   AS caixas_brutas,
          COALESCE(SUM(ve.soma_litros), 0)   AS litros_brutos,
          COUNT(DISTINCT ve.customer_number) AS clientes,
          COUNT(*)                           AS transacoes
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── DEVOLUÇÕES — mesmo WHERE, view irmã, magnitude positiva ─────────
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS devolucoes_valor,
          COALESCE(SUM(ve.soma_caixas), 0)   AS devolucoes_caixas,
          COALESCE(SUM(ve.soma_litros), 0)   AS devolucoes_litros,
          COUNT(*)                           AS devolucoes_transacoes,
          COUNT(DISTINCT ve.customer_number) AS clientes_com_devolucao
        FROM vw_vendas_devolucao ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── Resumo LÍQUIDO por grupo — devolução já negativa na view ────────
      (0, import_database.query)(`
        SELECT '__GERAL__' AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0)    AS valor_nf,
               COALESCE(SUM(ve.soma_caixas), 0) AS caixas,
               COALESCE(SUM(ve.soma_litros), 0) AS litros,
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END) AS clientes
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY grupo

        UNION ALL

        SELECT UPPER(TRIM(ve.categoria_total_sku)) AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0),
               COALESCE(SUM(ve.soma_caixas), 0),
               COALESCE(SUM(ve.soma_litros), 0),
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END)
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
          AND TRIM(COALESCE(ve.categoria_total_sku, '')) <> ''
        GROUP BY tipo, grupo

        ORDER BY valor_nf DESC
      `, [...baseParams, ...baseParams]),
      // ── Ranking de clientes LÍQUIDO ─────────────────────────────────────
      (0, import_database.query)(`
        SELECT ve.customer_number AS sold,
               MAX(CASE WHEN ve.origem_linha = 'VENDA'
                        THEN ve.customer_name END)   AS nome,
               COALESCE(SUM(ve.valor_nf), 0)         AS valor,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS valor_bruto,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                                 THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.customer_number
        HAVING valor <> 0
        ORDER BY valor DESC
      `, baseParams),
      // ── Evolução: faturamento LÍQUIDO + ruptura % ───────────────────────
      (0, import_database.query)(`
        SELECT p.mes_numero, p.ano,
               COALESCE(f.valor, 0)            AS valor,
               COALESCE(f.valor_bruto, 0)      AS valor_bruto,
               COALESCE(f.valor_devolucoes, 0) AS valor_devolucoes,
               COALESCE(100 * rp.rupturas / NULLIF(rp.base, 0), 0) AS ruptura_pct
        FROM (
          SELECT DISTINCT mes_numero, ano
          FROM vw_vendas_liquidas
          WHERE (mes_numero, ano) IN (${periodoIn})
          UNION
          SELECT DISTINCT mes_numero, ano
          FROM vw_ruptura_avaliada
          WHERE (mes_numero, ano) IN (${periodoIn})
        ) p
        LEFT JOIN (
          SELECT ve.mes_numero, ve.ano,
                 COALESCE(SUM(ve.valor_nf), 0) AS valor,
                 COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.valor_nf ELSE 0 END), 0) AS valor_bruto,
                 COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                                   THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes
          FROM vw_vendas_liquidas ve
          LEFT JOIN vendedores v ON v.id = ve.vendedor_id
          WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
            ${filtroPeriodo}
          GROUP BY ve.mes_numero, ve.ano
        ) f ON f.mes_numero = p.mes_numero AND f.ano = p.ano
        LEFT JOIN (
          SELECT ra.mes_numero, ra.ano,
                 SUM(ra.eh_ruptura) AS rupturas,
                 SUM(ra.entra_base) AS base
          FROM vw_ruptura_avaliada ra
          WHERE (ra.mes_numero, ra.ano) IN (${periodoIn})
            AND (? IS NULL OR ra.vendedor_id   = ?)
            AND (? IS NULL OR ra.canal_cliente = ?)
           -- [v5] Segmenta\xE7\xE3o N\xC3O \xE9 aplicada \xE0 ruptura por padr\xE3o: depende de
            -- vw_ruptura_avaliada expor 'segmentacao_cliente'. Se essa coluna
            -- EXISTIR na view, descomente as DUAS linhas abaixo E adicione
            -- 'segmentacao, segmentacao' ANTES de 'busca, busca, busca' no
            -- bloco de params da ruptura (marcado mais abaixo) para a linha de
            -- ruptura % tamb\xE9m reagir \xE0 segmenta\xE7\xE3o:
            -- AND (? IS NULL OR ra.segmentacao_cliente = ?)
            AND (? IS NULL OR (
                  ra.customer_name                 LIKE CONCAT('%', ?, '%')
               OR CAST(ra.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
               OR ra.vendedor_nome                 LIKE CONCAT('%', ?, '%')
            ))
          GROUP BY ra.mes_numero, ra.ano
        ) rp ON rp.mes_numero = p.mes_numero AND rp.ano = p.ano
        ORDER BY p.ano, p.mes_numero
      `, [
        ...periodoParams,
        ...periodoParams,
        ...periodoParams,
        ...filtroPeriodoParams,
        // ── Params da ruptura ──
        // Se ativar o filtro de segmentação na ruptura (acima), insira
        // `segmentacao, segmentacao,` logo após `canal, canal,` nesta linha:
        ...periodoParams,
        fvId,
        fvId,
        canal,
        canal,
        busca,
        busca,
        busca,
        busca
      ]),
      // ── Take Home × Impulso LÍQUIDOS por mês ────────────────────────────
      (0, import_database.query)(`
        SELECT ve.mes_numero, ve.ano,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'TAKE HOME'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS take_home,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'IMPULSO'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS impulso
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
          ${filtroPeriodo}
        GROUP BY ve.mes_numero, ve.ano
        ORDER BY ve.ano, ve.mes_numero
      `, [...periodoParams, ...filtroPeriodoParams])
    ]);
    const k = kpisQ.rows[0] ?? {};
    const d = devQ.rows[0] ?? {};
    const faturamentoBruto = num(k.faturamento_bruto);
    const caixasBrutas = num(k.caixas_brutas);
    const litrosBrutos = num(k.litros_brutos);
    const clientes = num(k.clientes);
    const devolucoesValor = num(d.devolucoes_valor);
    const devolucoesCaixas = num(d.devolucoes_caixas);
    const devolucoesLitros = num(d.devolucoes_litros);
    const faturamento = faturamentoBruto - devolucoesValor;
    const caixas = caixasBrutas - devolucoesCaixas;
    const litros = litrosBrutos - devolucoesLitros;
    const linhas = resumoQ.rows.map((r) => ({
      tipo: String(r.tipo ?? ""),
      grupo: String(r.grupo ?? ""),
      valor_nf: num(r.valor_nf),
      caixas: num(r.caixas),
      litros: num(r.litros),
      clientes: num(r.clientes)
    }));
    const porTipo = (t) => linhas.filter((l) => l.tipo === t).map(({ tipo: _t, ...rest }) => rest);
    const rankingClientes = clientesQ.rows.map((c) => ({
      sold: c.sold,
      nome: String(c.nome ?? "\u2014"),
      valor: num(c.valor),
      valor_bruto: num(c.valor_bruto),
      valor_devolucoes: num(c.valor_devolucoes)
    }));
    const evoMap = new Map(evolucaoQ.rows.map((r) => [`${r.ano}-${r.mes_numero}`, r]));
    const evolucao = months.map((m) => {
      const r = evoMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes,
        ano: m.ano,
        label: m.label,
        valor: num(r?.valor),
        valor_bruto: num(r?.valor_bruto),
        valor_devolucoes: num(r?.valor_devolucoes),
        ruptura_pct: num(r?.ruptura_pct)
      };
    });
    const tiposMap = new Map(tiposMensalQ.rows.map((r) => [`${r.ano}-${r.mes_numero}`, r]));
    const evolucaoTipos = months.map((m) => {
      const r = tiposMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes,
        ano: m.ano,
        label: m.label,
        take_home: num(r?.take_home),
        impulso: num(r?.impulso)
      };
    });
    res.json({
      periodo: { mes, ano, canal, segmentacao, agrupar },
      kpis: {
        // Líquidos — devolução já abatida.
        faturamento,
        caixas,
        litros,
        clientes,
        transacoes: num(k.transacoes),
        // Brutos — composição do número.
        faturamento_bruto: faturamentoBruto,
        caixas_brutas: caixasBrutas,
        litros_brutos: litrosBrutos,
        // Devoluções — magnitude POSITIVA.
        devolucoes_valor: devolucoesValor,
        devolucoes_caixas: devolucoesCaixas,
        devolucoes_litros: devolucoesLitros,
        devolucoes_transacoes: num(d.devolucoes_transacoes),
        clientes_com_devolucao: num(d.clientes_com_devolucao),
        pct_devolucao: faturamentoBruto > 0 ? devolucoesValor / faturamentoBruto * 100 : 0,
        // Médias sobre o LÍQUIDO.
        ticket_medio: clientes > 0 ? faturamento / clientes : 0,
        caixas_por_cliente: clientes > 0 ? caixas / clientes : 0
      },
      resumo: {
        geral: porTipo("__GERAL__"),
        take_home: porTipo("TAKE HOME"),
        impulso: porTipo("IMPULSO")
      },
      top_clientes: rankingClientes.slice(0, topN),
      ranking_clientes: rankingClientes,
      evolucao,
      evolucao_tipos: evolucaoTipos
    });
  } catch (err) {
    console.error("[vendas/dashboard]", err);
    res.status(500).json({ erro: "Erro ao carregar dashboard de vendas." });
  }
});
router.get("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const mes = req.query.mes ? Number(req.query.mes) : null;
    const ano = req.query.ano ? Number(req.query.ano) : null;
    if (mes !== null && !Number.isInteger(mes) || ano !== null && !Number.isInteger(ano)) {
      return res.status(400).json({ erro: "Par\xE2metros mes/ano inv\xE1lidos." });
    }
    const canal = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const isExport = String(req.query.export ?? "") === "true";
    const incluirDev = String(req.query.incluir_devolucoes ?? "true") !== "false";
    const vendedorQuery = req.query.vendedor_id !== void 0 && req.query.vendedor_id !== "" ? Number(req.query.vendedor_id) : null;
    if (vendedorQuery !== null && !Number.isFinite(vendedorQuery)) {
      return res.status(400).json({ erro: "Par\xE2metro vendedor_id inv\xE1lido." });
    }
    const fvId = req.filtroVendedor ?? vendedorQuery;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = isExport ? 5e4 : Math.min(Math.max(Number(req.query.limit) || 30, 1), 500);
    const offset = isExport ? 0 : (page - 1) * limit;
    const fonte = incluirDev ? "vw_vendas_liquidas" : "vw_vendas_validas";
    const origemCol = incluirDev ? `ve.origem_linha` : `'VENDA' AS origem_linha`;
    const whereSql = `
      WHERE 1 = 1
        AND (? IS NULL OR ve.mes_numero          = ?)
        AND (? IS NULL OR ve.ano                 = ?)
        AND (? IS NULL OR ve.vendedor_id         = ?)
        AND (? IS NULL OR ve.canal_cliente       = ?)
        AND (? IS NULL OR ve.segmentacao_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const params = [
      mes,
      mes,
      ano,
      ano,
      fvId,
      fvId,
      canal,
      canal,
      segmentacao,
      segmentacao,
      busca,
      busca,
      busca,
      busca,
      busca
    ];
    const [totalQ, totaisQ, rowsQ] = await Promise.all([
      (0, import_database.query)(`
        SELECT COUNT(*) AS count
        FROM ${fonte} ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),
      // Totais do filtro inteiro (não só da página).
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)    AS valor_liquido,
          COALESCE(SUM(ve.soma_caixas), 0) AS caixas_liquidas
          ${incluirDev ? `,
          COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                            THEN ve.valor_nf ELSE 0 END), 0)      AS valor_bruto,
          COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                            THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes
          ` : `,
          COALESCE(SUM(ve.valor_nf), 0) AS valor_bruto,
          0                             AS valor_devolucoes
          `}
        FROM ${fonte} ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),
      // valor_nf já vem com sinal correto — o front soma direto.
      (0, import_database.query)(`
        SELECT
          ve.customer_number, ve.customer_name, ve.numero_nf, ve.data_faturamento,
          ve.descricao_produto, ve.categoria, ve.subcategoria, ve.categoria_total_sku,
          ve.soma_caixas, ve.soma_litros, ve.valor_nf, ve.status_venda,
          ${origemCol},
          ve.canal_cliente, ve.segmentacao_cliente, ve.city,
          v.nome AS vendedor_nome
        FROM ${fonte} ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
        ORDER BY ve.data_faturamento DESC, ve.customer_number, ve.numero_nf
        LIMIT ? OFFSET ?
      `, [...params, limit, offset])
    ]);
    res.json({
      total: Number(totalQ.rows[0].count),
      pagina: page,
      limite: limit,
      totais: {
        valor_liquido: num(totaisQ.rows[0]?.valor_liquido),
        caixas_liquidas: num(totaisQ.rows[0]?.caixas_liquidas),
        valor_bruto: num(totaisQ.rows[0]?.valor_bruto),
        valor_devolucoes: num(totaisQ.rows[0]?.valor_devolucoes)
      },
      dados: rowsQ.rows
    });
  } catch (err) {
    console.error("[vendas/get]", err);
    res.status(500).json({ erro: "Erro ao listar vendas." });
  }
});
router.get("/comparativo-anual", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const anoAtual = req.query.ano === void 0 || req.query.ano === "" ? (/* @__PURE__ */ new Date()).getFullYear() : Number(req.query.ano);
    if (!Number.isInteger(anoAtual) || anoAtual < 1900 || anoAtual > 3e3) {
      return res.status(400).json({ erro: "Par\xE2metro ano inv\xE1lido." });
    }
    const anoAnterior = anoAtual - 1;
    const canal = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const vendedorQuery = req.query.vendedor_id !== void 0 && req.query.vendedor_id !== "" ? Number(req.query.vendedor_id) : null;
    if (vendedorQuery !== null && !Number.isFinite(vendedorQuery)) {
      return res.status(400).json({ erro: "Par\xE2metro vendedor_id inv\xE1lido." });
    }
    const fvId = req.filtroVendedor ?? vendedorQuery;
    const [vendasQ, rupturaQ] = await Promise.all([
      // ── Faturamento LÍQUIDO por (ano, mês) — os dois anos de uma vez ──────
      (0, import_database.query)(`
        SELECT ve.ano, ve.mes_numero,
               COALESCE(SUM(ve.valor_nf), 0) AS valor,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS valor_bruto,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                                 THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes,
               COALESCE(SUM(ve.soma_caixas), 0) AS caixas,
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END) AS clientes
        FROM vw_vendas_liquidas ve
        ${busca ? `LEFT JOIN vendedores v ON v.id = ve.vendedor_id` : ""}
        WHERE ve.ano IN (?, ?)
          AND (? IS NULL OR ve.vendedor_id         = ?)
          AND (? IS NULL OR ve.canal_cliente       = ?)
          AND (? IS NULL OR ve.segmentacao_cliente = ?)
          ${busca ? `AND (
                ve.customer_name                 LIKE CONCAT('%', ?, '%')
             OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
             OR v.nome                           LIKE CONCAT('%', ?, '%')
             OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
          )` : ""}
        GROUP BY ve.ano, ve.mes_numero
      `, [
        anoAnterior,
        anoAtual,
        fvId,
        fvId,
        canal,
        canal,
        segmentacao,
        segmentacao,
        ...busca ? [busca, busca, busca, busca] : []
      ]),
      // ── Ruptura por (ano, mês) — mesma fórmula de vw_ruptura_kpi_mensal ───
      (0, import_database.query)(`
        SELECT ra.ano, ra.mes_numero,
               SUM(ra.eh_ruptura) AS rupturas,
               SUM(ra.entra_base) AS base
        FROM vw_ruptura_avaliada ra
        WHERE ra.ano IN (?, ?)
          AND (? IS NULL OR ra.vendedor_id         = ?)
          AND (? IS NULL OR ra.canal_cliente       = ?)
          AND (? IS NULL OR ra.segmentacao_cliente = ?)
          ${busca ? `AND (
                ra.customer_name                 LIKE CONCAT('%', ?, '%')
             OR CAST(ra.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
             OR ra.vendedor_nome                 LIKE CONCAT('%', ?, '%')
          )` : ""}
        GROUP BY ra.ano, ra.mes_numero
      `, [
        anoAnterior,
        anoAtual,
        fvId,
        fvId,
        canal,
        canal,
        segmentacao,
        segmentacao,
        ...busca ? [busca, busca, busca] : []
      ])
    ]);
    const chave = (ano, mes) => `${ano}-${mes}`;
    const vendasMap = new Map(vendasQ.rows.map((r) => [chave(num(r.ano), num(r.mes_numero)), r]));
    const rupturaMap = new Map(rupturaQ.rows.map((r) => [chave(num(r.ano), num(r.mes_numero)), r]));
    const pctRuptura = (r) => {
      const base = num(r?.base);
      if (base <= 0) return null;
      return num(r?.rupturas) / base * 100;
    };
    const meses = Array.from({ length: 12 }, (_, i) => {
      const mesNumero = i + 1;
      const vAtual = vendasMap.get(chave(anoAtual, mesNumero));
      const vAnterior = vendasMap.get(chave(anoAnterior, mesNumero));
      const rAtual = rupturaMap.get(chave(anoAtual, mesNumero));
      const rAnterior = rupturaMap.get(chave(anoAnterior, mesNumero));
      const valorAtual = num(vAtual?.valor);
      const valorAnterior = num(vAnterior?.valor);
      const variacaoPct = valorAnterior > 0 ? (valorAtual - valorAnterior) / valorAnterior * 100 : null;
      const rupturaAtual = pctRuptura(rAtual);
      const rupturaAnterior = pctRuptura(rAnterior);
      const rupturaDeltaPp = rupturaAtual != null && rupturaAnterior != null ? rupturaAtual - rupturaAnterior : null;
      return {
        mes_numero: mesNumero,
        label: MES_ABREV[i],
        valor_atual: valorAtual,
        valor_anterior: valorAnterior,
        bruto_atual: num(vAtual?.valor_bruto),
        bruto_anterior: num(vAnterior?.valor_bruto),
        devolucoes_atual: num(vAtual?.valor_devolucoes),
        devolucoes_anterior: num(vAnterior?.valor_devolucoes),
        caixas_atual: num(vAtual?.caixas),
        caixas_anterior: num(vAnterior?.caixas),
        clientes_atual: num(vAtual?.clientes),
        clientes_anterior: num(vAnterior?.clientes),
        variacao_pct: variacaoPct,
        ruptura_atual: rupturaAtual,
        ruptura_anterior: rupturaAnterior,
        ruptura_delta_pp: rupturaDeltaPp,
        base_atual: num(rAtual?.base),
        base_anterior: num(rAnterior?.base),
        rupturas_atual: num(rAtual?.rupturas),
        rupturas_anterior: num(rAnterior?.rupturas)
      };
    });
    const ultimoMesComDado = meses.reduce(
      (ult, m) => m.valor_atual !== 0 || m.bruto_atual !== 0 || m.base_atual > 0 ? m.mes_numero : ult,
      0
    );
    const janela = meses.slice(0, ultimoMesComDado);
    const totalAtual = janela.reduce((s, m) => s + m.valor_atual, 0);
    const totalAnterior = janela.reduce((s, m) => s + m.valor_anterior, 0);
    const variacaoAnual = totalAnterior > 0 ? (totalAtual - totalAnterior) / totalAnterior * 100 : null;
    const rupturaAno = (bases, rupturas) => bases > 0 ? rupturas / bases * 100 : null;
    const baseAtual = janela.reduce((s, m) => s + m.base_atual, 0);
    const baseAnterior = janela.reduce((s, m) => s + m.base_anterior, 0);
    const rupturasAtual = janela.reduce((s, m) => s + m.rupturas_atual, 0);
    const rupturasAnterior = janela.reduce((s, m) => s + m.rupturas_anterior, 0);
    const rupturaMediaAtual = rupturaAno(baseAtual, rupturasAtual);
    const rupturaMediaAnterior = rupturaAno(baseAnterior, rupturasAnterior);
    res.json({
      ano_atual: anoAtual,
      ano_anterior: anoAnterior,
      filtros: { canal, segmentacao, busca: buscaRaw || null },
      total_atual: totalAtual,
      total_anterior: totalAnterior,
      variacao_anual_pct: variacaoAnual,
      meses_comparados: ultimoMesComDado,
      ruptura_media_atual: rupturaMediaAtual,
      ruptura_media_anterior: rupturaMediaAnterior,
      ruptura_delta_pp: rupturaMediaAtual != null && rupturaMediaAnterior != null ? rupturaMediaAtual - rupturaMediaAnterior : null,
      meses
    });
  } catch (err) {
    console.error("[vendas/comparativo-anual]", err);
    res.status(500).json({ erro: "Erro ao carregar comparativo anual de vendas." });
  }
});
const RELATORIO_MAX_TRANSACOES = 1e5;
router.get("/relatorio", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const ano = Number(req.query.ano);
    const mesIniRaw = Number(req.query.mes_inicio);
    const mesFimRaw = Number(req.query.mes_fim);
    const mesesOk = [mesIniRaw, mesFimRaw].every((m) => Number.isInteger(m) && m >= 1 && m <= 12);
    if (!Number.isInteger(ano) || ano < 1900 || ano > 3e3 || !mesesOk) {
      return res.status(400).json({ erro: "Par\xE2metros ano/mes_inicio/mes_fim inv\xE1lidos." });
    }
    const mesInicio = Math.min(mesIniRaw, mesFimRaw);
    const mesFim = Math.max(mesIniRaw, mesFimRaw);
    const canal = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const agrupar = String(req.query.agrupar ?? "categoria") === "vendedor" ? "vendedor" : "categoria";
    const topN = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId = req.filtroVendedor ?? null;
    const grupoExpr = agrupar === "vendedor" ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))` : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;
    const baseWhere = `
      WHERE ve.ano = ?
        AND ve.mes_numero BETWEEN ? AND ?
        AND (? IS NULL OR ve.vendedor_id         = ?)
        AND (? IS NULL OR ve.canal_cliente       = ?)
        AND (? IS NULL OR ve.segmentacao_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const baseParams = [
      ano,
      mesInicio,
      mesFim,
      fvId,
      fvId,
      canal,
      canal,
      segmentacao,
      segmentacao,
      busca,
      busca,
      busca,
      busca,
      busca
    ];
    const [kpisQ, devQ, resumoQ, clientesQ, mensalQ, rupturaQ, transTotalQ, transQ] = await Promise.all([
      // ── BRUTO — só VENDA ────────────────────────────────────────────────
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS faturamento_bruto,
          COALESCE(SUM(ve.soma_caixas), 0)   AS caixas_brutas,
          COALESCE(SUM(ve.soma_litros), 0)   AS litros_brutos,
          COUNT(DISTINCT ve.customer_number) AS clientes,
          COUNT(*)                           AS transacoes
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── DEVOLUÇÕES — magnitude positiva ─────────────────────────────────
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS devolucoes_valor,
          COALESCE(SUM(ve.soma_caixas), 0)   AS devolucoes_caixas,
          COALESCE(SUM(ve.soma_litros), 0)   AS devolucoes_litros,
          COUNT(*)                           AS devolucoes_transacoes,
          COUNT(DISTINCT ve.customer_number) AS clientes_com_devolucao
        FROM vw_vendas_devolucao ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── Resumo LÍQUIDO por grupo (geral + Take Home/Impulso) ────────────
      (0, import_database.query)(`
        SELECT '__GERAL__' AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0)    AS valor_nf,
               COALESCE(SUM(ve.soma_caixas), 0) AS caixas,
               COALESCE(SUM(ve.soma_litros), 0) AS litros,
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END) AS clientes
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY grupo

        UNION ALL

        SELECT UPPER(TRIM(ve.categoria_total_sku)) AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0),
               COALESCE(SUM(ve.soma_caixas), 0),
               COALESCE(SUM(ve.soma_litros), 0),
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END)
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
          AND TRIM(COALESCE(ve.categoria_total_sku, '')) <> ''
        GROUP BY tipo, grupo

        ORDER BY valor_nf DESC
      `, [...baseParams, ...baseParams]),
      // ── Ranking de clientes LÍQUIDO do intervalo ────────────────────────
      (0, import_database.query)(`
        SELECT ve.customer_number AS sold,
               MAX(CASE WHEN ve.origem_linha = 'VENDA'
                        THEN ve.customer_name END)   AS nome,
               COALESCE(SUM(ve.valor_nf), 0)         AS valor,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS valor_bruto,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                                 THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.customer_number
        HAVING valor <> 0
        ORDER BY valor DESC
      `, baseParams),
      // ── Evolução mês a mês do intervalo (líquido + tipos numa query só) ─
      (0, import_database.query)(`
        SELECT ve.mes_numero,
               COALESCE(SUM(ve.valor_nf), 0) AS valor,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'VENDA'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS valor_bruto,
               COALESCE(SUM(CASE WHEN ve.origem_linha = 'DEVOLUCAO'
                                 THEN ABS(ve.valor_nf) ELSE 0 END), 0) AS valor_devolucoes,
               COALESCE(SUM(ve.soma_caixas), 0) AS caixas,
               COUNT(DISTINCT CASE WHEN ve.origem_linha = 'VENDA'
                                   THEN ve.customer_number END) AS clientes,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'TAKE HOME'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS take_home,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'IMPULSO'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS impulso
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.mes_numero
        ORDER BY ve.mes_numero
      `, baseParams),
      // ── Ruptura por mês do intervalo ────────────────────────────────────
      (0, import_database.query)(`
        SELECT ra.mes_numero,
               SUM(ra.eh_ruptura) AS rupturas,
               SUM(ra.entra_base) AS base
        FROM vw_ruptura_avaliada ra
        WHERE ra.ano = ?
          AND ra.mes_numero BETWEEN ? AND ?
          AND (? IS NULL OR ra.vendedor_id         = ?)
          AND (? IS NULL OR ra.canal_cliente       = ?)
          AND (? IS NULL OR ra.segmentacao_cliente = ?)
          AND (? IS NULL OR (
                ra.customer_name                 LIKE CONCAT('%', ?, '%')
             OR CAST(ra.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
             OR ra.vendedor_nome                 LIKE CONCAT('%', ?, '%')
          ))
        GROUP BY ra.mes_numero
      `, [
        ano,
        mesInicio,
        mesFim,
        fvId,
        fvId,
        canal,
        canal,
        segmentacao,
        segmentacao,
        busca,
        busca,
        busca,
        busca
      ]),
      // ── Total de transações do filtro (para sinalizar truncamento) ──────
      (0, import_database.query)(`
        SELECT COUNT(*) AS count
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── Transações do intervalo (valor_nf já com sinal correto) ─────────
      (0, import_database.query)(`
        SELECT
          ve.customer_number, ve.customer_name, ve.numero_nf, ve.data_faturamento,
          ve.descricao_produto, ve.categoria, ve.subcategoria, ve.categoria_total_sku,
          ve.soma_caixas, ve.soma_litros, ve.valor_nf, ve.status_venda,
          ve.origem_linha, ve.canal_cliente, ve.segmentacao_cliente, ve.city,
          v.nome AS vendedor_nome
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        ORDER BY ve.data_faturamento DESC, ve.customer_number, ve.numero_nf
        LIMIT ?
      `, [...baseParams, RELATORIO_MAX_TRANSACOES])
    ]);
    const k = kpisQ.rows[0] ?? {};
    const d = devQ.rows[0] ?? {};
    const faturamentoBruto = num(k.faturamento_bruto);
    const caixasBrutas = num(k.caixas_brutas);
    const litrosBrutos = num(k.litros_brutos);
    const clientes = num(k.clientes);
    const devolucoesValor = num(d.devolucoes_valor);
    const devolucoesCaixas = num(d.devolucoes_caixas);
    const devolucoesLitros = num(d.devolucoes_litros);
    const faturamento = faturamentoBruto - devolucoesValor;
    const caixas = caixasBrutas - devolucoesCaixas;
    const litros = litrosBrutos - devolucoesLitros;
    const linhas = resumoQ.rows.map((r) => ({
      tipo: String(r.tipo ?? ""),
      grupo: String(r.grupo ?? ""),
      valor_nf: num(r.valor_nf),
      caixas: num(r.caixas),
      litros: num(r.litros),
      clientes: num(r.clientes)
    }));
    const porTipo = (t) => linhas.filter((l) => l.tipo === t).map(({ tipo: _t, ...rest }) => rest);
    const rankingClientes = clientesQ.rows.map((c) => ({
      sold: c.sold,
      nome: String(c.nome ?? "\u2014"),
      valor: num(c.valor),
      valor_bruto: num(c.valor_bruto),
      valor_devolucoes: num(c.valor_devolucoes)
    }));
    const mensalMap = new Map(mensalQ.rows.map((r) => [num(r.mes_numero), r]));
    const rupturaMap = new Map(rupturaQ.rows.map((r) => [num(r.mes_numero), r]));
    const evolucao = Array.from({ length: mesFim - mesInicio + 1 }, (_, i) => {
      const mesNumero = mesInicio + i;
      const m = mensalMap.get(mesNumero);
      const r = rupturaMap.get(mesNumero);
      const base = num(r?.base);
      return {
        mes: mesNumero,
        ano,
        label: `${MES_ABREV[mesNumero - 1]}/${String(ano).slice(2)}`,
        valor: num(m?.valor),
        valor_bruto: num(m?.valor_bruto),
        valor_devolucoes: num(m?.valor_devolucoes),
        caixas: num(m?.caixas),
        clientes: num(m?.clientes),
        take_home: num(m?.take_home),
        impulso: num(m?.impulso),
        // Mês sem base avaliada (futuro / sem roster) tem ruptura INDEFINIDA.
        ruptura_pct: base > 0 ? num(r?.rupturas) / base * 100 : null
      };
    });
    const totalTransacoes = num(transTotalQ.rows[0]?.count);
    const labelPeriodo = mesInicio === mesFim ? `${MES_NOME[mesInicio - 1]}/${ano}` : `${MES_NOME[mesInicio - 1]} a ${MES_NOME[mesFim - 1]}/${ano}`;
    res.json({
      periodo: {
        ano,
        mes_inicio: mesInicio,
        mes_fim: mesFim,
        label: labelPeriodo,
        canal,
        segmentacao,
        busca: buscaRaw || null,
        agrupar
      },
      kpis: {
        faturamento,
        caixas,
        litros,
        clientes,
        transacoes: num(k.transacoes),
        faturamento_bruto: faturamentoBruto,
        caixas_brutas: caixasBrutas,
        litros_brutos: litrosBrutos,
        devolucoes_valor: devolucoesValor,
        devolucoes_caixas: devolucoesCaixas,
        devolucoes_litros: devolucoesLitros,
        devolucoes_transacoes: num(d.devolucoes_transacoes),
        clientes_com_devolucao: num(d.clientes_com_devolucao),
        pct_devolucao: faturamentoBruto > 0 ? devolucoesValor / faturamentoBruto * 100 : 0,
        ticket_medio: clientes > 0 ? faturamento / clientes : 0,
        caixas_por_cliente: clientes > 0 ? caixas / clientes : 0
      },
      resumo: {
        geral: porTipo("__GERAL__"),
        take_home: porTipo("TAKE HOME"),
        impulso: porTipo("IMPULSO")
      },
      top_clientes: rankingClientes.slice(0, topN),
      ranking_clientes: rankingClientes,
      evolucao,
      transacoes: {
        total: totalTransacoes,
        truncado: totalTransacoes > RELATORIO_MAX_TRANSACOES,
        dados: transQ.rows
      }
    });
  } catch (err) {
    console.error("[vendas/relatorio]", err);
    res.status(500).json({ erro: "Erro ao gerar relat\xF3rio de vendas." });
  }
});
var vendasRoutes_default = router;
