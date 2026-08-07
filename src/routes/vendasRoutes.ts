// vendasRoutes.ts — MySQL 8.0 — v5 (dashboard aceita segmentacao)
//
// CONTRATO DE SINAL (schema v4):
//   vw_vendas_validas   → só VENDA,     magnitude POSITIVA
//   vw_vendas_devolucao → só DEVOLUCAO, magnitude POSITIVA
//   vw_vendas_liquidas  → união, devolução NEGATIVA (SUM já é líquido)
//
// KPI: liquido = validas − devolucao, subtração EXPLÍCITA no back.
// Agregações por grupo usam vw_vendas_liquidas (sem UNION manual).
//
// [v5] /dashboard agora lê `segmentacao` (segmentacao_cliente) e aplica em
//   TODAS as consultas de VENDAS (KPIs, devoluções, resumo, clientes, evolução
//   de faturamento e Take Home × Impulso). Assim o front pode fazer as séries
//   de 6 meses reagirem à segmentação. A RUPTURA (vw_ruptura_avaliada) NÃO é
//   filtrada por segmentação por padrão — ver nota na query de evolução.
import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';

const router = Router();

const MES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const MES_NOME = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];
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
// GET /vendas/dashboard?mes=7&ano=2026&canal=OOH&segmentacao=A&agrupar=categoria&busca=x
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard', authMiddleware, ownDataOnly, async (req, res) => {
  try {
    const mes = Number(req.query.mes);
    const ano = Number(req.query.ano);
    if (!Number.isFinite(mes) || mes < 1 || mes > 12 || !Number.isFinite(ano)) {
      return res.status(400).json({ erro: 'Parâmetros mes/ano inválidos.' });
    }

    const canal       = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw    = req.query.busca ? String(req.query.busca).trim() : '';
    const busca       = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const agrupar     = String(req.query.agrupar ?? 'categoria') === 'vendedor' ? 'vendedor' : 'categoria';
    const topN        = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId        = req.filtroVendedor ?? null;

    const grupoExpr = agrupar === 'vendedor'
      ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))`
      : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;

    // Um WHERE só: as três views compartilham o mesmo contrato de colunas.
    // [v5] +segmentacao_cliente (existe em vw_vendas_*; ver rota GET / abaixo).
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
    const periodoIn = months.map(() => '(?, ?)').join(', ');
    const periodoParams = months.flatMap(m => [m.mes, m.ano]);

    // [v5] +segmentacao_cliente nas séries multi-mês (faturamento + tipos).
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
           -- [v5] Segmentação NÃO é aplicada à ruptura por padrão: depende de
            -- vw_ruptura_avaliada expor 'segmentacao_cliente'. Se essa coluna
            -- EXISTIR na view, descomente as DUAS linhas abaixo E adicione
            -- 'segmentacao, segmentacao' ANTES de 'busca, busca, busca' no
            -- bloco de params da ruptura (marcado mais abaixo) para a linha de
            -- ruptura % também reagir à segmentação:
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
        ...periodoParams, ...periodoParams,
        ...periodoParams, ...filtroPeriodoParams,
        // ── Params da ruptura ──
        // Se ativar o filtro de segmentação na ruptura (acima), insira
        // `segmentacao, segmentacao,` logo após `canal, canal,` nesta linha:
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
      periodo: { mes, ano, canal, segmentacao, agrupar },
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
    if ((mes !== null && !Number.isInteger(mes)) || (ano !== null && !Number.isInteger(ano))) {
      return res.status(400).json({ erro: 'Parâmetros mes/ano inválidos.' });
    }
    const canal       = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw    = req.query.busca ? String(req.query.busca).trim() : '';
    const busca       = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const isExport    = String(req.query.export ?? '') === 'true';
    const incluirDev  = String(req.query.incluir_devolucoes ?? 'true') !== 'false';

    // vendedor_id da query precisa ser escalar numérico — repetir o parâmetro
    // na URL chega como array e viraria SQL inválido.
    const vendedorQuery = req.query.vendedor_id !== undefined && req.query.vendedor_id !== ''
      ? Number(req.query.vendedor_id)
      : null;
    if (vendedorQuery !== null && !Number.isFinite(vendedorQuery)) {
      return res.status(400).json({ erro: 'Parâmetro vendedor_id inválido.' });
    }
    const fvId   = req.filtroVendedor ?? vendedorQuery;
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendas/comparativo-anual?ano=2026&canal=OOH&segmentacao=A&busca=x
//
// Versão ANUAL da "Evolução Mensal — Faturamento vs Ruptura (%)": em vez dos 6
// meses corridos de /dashboard, devolve os 12 slots fixos (jan–dez) do ano
// pedido lado a lado com o MESMO mês do ano anterior — mesma ideia do
// /dashboard/comparativo-anual, só que carregando também a ruptura % dos dois
// anos.
//
// Duas queries independentes (vendas e ruptura) casadas em memória por
// "ano-mes": um JOIN no SQL exigiria uma tabela de calendário, e o volume aqui
// é de 24 linhas por lado.
//
// Contrato de sinal (schema v4): vw_vendas_liquidas traz devolução NEGATIVA,
// então SUM(valor_nf) já é o líquido.
//
// Ruptura: `null` (não 0) quando a base avaliada do mês é zero — mês futuro ou
// sem roster importado não tem ruptura "de 0%", tem ruptura indefinida. O front
// usa connectNulls={false} para não desenhar o ponto.
//
// [v6] Diferente da evolução de 6 meses do /dashboard, aqui a segmentação É
// aplicada à ruptura: vw_ruptura_avaliada expõe segmentacao_cliente (vem do
// LEFT JOIN clientes), então as duas séries reagem ao mesmo filtro.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/comparativo-anual', authMiddleware, ownDataOnly, async (req, res) => {
  try {
    // Fallback para o ano corrente só quando o parâmetro está AUSENTE —
    // `Number(x) || fallback` engoliria ano=abc e ano=0 em silêncio, e sem o
    // isInteger um ano=2026.5 passaria e devolveria 12 meses zerados com 200.
    const anoAtual = req.query.ano === undefined || req.query.ano === ''
      ? new Date().getFullYear()
      : Number(req.query.ano);
    if (!Number.isInteger(anoAtual) || anoAtual < 1900 || anoAtual > 3000) {
      return res.status(400).json({ erro: 'Parâmetro ano inválido.' });
    }
    const anoAnterior = anoAtual - 1;

    const canal       = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw    = req.query.busca ? String(req.query.busca).trim() : '';
    const busca       = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;

    // Mesmo fallback do GET / — sem ele o admin filtra a tabela por vendedor e
    // este gráfico ignora o filtro na mesma tela.
    const vendedorQuery = req.query.vendedor_id !== undefined && req.query.vendedor_id !== ''
      ? Number(req.query.vendedor_id)
      : null;
    if (vendedorQuery !== null && !Number.isFinite(vendedorQuery)) {
      return res.status(400).json({ erro: 'Parâmetro vendedor_id inválido.' });
    }
    const fvId        = req.filtroVendedor ?? vendedorQuery;

    const [vendasQ, rupturaQ] = await Promise.all([
      // ── Faturamento LÍQUIDO por (ano, mês) — os dois anos de uma vez ──────
      query(`
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
        ${busca ? `LEFT JOIN vendedores v ON v.id = ve.vendedor_id` : ''}
        WHERE ve.ano IN (?, ?)
          AND (? IS NULL OR ve.vendedor_id         = ?)
          AND (? IS NULL OR ve.canal_cliente       = ?)
          AND (? IS NULL OR ve.segmentacao_cliente = ?)
          ${busca ? `AND (
                ve.customer_name                 LIKE CONCAT('%', ?, '%')
             OR CAST(ve.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
             OR v.nome                           LIKE CONCAT('%', ?, '%')
             OR ve.descricao_produto             LIKE CONCAT('%', ?, '%')
          )` : ''}
        GROUP BY ve.ano, ve.mes_numero
      `, [
        anoAnterior, anoAtual,
        fvId, fvId, canal, canal, segmentacao, segmentacao,
        ...(busca ? [busca, busca, busca, busca] : []),
      ]),

      // ── Ruptura por (ano, mês) — mesma fórmula de vw_ruptura_kpi_mensal ───
      query(`
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
          )` : ''}
        GROUP BY ra.ano, ra.mes_numero
      `, [
        anoAnterior, anoAtual,
        fvId, fvId, canal, canal, segmentacao, segmentacao,
        ...(busca ? [busca, busca, busca] : []),
      ]),
    ]);

    const chave = (ano: number, mes: number) => `${ano}-${mes}`;
    const vendasMap  = new Map<string, any>(vendasQ.rows.map((r: any) => [chave(num(r.ano), num(r.mes_numero)), r]));
    const rupturaMap = new Map<string, any>(rupturaQ.rows.map((r: any) => [chave(num(r.ano), num(r.mes_numero)), r]));

    // Ruptura % do mês, ou null quando não há base avaliada.
    const pctRuptura = (r: any): number | null => {
      const base = num(r?.base);
      if (base <= 0) return null;
      return (num(r?.rupturas) / base) * 100;
    };

    const meses = Array.from({ length: 12 }, (_, i) => {
      const mesNumero = i + 1;
      const vAtual    = vendasMap.get(chave(anoAtual, mesNumero));
      const vAnterior = vendasMap.get(chave(anoAnterior, mesNumero));
      const rAtual    = rupturaMap.get(chave(anoAtual, mesNumero));
      const rAnterior = rupturaMap.get(chave(anoAnterior, mesNumero));

      const valorAtual    = num(vAtual?.valor);
      const valorAnterior = num(vAnterior?.valor);

      // Sem base POSITIVA no ano anterior o crescimento não é definível — null,
      // não ∞; denominador negativo (mês só com devoluções) inverteria o sinal
      // e mostraria queda numa recuperação.
      const variacaoPct = valorAnterior > 0
        ? ((valorAtual - valorAnterior) / valorAnterior) * 100
        : null;

      const rupturaAtual    = pctRuptura(rAtual);
      const rupturaAnterior = pctRuptura(rAnterior);

      // Ruptura é um percentual: a diferença entre dois anos vai em PONTOS
      // PERCENTUAIS, não em variação relativa.
      const rupturaDeltaPp = rupturaAtual != null && rupturaAnterior != null
        ? rupturaAtual - rupturaAnterior
        : null;

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
        rupturas_anterior: num(rAnterior?.rupturas),
      };
    });

    // Janela comparável: até o último mês do ano pedido que tem dado (venda ou
    // base de ruptura). Somar os 12 slots compararia um ano PARCIAL com o
    // anterior COMPLETO — em agosto isso mostraria uma "queda" anual de ~40%
    // que não existe.
    const ultimoMesComDado = meses.reduce(
      (ult, m) => (m.valor_atual !== 0 || m.bruto_atual !== 0 || m.base_atual > 0) ? m.mes_numero : ult,
      0
    );
    const janela = meses.slice(0, ultimoMesComDado);

    const totalAtual    = janela.reduce((s, m) => s + m.valor_atual, 0);
    const totalAnterior = janela.reduce((s, m) => s + m.valor_anterior, 0);
    const variacaoAnual = totalAnterior > 0
      ? ((totalAtual - totalAnterior) / totalAnterior) * 100
      : null;

    // Ruptura do ano = soma das rupturas ÷ soma das bases (média PONDERADA).
    // Média simples dos 12 percentuais daria peso igual a um mês com 20
    // clientes na base e a outro com 2.000.
    const rupturaAno = (bases: number, rupturas: number): number | null =>
      bases > 0 ? (rupturas / bases) * 100 : null;

    const baseAtual        = janela.reduce((s, m) => s + m.base_atual, 0);
    const baseAnterior     = janela.reduce((s, m) => s + m.base_anterior, 0);
    const rupturasAtual    = janela.reduce((s, m) => s + m.rupturas_atual, 0);
    const rupturasAnterior = janela.reduce((s, m) => s + m.rupturas_anterior, 0);

    const rupturaMediaAtual    = rupturaAno(baseAtual, rupturasAtual);
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
      ruptura_delta_pp: rupturaMediaAtual != null && rupturaMediaAnterior != null
        ? rupturaMediaAtual - rupturaMediaAnterior
        : null,
      meses,
    });
  } catch (err) {
    console.error('[vendas/comparativo-anual]', err);
    res.status(500).json({ erro: 'Erro ao carregar comparativo anual de vendas.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /vendas/relatorio?ano=2026&mes_inicio=1&mes_fim=7&canal=&segmentacao=&busca=&agrupar=
//
// Relatório CONSOLIDADO de um INTERVALO de meses (dentro de um ano) para os
// exports Excel/PDF da tela de Vendas. Uma chamada devolve tudo que o arquivo
// precisa — KPIs líquidos, resumo por grupo, ranking de clientes, evolução mês
// a mês (faturamento, Take Home × Impulso e ruptura %) e as transações — todos
// respeitando o MESMO conjunto de filtros (canal, segmentação, busca e escopo
// do vendedor via ownDataOnly).
//
// Mesmo contrato de sinal do /dashboard (schema v4):
//   líquido = vw_vendas_validas − vw_vendas_devolucao (subtração explícita);
//   agregações por grupo/mês usam vw_vendas_liquidas (devolução negativa).
//
// Ruptura: diferente da evolução de 6 meses do /dashboard, aqui a segmentação
// É aplicada (vw_ruptura_avaliada expõe segmentacao_cliente — mesmo padrão do
// /comparativo-anual [v6]). Mês sem base avaliada → ruptura_pct null, não 0.
//
// Transações: cap de RELATORIO_MAX_TRANSACOES linhas para não estourar memória
// em intervalos longos; `transacoes.truncado` avisa o front quando o cap corta.
// ─────────────────────────────────────────────────────────────────────────────
const RELATORIO_MAX_TRANSACOES = 100_000;

router.get('/relatorio', authMiddleware, ownDataOnly, async (req, res) => {
  try {
    const ano       = Number(req.query.ano);
    const mesIniRaw = Number(req.query.mes_inicio);
    const mesFimRaw = Number(req.query.mes_fim);
    const mesesOk = [mesIniRaw, mesFimRaw].every(m => Number.isInteger(m) && m >= 1 && m <= 12);
    if (!Number.isInteger(ano) || ano < 1900 || ano > 3000 || !mesesOk) {
      return res.status(400).json({ erro: 'Parâmetros ano/mes_inicio/mes_fim inválidos.' });
    }
    // Intervalo invertido não é erro do usuário final — só normaliza.
    const mesInicio = Math.min(mesIniRaw, mesFimRaw);
    const mesFim    = Math.max(mesIniRaw, mesFimRaw);

    const canal       = req.query.canal ? String(req.query.canal) : null;
    const segmentacao = req.query.segmentacao ? String(req.query.segmentacao) : null;
    const buscaRaw    = req.query.busca ? String(req.query.busca).trim() : '';
    const busca       = buscaRaw ? buscaRaw.replace(/[\\%_]/g, '\\$&') : null;
    const agrupar     = String(req.query.agrupar ?? 'categoria') === 'vendedor' ? 'vendedor' : 'categoria';
    const topN        = Math.min(Math.max(Number(req.query.top_n) || 10, 1), 50);
    const fvId        = req.filtroVendedor ?? null;

    const grupoExpr = agrupar === 'vendedor'
      ? `TRIM(REPLACE(COALESCE(v.nome, 'Sem vendedor'), '_Logica MG', ''))`
      : `COALESCE(NULLIF(TRIM(ve.categoria), ''), 'Sem categoria')`;

    // Um WHERE só para as três views de vendas (mesmo contrato de colunas).
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
      ano, mesInicio, mesFim, fvId, fvId, canal, canal,
      segmentacao, segmentacao, busca, busca, busca, busca, busca,
    ];

    const [kpisQ, devQ, resumoQ, clientesQ, mensalQ, rupturaQ, transTotalQ, transQ] = await Promise.all([
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

      // ── DEVOLUÇÕES — magnitude positiva ─────────────────────────────────
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

      // ── Resumo LÍQUIDO por grupo (geral + Take Home/Impulso) ────────────
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

      // ── Ranking de clientes LÍQUIDO do intervalo ────────────────────────
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

      // ── Evolução mês a mês do intervalo (líquido + tipos numa query só) ─
      query(`
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
      query(`
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
        ano, mesInicio, mesFim, fvId, fvId, canal, canal,
        segmentacao, segmentacao, busca, busca, busca, busca,
      ]),

      // ── Total de transações do filtro (para sinalizar truncamento) ──────
      query(`
        SELECT COUNT(*) AS count
        FROM vw_vendas_liquidas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),

      // ── Transações do intervalo (valor_nf já com sinal correto) ─────────
      query(`
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
      `, [...baseParams, RELATORIO_MAX_TRANSACOES]),
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

    const mensalMap  = new Map(mensalQ.rows.map((r: any) => [num(r.mes_numero), r]));
    const rupturaMap = new Map(rupturaQ.rows.map((r: any) => [num(r.mes_numero), r]));

    const evolucao = Array.from({ length: mesFim - mesInicio + 1 }, (_, i) => {
      const mesNumero = mesInicio + i;
      const m: any = mensalMap.get(mesNumero);
      const r: any = rupturaMap.get(mesNumero);
      const base = num(r?.base);
      return {
        mes: mesNumero,
        ano,
        label: `${MES_ABREV[mesNumero - 1]}/${String(ano).slice(2)}`,
        valor:            num(m?.valor),
        valor_bruto:      num(m?.valor_bruto),
        valor_devolucoes: num(m?.valor_devolucoes),
        caixas:           num(m?.caixas),
        clientes:         num(m?.clientes),
        take_home:        num(m?.take_home),
        impulso:          num(m?.impulso),
        // Mês sem base avaliada (futuro / sem roster) tem ruptura INDEFINIDA.
        ruptura_pct: base > 0 ? (num(r?.rupturas) / base) * 100 : null,
      };
    });

    const totalTransacoes = num(transTotalQ.rows[0]?.count);
    const labelPeriodo = mesInicio === mesFim
      ? `${MES_NOME[mesInicio - 1]}/${ano}`
      : `${MES_NOME[mesInicio - 1]} a ${MES_NOME[mesFim - 1]}/${ano}`;

    res.json({
      periodo: {
        ano, mes_inicio: mesInicio, mes_fim: mesFim,
        label: labelPeriodo,
        canal, segmentacao, busca: buscaRaw || null, agrupar,
      },
      kpis: {
        faturamento, caixas, litros, clientes,
        transacoes: num(k.transacoes),

        faturamento_bruto: faturamentoBruto,
        caixas_brutas:     caixasBrutas,
        litros_brutos:     litrosBrutos,

        devolucoes_valor:       devolucoesValor,
        devolucoes_caixas:      devolucoesCaixas,
        devolucoes_litros:      devolucoesLitros,
        devolucoes_transacoes:  num(d.devolucoes_transacoes),
        clientes_com_devolucao: num(d.clientes_com_devolucao),
        pct_devolucao: faturamentoBruto > 0
          ? (devolucoesValor / faturamentoBruto) * 100
          : 0,

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
      transacoes: {
        total:    totalTransacoes,
        truncado: totalTransacoes > RELATORIO_MAX_TRANSACOES,
        dados:    transQ.rows,
      },
    });
  } catch (err) {
    console.error('[vendas/relatorio]', err);
    res.status(500).json({ erro: 'Erro ao gerar relatório de vendas.' });
  }
});

export default router;