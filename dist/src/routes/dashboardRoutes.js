"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// GET /api/dashboard
// Retorna todos os KPIs consolidados do mês atual
router.get('/', auth_1.authMiddleware, auth_1.ownDataOnly, async (req, res) => {
    try {
        const mesAtual = new Date().getMonth() + 1;
        const anoAtual = new Date().getFullYear();
        const filtroVendedor = req.filtroVendedor;
        const params = filtroVendedor
            ? [mesAtual, anoAtual, filtroVendedor]
            : [mesAtual, anoAtual];
        const vendedorClause = filtroVendedor ? 'AND vendedor_id = $3' : '';
        // KPIs de Vendas
        const vendasKPI = await (0, database_1.query)(`
            SELECT
                COUNT(DISTINCT customer_number)    AS clientes_atendidos,
                SUM(valor_nf)                      AS valor_total_nf,
                SUM(valor_vbc)                     AS valor_total_vbc,
                SUM(soma_caixas)                   AS total_caixas,
                SUM(soma_litros)                   AS total_litros
            FROM vendas
            WHERE mes_numero = $1 AND ano = $2 ${vendedorClause}
        `, params);
        // KPIs de Ruptura
        const rupturaKPI = await (0, database_1.query)(`
            SELECT COUNT(DISTINCT customer_number) AS total_ruptura
            FROM ruptura
            WHERE mes_numero = $1 AND ano = $2 ${vendedorClause}
        `, params);
        // KPIs de Clientes Ativos
        const clientesKPI = await (0, database_1.query)(`
            SELECT
                COUNT(*) AS total_ativos,
                COUNT(CASE WHEN nova_rup = 'C/ Compra'   THEN 1 END) AS com_compra,
                COUNT(CASE WHEN nova_rup = 'Cliente Novo' THEN 1 END) AS novos,
                COUNT(CASE WHEN nova_rup LIKE '%6 Meses%' THEN 1 END) AS criticos,
                COUNT(CASE WHEN tem_contrato = TRUE       THEN 1 END) AS com_contrato
            FROM clientes
            WHERE status = 'C'
            ${filtroVendedor ? 'AND vendedor_id = $1' : ''}
        `, filtroVendedor ? [filtroVendedor] : []);
        // KPIs de Pedidos em Carteira
        const pedidosKPI = await (0, database_1.query)(`
            SELECT
                COUNT(DISTINCT ship_to_number)   AS clientes_com_pedido,
                SUM(extended_amount)             AS valor_carteira,
                COUNT(*)                         AS total_pedidos
            FROM pedidos_carteira
            WHERE mes_numero = $1 AND ano = $2 ${vendedorClause}
        `, params);
        // Vendas por Categoria
        const vendasCategoria = await (0, database_1.query)(`
            SELECT categoria, SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas
            FROM vendas
            WHERE mes_numero = $1 AND ano = $2 ${vendedorClause}
            GROUP BY categoria
            ORDER BY valor DESC
        `, params);
        // Vendas por Vendedor (se admin/gerente)
        let vendasVendedor = [];
        if (!filtroVendedor) {
            const vv = await (0, database_1.query)(`
                SELECT
                    v.nome AS vendedor_nome,
                    v.setor,
                    COALESCE(SUM(ve.valor_nf), 0) AS valor_nf,
                    COUNT(DISTINCT ve.customer_number) AS clientes
                FROM vendedores v
                LEFT JOIN vendas ve ON ve.vendedor_id = v.id
                    AND ve.mes_numero = $1 AND ve.ano = $2
                WHERE v.ativo = TRUE
                GROUP BY v.id, v.nome, v.setor
                ORDER BY valor_nf DESC
            `, [mesAtual, anoAtual]);
            vendasVendedor = vv.rows;
        }
        // Devedores resumo
        const devedoresKPI = await (0, database_1.query)(`
            SELECT
                COUNT(DISTINCT documento_cliente) AS total_devedores,
                SUM(valor_titulo_saldo_devedor)   AS valor_total_devedor,
                MAX(dias_em_atraso)               AS max_dias_atraso
            FROM devedores
            ${filtroVendedor ? `WHERE documento_cliente IN (
                SELECT cnpj FROM clientes WHERE vendedor_id = $1
            )` : ''}
        `, filtroVendedor ? [filtroVendedor] : []);
        res.json({
            periodo: { mes: mesAtual, ano: anoAtual },
            vendas: vendasKPI.rows[0],
            ruptura: rupturaKPI.rows[0],
            clientes: clientesKPI.rows[0],
            pedidos: pedidosKPI.rows[0],
            devedores: devedoresKPI.rows[0],
            vendasPorCategoria: vendasCategoria.rows,
            vendasPorVendedor: vendasVendedor,
        });
    }
    catch (err) {
        console.error('[dashboard]', err);
        res.status(500).json({ erro: 'Erro ao carregar dashboard.' });
    }
});
// GET /api/dashboard/tendencia?meses=6
// Evolução de vendas nos últimos N meses
router.get('/tendencia', auth_1.authMiddleware, auth_1.ownDataOnly, async (req, res) => {
    try {
        const meses = Math.min(Number(req.query.meses || '6'), 12);
        const filtroVendedor = req.filtroVendedor;
        const rows = await (0, database_1.query)(`
            SELECT
                mes_numero, ano,
                mes_descricao,
                SUM(valor_nf)   AS valor_nf,
                SUM(soma_litros) AS litros,
                COUNT(DISTINCT customer_number) AS clientes
            FROM vendas
            WHERE (ano * 100 + mes_numero) >= (
                SELECT (EXTRACT(YEAR FROM NOW())::int * 100) + EXTRACT(MONTH FROM NOW())::int - ${meses}
            )
            ${filtroVendedor ? 'AND vendedor_id = $1' : ''}
            GROUP BY mes_numero, ano, mes_descricao
            ORDER BY ano, mes_numero
        `, filtroVendedor ? [filtroVendedor] : []);
        res.json(rows.rows);
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao carregar tendência.' });
    }
});
exports.default = router;
