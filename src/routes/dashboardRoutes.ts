import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';
import { hasRupturaForPeriodo } from '../services/clientesHistoricoService';

const router = Router();

// CONTRATO DE SINAL (schema v4):
//   vw_vendas_validas   → só VENDA,     magnitude POSITIVA
//   vw_vendas_devolucao → só DEVOLUCAO, magnitude POSITIVA
//   liquido = validas − devolucao  ← a subtração mora AQUI, explícita.
//   vw_vendas_liquidas  → devolução já NEGATIVA (para agregações UNION)

// GET /api/dashboard?mes=6&ano=2026&canal=OOH&segmentacao=A
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const now = new Date();
        const mes = Number(req.query.mes) || now.getMonth() + 1;
        const ano = Number(req.query.ano) || now.getFullYear();
        const canal = (req.query.canal as string) || null;
        const segmentacao = (req.query.segmentacao as string) || null;
        const filtroVendedor = req.filtroVendedor;

        // Um único WHERE serve às três views — contrato de colunas idêntico.
        const p: unknown[] = [ano, mes];
        let vendaWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { p.push(filtroVendedor); vendaWhere += ` AND vendedor_id = $${p.length}`; }
        if (canal)          { p.push(canal);          vendaWhere += ` AND canal_cliente = $${p.length}`; }
        if (segmentacao)    { p.push(segmentacao);    vendaWhere += ` AND segmentacao_cliente = $${p.length}`; }

        const rupturaParams: unknown[] = [ano, mes];
        let rupturaWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { rupturaParams.push(filtroVendedor); rupturaWhere += ` AND vendedor_id = $${rupturaParams.length}`; }
        if (canal)          { rupturaParams.push(canal);          rupturaWhere += ` AND canal_cliente = $${rupturaParams.length}`; }
        if (segmentacao)    { rupturaParams.push(segmentacao);    rupturaWhere += ` AND segmentacao_cliente = $${rupturaParams.length}`; }

        const pedidosParams: unknown[] = [ano, mes];
        let pedidosWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { pedidosParams.push(filtroVendedor); pedidosWhere += ` AND vendedor_id = $${pedidosParams.length}`; }

        const usarHistoricoClientes = await hasRupturaForPeriodo(mes, ano);
        const clientesKPIQuery = usarHistoricoClientes
            ? `
                SELECT
                    COUNT(*)                AS total_ativos,
                    SUM(ra.eh_com_compra)   AS com_compra,
                    SUM(ra.eh_cliente_novo) AS novos,
                    SUM(ra.eh_mais_6_meses) AS criticos,
                    SUM(CASE WHEN c.tem_contrato = TRUE THEN 1 ELSE 0 END) AS com_contrato
                FROM vw_ruptura_avaliada ra
                LEFT JOIN clientes c ON c.customer_number = ra.customer_number
                WHERE ra.mes_numero = $1 AND ra.ano = $2
                ${filtroVendedor ? 'AND ra.vendedor_id = $3' : ''}
            `
            : `
                SELECT
                    COUNT(*) AS total_ativos,
                    COUNT(CASE WHEN nova_rup = 'C/ Compra'    THEN 1 END) AS com_compra,
                    COUNT(CASE WHEN nova_rup = 'Cliente Novo' THEN 1 END) AS novos,
                    COUNT(CASE WHEN nova_rup LIKE '%6 Meses%' THEN 1 END) AS criticos,
                    COUNT(CASE WHEN tem_contrato = TRUE       THEN 1 END) AS com_contrato
                FROM clientes
                WHERE status = 'C'
                ${filtroVendedor ? 'AND vendedor_id = $1' : ''}
            `;
        const clientesKPIParams = usarHistoricoClientes
            ? (filtroVendedor ? [mes, ano, filtroVendedor] : [mes, ano])
            : (filtroVendedor ? [filtroVendedor] : []);

        const [
            vendasKPI,
            devolucoesKPI,
            rupturaKPI,
            clientesKPI,
            pedidosKPI,
            vendasCategoria,
            vendasCanalRes,
            devedoresKPI,
            vendasVendedorRes,
            rupturaVendedorRes,
        ] = await Promise.all([
            // BRUTO — só VENDA.
            query(`
                SELECT
                    COUNT(DISTINCT customer_number) AS clientes_atendidos,
                    COALESCE(SUM(valor_nf), 0)      AS valor_bruto_nf,
                    COALESCE(SUM(valor_vbc), 0)     AS valor_bruto_vbc,
                    COALESCE(SUM(soma_caixas), 0)   AS caixas_brutas,
                    COALESCE(SUM(soma_litros), 0)   AS litros_brutos,
                    COUNT(*)                        AS transacoes
                FROM vw_vendas_validas
                ${vendaWhere}
            `, p),

            // DEVOLUÇÕES — mesmo WHERE, view irmã. Magnitude positiva.
            query(`
                SELECT
                    COALESCE(SUM(valor_nf), 0)    AS valor_devolucoes,
                    COALESCE(SUM(valor_vbc), 0)   AS vbc_devolucoes,
                    COALESCE(SUM(soma_caixas), 0) AS caixas_devolucoes,
                    COALESCE(SUM(soma_litros), 0) AS litros_devolucoes,
                    COUNT(*)                      AS qtd_devolucoes,
                    COUNT(DISTINCT customer_number) AS clientes_com_devolucao
                FROM vw_vendas_devolucao
                ${vendaWhere}
            `, p),

            query(`
                SELECT
                    SUM(eh_ruptura)                                    AS total_ruptura,
                    SUM(entra_base)                                    AS base_avaliada,
                    SUM(eh_com_compra)                                 AS com_compra,
                    SUM(eh_cliente_novo)                               AS clientes_novos,
                    SUM(eh_sem_kv)                                     AS sem_kv,
                    SUM(eh_mais_6_meses)                               AS mais_6_meses,
                    100 * SUM(eh_ruptura) / NULLIF(SUM(entra_base), 0) AS pct_ruptura
                FROM vw_ruptura_avaliada
                ${rupturaWhere}
            `, rupturaParams),

            query(clientesKPIQuery, clientesKPIParams),

            query(`
                SELECT
                    COUNT(DISTINCT customer_number) AS clientes_com_pedido,
                    SUM(extended_amount)            AS valor_carteira,
                    COUNT(*)                        AS total_pedidos
                FROM pedidos_carteira
                ${pedidosWhere}
            `, pedidosParams),

            // Categoria — vw_vendas_liquidas já traz devolução negativa,
            // então SUM() é líquido direto. Sem UNION manual.
            query(`
                SELECT
                    categoria,
                    COALESCE(SUM(valor_nf), 0)    AS valor,
                    COALESCE(SUM(soma_caixas), 0) AS caixas,
                    COALESCE(SUM(CASE WHEN origem_linha = 'VENDA'
                                      THEN valor_nf ELSE 0 END), 0) AS valor_bruto,
                    COALESCE(SUM(CASE WHEN origem_linha = 'DEVOLUCAO'
                                      THEN ABS(valor_nf) ELSE 0 END), 0) AS valor_devolucoes
                FROM vw_vendas_liquidas
                ${vendaWhere}
                GROUP BY categoria
                HAVING SUM(valor_nf) <> 0 OR SUM(soma_caixas) <> 0
                ORDER BY valor DESC
            `, p),

            query(`
                SELECT
                    canal_cliente              AS name,
                    COALESCE(SUM(valor_nf), 0) AS value
                FROM vw_vendas_liquidas
                ${vendaWhere}
                GROUP BY canal_cliente
                HAVING SUM(valor_nf) <> 0
                ORDER BY value DESC
            `, p),

            query(`
                SELECT
                    COUNT(DISTINCT d.documento_cliente) AS total_devedores,
                    SUM(d.valor_titulo_saldo_devedor)   AS valor_total_devedor,
                    MAX(d.dias_em_atraso)               AS max_dias_atraso
                FROM devedores d
                ${filtroVendedor
                    ? 'INNER JOIN clientes c ON c.cnpj = d.documento_cliente AND c.vendedor_id = $1'
                    : ''}
            `, filtroVendedor ? [filtroVendedor] : []),

            // Por vendedor — a view mensal já entrega os três números.
            !filtroVendedor
                ? query(`
                    SELECT
                        v.nome  AS vendedor_nome,
                        v.setor,
                        COALESCE(SUM(kp.valor_liquido), 0)      AS valor_nf,
                        COALESCE(SUM(kp.valor_bruto), 0)        AS valor_bruto,
                        COALESCE(SUM(kp.valor_devolucoes), 0)   AS valor_devolucoes,
                        COALESCE(SUM(kp.clientes_atendidos), 0) AS clientes
                    FROM vendedores v
                    LEFT JOIN vw_vendas_kpi_mensal kp
                           ON kp.vendedor_id = v.id
                          AND kp.mes_numero  = $1
                          AND kp.ano         = $2
                    WHERE v.ativo = TRUE
                    GROUP BY v.id, v.nome, v.setor
                    ORDER BY valor_nf DESC
                `, [mes, ano])
                : Promise.resolve({ rows: [] }),

            !filtroVendedor
                ? query(`
                    SELECT
                        vendedor_id,
                        vendedor_nome,
                        setor,
                        SUM(entra_base)                                    AS base_avaliada,
                        SUM(eh_ruptura)                                    AS rupturas,
                        100 * SUM(eh_ruptura) / NULLIF(SUM(entra_base), 0) AS pct_ruptura
                    FROM vw_ruptura_avaliada
                    ${rupturaWhere}
                    GROUP BY vendedor_id, vendedor_nome, setor
                    HAVING SUM(entra_base) > 0
                    ORDER BY pct_ruptura DESC
                `, rupturaParams)
                : Promise.resolve({ rows: [] }),
        ]);

        // ── LÍQUIDO = BRUTO − DEVOLUÇÕES ────────────────────────────────
        const vb = vendasKPI.rows[0] ?? {};
        const dv = devolucoesKPI.rows[0] ?? {};

        const n = (x: unknown) => Number(x ?? 0);

        const valorBrutoNf  = n(vb.valor_bruto_nf);
        const valorBrutoVbc = n(vb.valor_bruto_vbc);
        const caixasBrutas  = n(vb.caixas_brutas);
        const litrosBrutos  = n(vb.litros_brutos);
        const clientes      = n(vb.clientes_atendidos);

        const valorDevolucoes  = n(dv.valor_devolucoes);
        const vbcDevolucoes    = n(dv.vbc_devolucoes);
        const caixasDevolucoes = n(dv.caixas_devolucoes);
        const litrosDevolucoes = n(dv.litros_devolucoes);

        const valorLiquido = valorBrutoNf - valorDevolucoes;

        res.json({
            periodo: { mes, ano },
            vendas: {
                clientes_atendidos: clientes,
                transacoes: n(vb.transacoes),

                // Líquidos — o que os cards devem exibir.
                valor_total_nf:  valorLiquido,
                valor_total_vbc: valorBrutoVbc - vbcDevolucoes,
                total_caixas:    caixasBrutas  - caixasDevolucoes,
                total_litros:    litrosBrutos  - litrosDevolucoes,

                // Brutos — para o front mostrar a composição do número.
                valor_bruto_nf:  valorBrutoNf,
                valor_bruto_vbc: valorBrutoVbc,
                caixas_brutas:   caixasBrutas,
                litros_brutos:   litrosBrutos,

                // Devoluções — sempre POSITIVAS (magnitude abatida).
                valor_devolucoes:      valorDevolucoes,
                vbc_devolucoes:        vbcDevolucoes,
                caixas_devolucoes:     caixasDevolucoes,
                litros_devolucoes:     litrosDevolucoes,
                qtd_devolucoes:        n(dv.qtd_devolucoes),
                clientes_com_devolucao: n(dv.clientes_com_devolucao),
                pct_devolucao: valorBrutoNf > 0
                    ? (valorDevolucoes / valorBrutoNf) * 100
                    : 0,

                ticket_medio: clientes > 0 ? valorLiquido / clientes : 0,
            },
            ruptura:            rupturaKPI.rows[0],
            clientes:           { ...clientesKPI.rows[0], _fonte: usarHistoricoClientes ? 'historico' : 'atual' },
            pedidos:            pedidosKPI.rows[0],
            devedores:          devedoresKPI.rows[0],
            vendasPorCategoria: vendasCategoria.rows,
            vendasPorCanal:     vendasCanalRes.rows,
            vendasPorVendedor:  vendasVendedorRes.rows,
            rupturaPorVendedor: rupturaVendedorRes.rows,
        });
    } catch (err) {
        console.error('[dashboard]', err);
        res.status(500).json({ erro: 'Erro ao carregar dashboard.' });
    }
});

