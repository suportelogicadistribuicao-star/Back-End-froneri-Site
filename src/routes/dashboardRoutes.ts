// dashboardRoutes.ts — v3 (views canônicas)
//
// MUDANÇAS DA FASE 2:
//   • Faturamento/volume: TODAS as somas agora saem de vw_vendas_validas
//     (status_venda = 'VENDA' garantido pela view). Antes o KPI, a tendência
//     e os gráficos por categoria/canal/vendedor somavam devoluções e
//     amostras grátis junto.
//   • Ruptura: sai de vw_ruptura_avaliada, que já aplica a regra canônica
//     (snapshot mensal da Regra Froneri + exclusão do ADM_Logica MG).
//     Antes usava o status ATUAL de clientes e não excluía o ADM.
//   • O backend devolve o KPI COMPLETO de ruptura:
//     { total_ruptura, base_avaliada, com_compra, pct_ruptura } — pct SEM
//     arredondar; a exibição decide as casas decimais.
//   • NOVO: rupturaPorVendedor (visão agregada, admin/gerente) — o front
//     não precisa mais recalcular a regra localmente (fase 3).
//   • Filtros canal/segmentação agora também se aplicam à ruptura, igual
//     ao comportamento da página de Ruptura.
import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';
import { hasRupturaForPeriodo } from '../services/clientesHistoricoService';

const router = Router();

