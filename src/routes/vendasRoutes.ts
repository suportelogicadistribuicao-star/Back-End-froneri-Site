// vendasRoutes.ts — MySQL 8.0 — v3 (views canônicas)
//
// MUDANÇAS DA FASE 2:
//   • Todas as leituras de vendas passam por vw_vendas_validas
//     (status_venda = 'VENDA' garantido pela view) — some o filtro repetido.
//   • A % de ruptura da Evolução Mensal agora é um SELECT simples em
//     vw_ruptura_avaliada. A regra (snapshot da Regra Froneri, exclusão de
//     Cliente Novo / SEM KV da base, exclusão do ADM_Logica MG) mora SÓ na
//     view — este arquivo não reimplementa mais nada em SQL.
//   • ruptura_pct sai SEM arredondar (antes ROUND(...,2)). A formatação de
//     exibição decide as casas decimais (fase 3).
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
    // Escapa curingas do LIKE — senão "%" do usuário casa com tudo.
    const busca    = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const agrupar  = String(req.query.agrupar ?? 'categoria') === 'vendedor' ? 'vendedor' : 'categoria';
    const topN     = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId     = req.filtroVendedor ?? null;   // CHAR(36) UUID

    // Whitelist — nunca interpolar entrada do usuário em SQL.
    const grupoExpr = agrupar === 'vendedor'
      ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))`
      : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;

    // vw_vendas_validas já garante status_venda = 'VENDA'.
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

    // Mesmo bloco de filtros das queries por período (janela de 6 meses).
    // A `busca` também é aplicada aqui — o gráfico de evolução respeita o
    // filtro por SOLD/cliente/produto.
    const filtroPeriodoVendas = `
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

    const [kpisQ, resumoQ, clientesQ, evolucaoQ, tiposMensalQ] = await Promise.all([
      // ── KPIs ────────────────────────────────────────────────────────────
      query(`
        SELECT
          COALESCE(SUM(ve.valor_nf), 0)      AS faturamento,
          COALESCE(SUM(ve.soma_caixas), 0)   AS caixas,
          COALESCE(SUM(ve.soma_litros), 0)   AS litros,
          COUNT(DISTINCT CASE WHEN ve.status_venda = 'VENDA'
                                   THEN ve.customer_number END) AS clientes,
          SUM(CASE WHEN ve.status_venda = 'VENDA' THEN 1 ELSE 0 END) AS transacoes,
          COALESCE(SUM(CASE WHEN ve.status_venda = 'DEVOLUCAO'
                            THEN -ve.valor_nf ELSE 0 END), 0) AS devolucoes_valor,
          COALESCE(SUM(CASE WHEN ve.status_venda = 'DEVOLUCAO'
                            THEN -ve.soma_caixas ELSE 0 END), 0) AS devolucoes_caixas
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),

      // ── Resumo (mantido para Excel/PDF): geral + Take Home + Impulso ────
      query(`
        SELECT '__GERAL__' AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0)      AS valor_nf,
               COALESCE(SUM(ve.soma_caixas), 0)   AS caixas,
               COALESCE(SUM(ve.soma_litros), 0)   AS litros,
               COUNT(DISTINCT CASE WHEN ve.status_venda = 'VENDA'
                                   THEN ve.customer_number END) AS clientes
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY grupo

        UNION ALL

        SELECT UPPER(TRIM(ve.categoria_total_sku)) AS tipo, ${grupoExpr} AS grupo,
               COALESCE(SUM(ve.valor_nf), 0),
               COALESCE(SUM(ve.soma_caixas), 0),
               COALESCE(SUM(ve.soma_litros), 0),
               COUNT(DISTINCT CASE WHEN ve.status_venda = 'VENDA'
                                   THEN ve.customer_number END)
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
          AND TRIM(COALESCE(ve.categoria_total_sku, '')) <> ''
        GROUP BY tipo, grupo

        ORDER BY valor_nf DESC
      `, [...baseParams, ...baseParams]),

      // ── Ranking de clientes ──────────────────────────────────────────────
      query(`
        SELECT ve.customer_number            AS sold,
               MAX(CASE WHEN ve.status_venda = 'VENDA'
                        THEN ve.customer_name END) AS nome,
               COALESCE(SUM(ve.valor_nf), 0) AS valor
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.customer_number
        HAVING valor <> 0
        ORDER BY valor DESC
      `, baseParams),

      // ── Evolução: faturamento + ruptura % dos últimos 6 meses ───────────
      // A regra de ruptura mora em vw_ruptura_avaliada (schema v3):
      //   base     = SUM(entra_base)   → exclui Cliente Novo / SEM KV
      //   rupturas = SUM(eh_ruptura)   → base sem 'C/ Compra'
      //   pct      = 100 × rupturas ÷ base — SEM arredondar.
      // Snapshot mensal (Regra Froneri) e exclusão do ADM_Logica MG já
      // estão aplicados dentro da view.
      query(`
        SELECT p.mes_numero, p.ano,
               COALESCE(f.valor, 0) AS valor,
               COALESCE(100 * rp.rupturas / NULLIF(rp.base, 0), 0) AS ruptura_pct
        FROM (
          SELECT DISTINCT mes_numero, ano
          FROM vw_vendas_validas
          WHERE (mes_numero, ano) IN (${periodoIn})
          UNION
          SELECT DISTINCT mes_numero, ano
          FROM vw_ruptura_avaliada
          WHERE (mes_numero, ano) IN (${periodoIn})
        ) p
        LEFT JOIN (
          SELECT ve.mes_numero, ve.ano, COALESCE(SUM(ve.valor_nf), 0) AS valor
          FROM vw_vendas_validas ve
          LEFT JOIN vendedores v ON v.id = ve.vendedor_id
          WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
            ${filtroPeriodoVendas}
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

      // ── Take Home x Impulso agregados POR MÊS (últimos 6 meses) ─────────
      query(`
        SELECT ve.mes_numero, ve.ano,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'TAKE HOME'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS take_home,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'IMPULSO'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS impulso
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
          ${filtroPeriodoVendas}
        GROUP BY ve.mes_numero, ve.ano
        ORDER BY ve.ano, ve.mes_numero
      `, [...periodoParams, ...filtroPeriodoParams]),
    ]);

    // ── Monta a resposta ────────────────────────────────────────────────
    const k = kpisQ.rows[0] ?? {};
    const faturamento = Number(k.faturamento ?? 0);
    const caixas      = Number(k.caixas ?? 0);
    const clientes    = Number(k.clientes ?? 0);

    const linhas = resumoQ.rows.map((r: any) => ({
      tipo:     String(r.tipo ?? ''),
      grupo:    String(r.grupo ?? ''),
      valor_nf: Number(r.valor_nf ?? 0),
      caixas:   Number(r.caixas ?? 0),
      litros:   Number(r.litros ?? 0),
      clientes: Number(r.clientes ?? 0),
    }));
    const porTipo = (t: string) =>
      linhas.filter(l => l.tipo === t).map(({ tipo: _t, ...rest }) => rest);

    const rankingClientes = clientesQ.rows.map((c: any) => ({
      sold:  c.sold,
      nome:  String(c.nome ?? '—'),
      valor: Number(c.valor ?? 0),
    }));

    // Reindexa pelos meses pedidos: garante os 6 pontos mesmo sem dado.
    const evoMap = new Map(
      evolucaoQ.rows.map((r: any) => [`${r.ano}-${r.mes_numero}`, r]),
    );
    const evolucao = months.map(m => {
      const r: any = evoMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes, ano: m.ano, label: m.label,
        valor: Number(r?.valor ?? 0),
        // Valor cheio, sem arredondar — a exibição formata (fase 3).
        ruptura_pct: Number(r?.ruptura_pct ?? 0),
      };
    });

    const tiposMap = new Map(
      tiposMensalQ.rows.map((r: any) => [`${r.ano}-${r.mes_numero}`, r]),
    );
    const evolucaoTipos = months.map(m => {
      const r: any = tiposMap.get(`${m.ano}-${m.mes}`);
      return {
        mes: m.mes, ano: m.ano, label: m.label,
        take_home: Number(r?.take_home ?? 0),
        impulso:   Number(r?.impulso ?? 0),
      };
    });

    res.json({
      periodo: { mes, ano, canal, agrupar },
     kpis: {
        faturamento, caixas,
        litros: Number(k.litros ?? 0),
        clientes,
        transacoes: Number(k.transacoes ?? 0),
        devolucoes_valor:  Number(k.devolucoes_valor ?? 0),
        devolucoes_caixas: Number(k.devolucoes_caixas ?? 0),
        ticket_medio: clientes > 0 ? faturamento / clientes : 0,
        caixas_por_cliente: clientes > 0 ? caixas / clientes : 0,
      },
      resumo: {
        geral:     porTipo('__GERAL__'),
        take_home: porTipo('TAKE HOME'),
        impulso:   porTipo('IMPULSO'),
      },
      top_clientes: rankingClientes.slice(0, topN),
      ranking_clientes: rankingClientes,
      evolucao,
      evolucao_tipos: evolucaoTipos,
    });
  } catch (err) {
    console.error('[vendas/dashboard]', err);
    res.status(500).json({ erro: 'Erro ao carregar dashboard de vendas.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendas — transações paginadas NO BANCO.
// export=true ignora a paginação (Excel/PDF), com teto de segurança.
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

    const fvId   = req.filtroVendedor ?? req.query.vendedor_id ?? null;
    const page   = Math.max(Number(req.query.page) || 1, 1);
    const limit  = isExport ? 50000 : Math.min(Math.max(Number(req.query.limit) || 30, 1), 500);
    const offset = isExport ? 0 : (page - 1) * limit;

    // vw_vendas_validas já garante status_venda = 'VENDA'.
    const whereSql = `
      WHERE (? IS NULL OR ve.mes_numero          = ?)
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

    const [totalQ, rowsQ] = await Promise.all([
      query(`
        SELECT COUNT(*) AS count
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),
      query(`
        SELECT
          ve.customer_number, ve.customer_name, ve.numero_nf, ve.data_faturamento,
          ve.descricao_produto, ve.categoria, ve.subcategoria, ve.categoria_total_sku,
          ve.soma_caixas, ve.soma_litros, ve.valor_nf, ve.status_venda,
          ve.canal_cliente, ve.segmentacao_cliente, ve.city,
          v.nome AS vendedor_nome
        FROM vw_vendas_validas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
        ORDER BY ve.data_faturamento DESC, ve.customer_number, ve.numero_nf
        LIMIT ? OFFSET ?
      `, [...params, limit, offset]),
    ]);

    res.json({
      total: Number(totalQ.rows[0].count),
      pagina: page,
      limite: limit,
      dados: rowsQ.rows,
    });
  } catch (err) {
    console.error('[vendas/get]', err);
    res.status(500).json({ erro: 'Erro ao listar vendas.' });
  }
});

export default router;