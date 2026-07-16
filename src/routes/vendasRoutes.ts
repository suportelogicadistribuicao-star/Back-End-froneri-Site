// vendasRoutes.ts — MySQL 8.0
import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';

const router = Router();

const MES_ABREV = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const EVOLUTION_MONTHS = 6;

// Vendedor "casa" (conta administrativa) — nunca entra em cálculo de ruptura.
const VENDEDOR_EXCLUIDO_RUPTURA = 'adm_logica mg';

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

    const baseWhere = `
      WHERE ve.mes_numero   = ?
        AND ve.ano          = ?
        AND ve.status_venda = 'VENDA'
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
    // IMPORTANTE: a `busca` agora TAMBÉM é aplicada aqui — antes o gráfico de
    // evolução ignorava o filtro por SOLD/cliente/produto.
    const filtroPeriodoVendas = `
        AND ve.status_venda = 'VENDA'
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
          COUNT(DISTINCT ve.customer_number) AS clientes,
          COUNT(*)                           AS transacoes
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
      `, baseParams),

      // ── Resumo (mantido para Excel/PDF): geral + Take Home + Impulso ────
      query(`
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

      // ── Ranking de clientes ──────────────────────────────────────────────
      query(`
        SELECT ve.customer_number            AS sold,
               MAX(ve.customer_name)         AS nome,
               COALESCE(SUM(ve.valor_nf), 0) AS valor
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${baseWhere}
        GROUP BY ve.customer_number
        ORDER BY valor DESC
      `, baseParams),

      // ── Evolução: faturamento + ruptura % dos últimos 6 meses ───────────
      // A % de ruptura agora segue EXATAMENTE a mesma lógica da página de
      // Ruptura (fórmula da aba "Venda Vendedor" do Excel — ver rupturaExcel.ts):
      //
      //   Ruptura % = 100 × (1 − ComCompra ÷ base avaliada)
      //             = 100 × rupturas ÷ base avaliada
      //
      //   base avaliada = registros de `ruptura` do mês, EXCLUINDO:
      //     • status_ruptura 'Cliente Novo' e 'SEM KV' (fora da base);
      //     • vendedor administrativo ADM_Logica MG;
      //     • Regra Froneri: cliente desativado no mês (status 'I'/'S' no
      //       snapshot `clientes_historico_mensal`; sem registro = ativo,
      //       equivalente ao clienteAtivoNoMes() do front).
      //   rupturas = base avaliada com status_ruptura <> 'C/ Compra'.
      //
      // Precisão: ROUND(..., 2) — antes arredondava para inteiro.
      query(`
        SELECT p.mes_numero, p.ano,
               COALESCE(f.valor, 0) AS valor,
               COALESCE(ROUND(100 * rp.rupturas / NULLIF(rp.base, 0), 2), 0) AS ruptura_pct
        FROM (
          SELECT DISTINCT mes_numero, ano
          FROM vendas
          WHERE (mes_numero, ano) IN (${periodoIn})
          UNION
          SELECT DISTINCT mes_numero, ano
          FROM ruptura
          WHERE (mes_numero, ano) IN (${periodoIn})
        ) p
        LEFT JOIN (
          SELECT ve.mes_numero, ve.ano, COALESCE(SUM(ve.valor_nf), 0) AS valor
          FROM vendas ve
          LEFT JOIN vendedores v ON v.id = ve.vendedor_id
          WHERE (ve.mes_numero, ve.ano) IN (${periodoIn})
            ${filtroPeriodoVendas}
          GROUP BY ve.mes_numero, ve.ano
        ) f ON f.mes_numero = p.mes_numero AND f.ano = p.ano
        LEFT JOIN (
          SELECT r.mes_numero, r.ano,
                 SUM(CASE WHEN UPPER(TRIM(COALESCE(r.status_ruptura, ''))) NOT IN ('CLIENTE NOVO', 'SEM KV')
                           AND UPPER(TRIM(COALESCE(r.status_ruptura, ''))) <> 'C/ COMPRA'
                          THEN 1 ELSE 0 END) AS rupturas,
                 SUM(CASE WHEN UPPER(TRIM(COALESCE(r.status_ruptura, ''))) NOT IN ('CLIENTE NOVO', 'SEM KV')
                          THEN 1 ELSE 0 END) AS base
          FROM ruptura r
          JOIN clientes c ON c.customer_number = r.customer_number
          LEFT JOIN vendedores v ON v.id = r.vendedor_id
          LEFT JOIN clientes_historico_mensal h
                 ON h.customer_number = r.customer_number
                AND h.mes_numero      = r.mes_numero
                AND h.ano             = r.ano
          WHERE (r.mes_numero, r.ano) IN (${periodoIn})
            AND LOWER(TRIM(COALESCE(v.nome, ''))) <> '${VENDEDOR_EXCLUIDO_RUPTURA}'
            -- Regra Froneri: sem snapshot = ativo; com snapshot, só status 'C'.
            AND (h.status IS NULL OR h.status = 'C')
            AND (? IS NULL OR r.vendedor_id   = ?)
            AND (? IS NULL OR c.canal_cliente = ?)
            AND (? IS NULL OR (
                  c.customer_name                 LIKE CONCAT('%', ?, '%')
               OR CAST(c.customer_number AS CHAR) LIKE CONCAT('%', ?, '%')
               OR v.nome                          LIKE CONCAT('%', ?, '%')
            ))
          GROUP BY r.mes_numero, r.ano
        ) rp ON rp.mes_numero = p.mes_numero AND rp.ano = p.ano
        ORDER BY p.ano, p.mes_numero
      `, [
        ...periodoParams, ...periodoParams,
        ...periodoParams, ...filtroPeriodoParams,
        ...periodoParams, fvId, fvId, canal, canal, busca, busca, busca, busca,
      ]),

      // ── NOVO: Take Home x Impulso agregados POR MÊS (últimos 6 meses) ───
      // Substitui os dois gráficos por categoria: uma linha por mês com o
      // total de tudo que é Take Home e tudo que é Impulso no período.
      query(`
        SELECT ve.mes_numero, ve.ano,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'TAKE HOME'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS take_home,
               COALESCE(SUM(CASE WHEN UPPER(TRIM(ve.categoria_total_sku)) = 'IMPULSO'
                                 THEN ve.valor_nf ELSE 0 END), 0) AS impulso
        FROM vendas ve
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

    const whereSql = `
      WHERE ve.status_venda = 'VENDA'
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

    const [totalQ, rowsQ] = await Promise.all([
      query(`
        SELECT COUNT(*) AS count
        FROM vendas ve
        LEFT JOIN vendedores v ON v.id = ve.vendedor_id
        ${whereSql}
      `, params),
      query(`
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