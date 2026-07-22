// vendasRoutes.ts — MySQL 8.0 — v4 (views separadas VENDA × DEVOLUCAO)
//
// CONTRATO DE SINAL (schema v4):
//   vw_vendas_validas   → só VENDA,     magnitude POSITIVA
//   vw_vendas_devolucao → só DEVOLUCAO, magnitude POSITIVA
//   vw_vendas_liquidas  → união, devolução NEGATIVA (SUM já é líquido)
//
// KPI: liquido = validas − devolucao, subtração EXPLÍCITA no back.
// Agregações por grupo usam vw_vendas_liquidas (sem UNION manual).
import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';

const router = Router();

const MES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const EVOLUTION_MONTHS = 6;

function lastMonths(mes: number, ano: number, count: number) {
  const out: { mes: number; ano: number; label: string }[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(ano, mes - 1 - i, 1);
    out.push({
      mes: d.getMonth() + 1,
      ano: d.getFullYear(),
      label: `${MES_ABREV[d.getMonth()]}/${String(d.getFullYear()).slice(2)}`,
    });
  }
  return out;
}

const num = (x: unknown) => Number(x ?? 0);

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendas/dashboard?mes=7&ano=2026&canal=OOH&agrupar=categoria&busca=x
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', authMiddleware, ownDataOnly, async (req, res) => {
  try {
    const mes = Number(req.query.mes);
    const ano = Number(req.query.ano);
    if (!Number.isFinite(mes) || mes < 1 || mes > 12 || !Number.isFinite(ano)) {
      return res.status(400).json({ erro: 'Parâmetros mes/ano inválidos.' });
    }

    const canal    = req.query.canal ? String(req.query.canal) : null;
    const buscaRaw = req.query.busca ? String(req.query.busca).trim() : '';
    const busca    = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const agrupar  = String(req.query.agrupar ?? 'categoria') === 'vendedor' ? 'vendedor' : 'categoria';
    const topN     = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId     = req.filtroVendedor ?? null;

    const grupoExpr = agrupar === 'vendedor'
      ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))`
      : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;

    // Um WHERE só: as três views compartilham o mesmo contrato de colunas.
    const baseWhere = `
      WHERE ve.mes_numero = ?
        AND ve.ano        = ?
        AND (? IS NULL OR ve.vendedor_id   = ?)
        AND (? IS NULL OR ve.canal_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const baseParams = [mes, ano, fvId, fvId, canal, canal, busca, busca, busca, busca, busca];

    const months = lastMonths(mes, ano, EVOLUTION_MONTHS);
    const periodoIn = months.map(() => '(?, ?)').join(', ');
    const periodoParams = months.flatMap(m => [m.mes, m.ano]);

    const filtroPeriodo = `
        AND (? IS NULL OR ve.vendedor_id   = ?)
        AND (? IS NULL OR ve.canal_cliente = ?)
        AND (? IS NULL OR (
              ve.customer_name                 LIKE CONCAT('%', ?, '%')
           OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
           OR v.nome                           LIKE CONCAT('%', ?, '%')
           OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
        ))
    `;
    const filtroPeriodoParams = [fvId, fvId, canal, canal, busca, busca, busca, busca, busca];

    const [kpisQ, devQ, resumoQ, clientesQ, evolucaoQ, tiposMensalQ] = await Promise.all([
      // ── BRUTO — só VENDA ────────────────────────────────────────────────
      query(`
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
      query(`
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
      query(`
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
      query(`
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
      query(`
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
            AND (? IS NULL OR (
                  ra.customer_name                 LIKE CONCAT('%', ?, '%')
               OR CAST(ra.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
               OR ra.vendedor_nome                 LIKE CONCAT('%', ?, '%')
            ))
          GROUP BY ra.mes_numero, ra.ano
        ) rp ON rp.mes_numero = p.mes_numero AND rp.ano = p.ano
        ORDER BY p.ano, p.mes_numero
      `, [
        ...periodoParams, ...periodoParams,
        ...periodoParams, ...filtroPeriodoParams,
        ...periodoParams, fvId, fvId, canal, canal, busca, busca, busca, busca,
      ]),

      // ── Take Home × Impulso LÍQUIDOS por mês ────────────────────────────
      query(`
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
      `, [...periodoParams, ...filtroPeriodoParams]),
    ]);

    // ── LÍQUIDO = BRUTO − DEVOLUÇÕES ──────────────────────────────────────
    const k = kpisQ.rows[0] ?? {};
    const d = devQ.rows[0] ?? {};

    const faturamentoBruto = num(k.faturamento_bruto);
    const caixasBrutas     = num(k.caixas_brutas);
    const litrosBrutos     = num(k.litros_brutos);
    const clientes         = num(k.clientes);

    const devolucoesValor  = num(d.devolucoes_valor);
    const devolucoesCaixas = num(d.devolucoes_caixas);
    const devolucoesLitros = num(d.devolucoes_litros);

    const faturamento = faturamentoBruto - devolucoesValor;
    const caixas      = caixasBrutas     - devolucoesCaixas;
    const litros      = litrosBrutos     - devolucoesLitros;

    const linhas = resumoQ.rows.map((r: any) => ({
      tipo:     String(r.tipo ?? ''),
      grupo:    String(r.grupo ?? ''),
      valor_nf: num(r.valor_nf),
      caixas:   num(r.caixas),
      litros:   num(r.litros),
      clientes: num(r.clientes),
    }));
    const porTipo = (t: string) =>
      linhas.filter(l => l.tipo === t).map(({ tipo: _t, ...rest }) => rest);

    const rankingClientes = clientesQ.rows.map((c: any) => ({
      sold:             c.sold,
      nome:             String(c.nome ?? '—'),
      valor:            num(c.valor),
      valor_bruto:      num(c.valor_bruto),
      valor_devolucoes: num(c.valor_devolucoes),
    }));

    const evoMap = new Map(evolucaoQ.rows.map((r: any) => [`${r.ano}-${r.mes_numero}`, r]));
    const evolucao = months.map(m => {
      const r: any = evoMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes, ano: m.ano, label: m.label,
        valor:            num(r?.valor),
        valor_bruto:      num(r?.valor_bruto),
        valor_devolucoes: num(r?.valor_devolucoes),
        ruptura_pct:      num(r?.ruptura_pct),
      };
    });

    const tiposMap = new Map(tiposMensalQ.rows.map((r: any) => [`${r.ano}-${r.mes_numero}`, r]));
    const evolucaoTipos = months.map(m => {
      const r: any = tiposMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes, ano: m.ano, label: m.label,
        take_home: num(r?.take_home),
        impulso:   num(r?.impulso),
      };
    });

    res.json({
      periodo: { mes, ano, canal, agrupar },
      kpis: {
        // Líquidos — devolução já abatida.
        faturamento, caixas, litros, clientes,
        transacoes: num(k.transacoes),

        // Brutos — composição do número.
        faturamento_bruto: faturamentoBruto,
        caixas_brutas:     caixasBrutas,
        litros_brutos:     litrosBrutos,

        // Devoluções — magnitude POSITIVA.
        devolucoes_valor:       devolucoesValor,
        devolucoes_caixas:      devolucoesCaixas,
        devolucoes_litros:      devolucoesLitros,
        devolucoes_transacoes:  num(d.devolucoes_transacoes),
        clientes_com_devolucao: num(d.clientes_com_devolucao),
        pct_devolucao: faturamentoBruto > 0
          ? (devolucoesValor / faturamentoBruto) * 100
          : 0,

        // Médias sobre o LÍQUIDO.
        ticket_medio:       clientes > 0 ? faturamento / clientes : 0,
        caixas_por_cliente: clientes > 0 ? caixas / clientes : 0,
      },
      resumo: {
        geral:     porTipo('__GERAL__'),
        take_home: porTipo('TAKE HOME'),
        impulso:   porTipo('IMPULSO'),
      },
      top_clientes:     rankingClientes.slice(0, topN),
      ranking_clientes: rankingClientes,
      evolucao,
      evolucao_tipos:   evolucaoTipos,
    });
  } catch (err) {
    console.error('[vendas/dashboard]', err);
    res.status(500).json({ erro: 'Erro ao carregar dashboard de vendas.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendas — transações paginadas. Lê vw_vendas_liquidas para que a soma
// das linhas exibidas bata com o KPI do dashboard (devolução vem negativa).
// incluir_devolucoes=false volta ao comportamento antigo (só VENDA).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
  try {
    const mes         = req.query.mes ? Number(req.query.mes) : null;
    const ano         = req.query.ano ? Number(req.query.ano) : null;
    const canal       = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw    = req.query.busca ? String(req.query.busca).trim() : '';
    const busca       = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const isExport    = String(req.query.export ?? '') === 'true';
    const incluirDev  = String(req.query.incluir_devolucoes ?? 'true') !== 'false';

    const fvId   = req.filtroVendedor ?? req.query.vendedor_id ?? null;
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const limit  = isExport ? 50000 : Math.min(Math.max(Number(req.query.limit) || 30, 1), 500);
    const offset = isExport ? 0 : (page - 1) * limit;

    // Whitelist de view — nunca interpolar entrada do usuário.
    const fonte = incluirDev ? 'vw_vendas_liquidas' : 'vw_vendas_validas';
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
      mes, mes, ano, ano, fvId, fvId, canal, canal,
      segmentacao, segmentacao, busca, busca, busca, busca, busca,
    ];

    const [totalQ, totaisQ, rowsQ] = await Promise.all([
      query(`
        SELECT COUNT(*) AS count
        FROM ${fonte} ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),

      // Totais do filtro inteiro (não só da página).
      query(`
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
      query(`
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
      `, [...params, limit, offset]),
    ]);

    res.json({
      total:  Number(totalQ.rows[0].count),
      pagina: page,
      limite: limit,
      totais: {
        valor_liquido:    num(totaisQ.rows[0]?.valor_liquido),
        caixas_liquidas:  num(totaisQ.rows[0]?.caixas_liquidas),
        valor_bruto:      num(totaisQ.rows[0]?.valor_bruto),
        valor_devolucoes: num(totaisQ.rows[0]?.valor_devolucoes),
      },
      dados: rowsQ.rows,
    });
  } catch (err) {
    console.error('[vendas/get]', err);
    res.status(500).json({ erro: 'Erro ao listar vendas.' });
  }
});

export default router;