// GET /api/dashboard?mes=6&ano=2026&canal=OOH&segmentacao=A
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const now = new Date();
        const mes = Number(req.query.mes) || now.getMonth() + 1;
        const ano = Number(req.query.ano) || now.getFullYear();
        const canal = (req.query.canal as string) || null;
        const segmentacao = (req.query.segmentacao as string) || null;
        const filtroVendedor = req.filtroVendedor;

        // ── Filtros de vendas (vw_vendas_validas) ────────────────────────────
        const p: unknown[] = [ano, mes];
        let vendaWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { p.push(filtroVendedor); vendaWhere += ` AND vendedor_id = $${p.length}`; }
        if (canal)          { p.push(canal);          vendaWhere += ` AND canal_cliente = $${p.length}`; }
        if (segmentacao)    { p.push(segmentacao);    vendaWhere += ` AND segmentacao_cliente = $${p.length}`; }

        // ── Filtros de ruptura (vw_ruptura_avaliada) ─────────────────────────
        // Mesmos filtros de canal/segmentação do restante do dashboard —
        // a página de Ruptura aplica os mesmos, então os números batem.
        const rupturaParams: unknown[] = [ano, mes];
        let rupturaWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { rupturaParams.push(filtroVendedor); rupturaWhere += ` AND vendedor_id = $${rupturaParams.length}`; }
        if (canal)          { rupturaParams.push(canal);          rupturaWhere += ` AND canal_cliente = $${rupturaParams.length}`; }
        if (segmentacao)    { rupturaParams.push(segmentacao);    rupturaWhere += ` AND segmentacao_cliente = $${rupturaParams.length}`; }

        const pedidosParams: unknown[] = [ano, mes];
        let pedidosWhere = 'WHERE ano = $1 AND mes_numero = $2';
        if (filtroVendedor) { pedidosParams.push(filtroVendedor); pedidosWhere += ` AND vendedor_id = $${pedidosParams.length}`; }

        // ── KPI de Clientes Ativos ───────────────────────────────────────────
        // Quando o período tem roster (tabela ruptura), usa vw_ruptura_avaliada:
        // já vem com a Regra Froneri (só clientes ativos no mês) e sem o ADM —
        // idêntico ao que a página de Ruptura contabiliza. Sem roster para o
        // período, cai no estado atual (clientes).
        const usarHistoricoClientes = await hasRupturaForPeriodo(mes, ano);
        const clientesKPIQuery = usarHistoricoClientes
            ? `
                SELECT
                    COUNT(*)                    AS total_ativos,
                    SUM(ra.eh_com_compra)       AS com_compra,
                    SUM(ra.eh_cliente_novo)     AS novos,
                    SUM(ra.eh_mais_6_meses)     AS criticos,
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
                    COUNT(CASE WHEN tem_contrato = TRUE        THEN 1 END) AS com_contrato
                FROM clientes
                WHERE status = 'C'
                ${filtroVendedor ? 'AND vendedor_id = $1' : ''}
            `;
        const clientesKPIParams = usarHistoricoClientes
            ? (filtroVendedor ? [mes, ano, filtroVendedor] : [mes, ano])
            : (filtroVendedor ? [filtroVendedor] : []);

        // Todas as queries são independentes — dispara em paralelo
        const [
            vendasKPI,
            rupturaKPI,
            clientesKPI,
            pedidosKPI,
            vendasCategoria,
            vendasCanalRes,
            devedoresKPI,
            vendasVendedorRes,
            rupturaVendedorRes,
        ] = await Promise.all([
            // Faturamento/volume — vw_vendas_validas (só status_venda='VENDA')
            query(`
                SELECT
                    COUNT(DISTINCT customer_number)    AS clientes_atendidos,
                    SUM(valor_nf)                      AS valor_total_nf,
                    SUM(valor_vbc)                     AS valor_total_vbc,
                    SUM(soma_caixas)                   AS total_caixas,
                    SUM(soma_litros)                   AS total_litros
                FROM vw_vendas_validas
                ${vendaWhere}
            `, p),

            // Ruptura — KPI completo pela regra canônica, pct SEM arredondar
            query(`
                SELECT
                    SUM(eh_ruptura)                                     AS total_ruptura,
                    SUM(entra_base)                                     AS base_avaliada,
                    SUM(eh_com_compra)                                  AS com_compra,
                    SUM(eh_cliente_novo)                                AS clientes_novos,
                    SUM(eh_sem_kv)                                      AS sem_kv,
                    SUM(eh_mais_6_meses)                                AS mais_6_meses,
                    100 * SUM(eh_ruptura) / NULLIF(SUM(entra_base), 0)  AS pct_ruptura
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

            query(`
                SELECT categoria, SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas
                FROM vw_vendas_validas
                ${vendaWhere}
                GROUP BY categoria
                ORDER BY valor DESC
            `, p),

            query(`
                SELECT canal_cliente AS name, SUM(valor_nf) AS value
                FROM vw_vendas_validas
                ${vendaWhere}
                GROUP BY canal_cliente
                ORDER BY value DESC
            `, p),

            // Devedores: INNER JOIN condicional para filtro por vendedor
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

            // Vendas por Vendedor — somente admin/gerente
            !filtroVendedor
                ? query(`
                    SELECT
                        v.nome AS vendedor_nome,
                        v.setor,
                        COALESCE(SUM(ve.valor_nf), 0) AS valor_nf,
                        COUNT(DISTINCT ve.customer_number) AS clientes
                    FROM vendedores v
                    LEFT JOIN vw_vendas_validas ve ON ve.vendedor_id = v.id
                        AND ve.mes_numero = $1 AND ve.ano = $2
                    WHERE v.ativo = TRUE
                    GROUP BY v.id, v.nome, v.setor
                    ORDER BY valor_nf DESC
                `, [mes, ano])
                : Promise.resolve({ rows: [] }),

            // NOVO: Ruptura por Vendedor — somente admin/gerente.
            // Substitui o recálculo local do dashboardPage (fase 3): mesma
            // fórmula para todos, pct sem arredondar, base > 0 evita 0%/100%
            // espúrios de vendedor sem base avaliada.
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

        res.json({
            periodo:            { mes, ano },
            vendas:             vendasKPI.rows[0],
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

        // Ponto de corte com aritmética de datas:
        // ex: junho/2026 - 6 meses = janeiro/2026 → anoCorte=2026, mesCorte=1
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

        // vw_vendas_validas: antes a tendência somava devoluções/amostras.
        const rows = await query(`
            SELECT
                mes_numero,
                ano,
                mes_descricao,
                SUM(valor_nf)                   AS valor_nf,
                SUM(soma_litros)                AS litros,
                COUNT(DISTINCT customer_number) AS clientes
            FROM vw_vendas_validas
            WHERE (ano > $1 OR (ano = $2 AND mes_numero >= $3))
            ${extraWhere}
            GROUP BY mes_numero, ano, mes_descricao
            ORDER BY ano, mes_numero
        `, p);

        res.json(rows.rows);
    } catch (err) {
        console.error('[dashboard/tendencia]', err);
        res.status(500).json({ erro: 'Erro ao carregar tendência.' });
    }
});

export default router;