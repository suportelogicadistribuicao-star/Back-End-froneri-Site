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
router.get("/dashboard", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const mes = Number(req.query.mes);
    const ano = Number(req.query.ano);
    if (!Number.isFinite(mes) || mes < 1 || mes > 12 || !Number.isFinite(ano)) {
      return res.status(400).json({ erro: "Par\xE2metros mes/ano inv\xE1lidos." });
    }
    const canal = req.query.canal ? String(req.query.canal) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const agrupar = String(req.query.agrupar ?? "categoria") === "vendedor" ? "vendedor" : "categoria";
    const topN = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId = req.filtroVendedor ?? null;
    const grupoExpr = agrupar === "vendedor" ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))` : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;
    const baseWhere = `
      WHERE ve.mes_numero   = ?
        AND ve.ano          = ?
        AND ve.status_venda = 'VENDA'
        AND (? IS NULL OR ve.vendedor_id   = ?)
        AND (? IS NULL OR ve.canal_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name              LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                        LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto          LIKE CONCAT('%', ?, '%')
        ))
    `;
    const baseParams = [mes, ano, fvId, fvId, canal, canal, busca, busca, busca, busca, busca];
    const months = lastMonths(mes, ano, EVOLUTION_MONTHS);
    const periodoIn = months.map(() => "(?, ?)").join(", ");
    const periodoParams = months.flatMap((m) => [m.mes, m.ano]);
    const [kpisQ, resumoQ, clientesQ, evolucaoQ] = await Promise.all([
      // ── KPIs ────────────────────────────────────────────────────────────
      // COUNT(DISTINCT customer_number) resolve no banco a dedup que o front
      // fazia com Set — antes contava transação, não cliente.
      (0, import_database.query)(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS faturamento,
          COALESCE(SUM(ve.soma_caixas), 0)   AS caixas,
          COALESCE(SUM(ve.soma_litros), 0)   AS litros,
          COUNT(DISTINCT ve.customer_number) AS clientes,
          COUNT(*)                           AS transacoes
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),
      // ── Resumo: geral + Take Home + Impulso ─────────────────────────────
      // MySQL não tem GROUPING SETS. WITH ROLLUP não serve (soma os tipos em
      // vez de dar o geral por grupo). Uma passada por tipo + GROUPING(tipo)
      // simulado via UNION ALL: 2 varreduras em vez das 3 do front.
      (0, import_database.query)(`
        SELECT '__GERAL__' AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0)      AS valor_nf,
               COALESCE(SUM(ve.soma_caixas), 0)   AS caixas,
               COALESCE(SUM(ve.soma_litros), 0)   AS litros,
               COUNT(DISTINCT ve.customer_number) AS clientes
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY grupo

        UNION ALL

        SELECT UPPER(TRIM(ve.categoria_total_sku)) AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0),
               COALESCE(SUM(ve.soma_caixas), 0),
               COALESCE(SUM(ve.soma_litros), 0),
               COUNT(DISTINCT ve.customer_number)
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
          AND TRIM(COALESCE(ve.categoria_total_sku, '')) <> ''
        GROUP BY tipo, grupo

        ORDER BY valor_nf DESC
      `, [...baseParams, ...baseParams]),
      // ── Ranking de clientes (completo; o front corta em topN p/ o gráfico) ──
      (0, import_database.query)(`
        SELECT ve.customer_number            AS sold,
               MAX(ve.customer_name)         AS nome,
               COALESCE(SUM(ve.valor_nf), 0) AS valor
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.customer_number
        ORDER BY valor DESC
      `, baseParams),
      // ── Evolução: 6 meses numa query (eram 18 requisições) ──────────────
      // Faturamento de `vendas`; ruptura % de agg_ruptura_mensal, que já
      // aplica a regra Froneri. LEFT JOIN: pode haver mês sem ruptura.
      (0, import_database.query)(`
        SELECT p.mes_numero, p.ano,
               COALESCE(f.valor, 0) AS valor,
               COALESCE(ROUND(100 * r.rupturas / NULLIF(r.base, 0)), 0) AS ruptura_pct
        FROM (
          SELECT DISTINCT mes_numero, ano
          FROM vendas
          WHERE (mes_numero, ano) IN (${periodoIn})
          UNION
          SELECT DISTINCT mes_numero, ano
          FROM agg_ruptura_mensal
          WHERE (mes_numero, ano) IN (${periodoIn})
        ) p
        LEFT JOIN (
          SELECT ve.mes_numero, ve.ano, COALESCE(SUM(ve.valor_nf), 0) AS valor
          FROM vendas ve
          WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
            AND ve.status_venda = 'VENDA'
            AND (? IS NULL OR ve.vendedor_id   = ?)
            AND (? IS NULL OR ve.canal_cliente = ?)
          GROUP BY ve.mes_numero, ve.ano
        ) f ON f.mes_numero = p.mes_numero AND f.ano = p.ano
        LEFT JOIN (
          SELECT a.mes_numero, a.ano,
                 SUM(a.clientes_ruptura) AS rupturas,
                 SUM(a.clientes_base)    AS base
          FROM agg_ruptura_mensal a
          WHERE (a.mes_numero, a.ano) IN (${periodoIn})
            AND (? IS NULL OR a.vendedor_id   = ?)
            AND (? IS NULL OR a.canal_cliente = ?)
          GROUP BY a.mes_numero, a.ano
        ) r ON r.mes_numero = p.mes_numero AND r.ano = p.ano
        ORDER BY p.ano, p.mes_numero
      `, [
        ...periodoParams,
        ...periodoParams,
        ...periodoParams,
        fvId,
        fvId,
        canal,
        canal,
        ...periodoParams,
        fvId,
        fvId,
        canal,
        canal
      ])
    ]);
    const k = kpisQ.rows[0] ?? {};
    const faturamento = Number(k.faturamento ?? 0);
    const caixas = Number(k.caixas ?? 0);
    const clientes = Number(k.clientes ?? 0);
    const linhas = resumoQ.rows.map((r) => ({
      tipo: String(r.tipo ?? ""),
      grupo: String(r.grupo ?? ""),
      valor_nf: Number(r.valor_nf ?? 0),
      caixas: Number(r.caixas ?? 0),
      litros: Number(r.litros ?? 0),
      clientes: Number(r.clientes ?? 0)
    }));
    const porTipo = (t) => linhas.filter((l) => l.tipo === t).map(({ tipo: _t, ...rest }) => rest);
    const rankingClientes = clientesQ.rows.map((c) => ({
      sold: c.sold,
      nome: String(c.nome ?? "\u2014"),
      valor: Number(c.valor ?? 0)
    }));
    const evoMap = new Map(
      evolucaoQ.rows.map((r) => [`${r.ano}-${r.mes_numero}`, r])
    );
    const evolucao = months.map((m) => {
      const r = evoMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes,
        ano: m.ano,
        label: m.label,
        valor: Number(r?.valor ?? 0),
        ruptura_pct: Number(r?.ruptura_pct ?? 0)
      };
    });
    res.json({
      periodo: { mes, ano, canal, agrupar },
      kpis: {
        faturamento,
        caixas,
        litros: Number(k.litros ?? 0),
        clientes,
        transacoes: Number(k.transacoes ?? 0),
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
      evolucao
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
    const canal = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : "";
    const busca = buscaRaw ? buscaRaw.replace(/[\\%_]/g, "\\$&") : null;
    const isExport = String(req.query.export ?? "") === "true";
    const fvId = req.filtroVendedor ?? req.query.vendedor_id ?? null;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = isExport ? 5e4 : Math.min(Math.max(Number(req.query.limit) || 30, 1), 500);
    const offset = isExport ? 0 : (page - 1) * limit;
    const whereSql = `
      WHERE ve.status_venda = 'VENDA'
        AND (? IS NULL OR ve.mes_numero          = ?)
        AND (? IS NULL OR ve.ano                 = ?)
        AND (? IS NULL OR ve.vendedor_id         = ?)
        AND (? IS NULL OR ve.canal_cliente       = ?)
        AND (? IS NULL OR ve.segmentacao_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                          LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto            LIKE CONCAT('%', ?, '%')
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
    const [totalQ, rowsQ] = await Promise.all([
      (0, import_database.query)(`
        SELECT COUNT(*) AS count
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),
      (0, import_database.query)(`
        SELECT
          ve.customer_number, ve.customer_name, ve.numero_nf, ve.data_faturamento,
          ve.descricao_produto, ve.categoria, ve.subcategoria, ve.categoria_total_sku,
          ve.soma_caixas, ve.soma_litros, ve.valor_nf,
          ve.canal_cliente, ve.segmentacao_cliente, ve.city,
          v.nome AS vendedor_nome
        FROM vendas ve
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
      dados: rowsQ.rows
    });
  } catch (err) {
    console.error("[vendas/get]", err);
    res.status(500).json({ erro: "Erro ao listar vendas." });
  }
});
var vendasRoutes_default = router;