// GET /api/dashboard/tendencia?meses=6&ano=2026
router.get('/tendencia', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const meses = Math.min(Number(req.query.meses || '6'), 12);
        const filtroVendedor = req.filtroVendedor;

        const now = new Date();
        const refDate = new Date(now.getFullYear(), now.getMonth() - meses + 1, 1);
        const mesCorte = refDate.getMonth() + 1;
        const anoCorte = refDate.getFullYear();

        const p: unknown[] = [anoCorte, anoCorte, mesCorte];
        let extraWhere = '';
        if (filtroVendedor) {
            p.push(filtroVendedor);
            extraWhere = `AND vendedor_id = $${p.length}`;
        }

        // vw_vendas_liquidas: devolução negativa → SUM() já é líquido.
        const rows = await query(`
            SELECT
                mes_numero,
                ano,
                MAX(mes_descricao)         AS mes_descricao,
                COALESCE(SUM(valor_nf), 0) AS valor_nf,
                COALESCE(SUM(CASE WHEN origem_linha = 'VENDA'
                                  THEN valor_nf ELSE 0 END), 0) AS valor_bruto,
                COALESCE(SUM(CASE WHEN origem_linha = 'DEVOLUCAO'
                                  THEN ABS(valor_nf) ELSE 0 END), 0) AS valor_devolucoes,
                COALESCE(SUM(soma_litros), 0) AS litros,
                COUNT(DISTINCT CASE WHEN origem_linha = 'VENDA'
                                    THEN customer_number END) AS clientes
            FROM vw_vendas_liquidas
            WHERE (ano > $1 OR (ano = $2 AND mes_numero >= $3))
            ${extraWhere}
            GROUP BY mes_numero, ano
            ORDER BY ano, mes_numero
        `, p);

        res.json(rows.rows);
    } catch (err) {
        console.error('[dashboard/tendencia]', err);
        res.status(500).json({ erro: 'Erro ao carregar tendência.' });
    }
});

export default router;