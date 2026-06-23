import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';

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

        // Parâmetros e cláusula WHERE reutilizados em todas as queries de vendas/ruptura/pedidos
        const p: unknown[] = [mes, ano];
        let vendaWhere = 'WHERE mes_numero = $1 AND ano = $2';

        if (filtroVendedor) {
            p.push(filtroVendedor);
            vendaWhere += ` AND vendedor_id = $${p.length}`;
        }
        if (canal) {
            p.push(canal);
            vendaWhere += ` AND canal_cliente = $${p.length}`;
        }
        if (segmentacao) {
            p.push(segmentacao);
            vendaWhere += ` AND segmentacao_cliente = $${p.length}`;
        }

        // KPIs de Vendas
        const vendasKPI = await query(`
            SELECT
                COUNT(DISTINCT customer_number)    AS clientes_atendidos,
                SUM(valor_nf)                      AS valor_total_nf,
                SUM(valor_vbc)                     AS valor_total_vbc,
                SUM(soma_caixas)                   AS total_caixas,
                SUM(soma_litros)                   AS total_litros
            FROM vendas
            ${vendaWhere}
        `, p);

        // KPIs de Ruptura (ruptura não tem canal/segmentacao, usa só mes/ano/vendedor)
        const rupturaParams: unknown[] = [mes, ano];
        let rupturaWhere = 'WHERE mes_numero = $1 AND ano = $2';
        if (filtroVendedor) {
            rupturaParams.push(filtroVendedor);
            rupturaWhere += ` AND vendedor_id = $${rupturaParams.length}`;
        }

        const rupturaKPI = await query(`
            SELECT COUNT(DISTINCT customer_number) AS total_ruptura
            FROM ruptura
            ${rupturaWhere}
        `, rupturaParams);

        // KPIs de Clientes Ativos (não filtra por mes/ano — base atual)
        const clientesKPI = await query(`
            SELECT
                COUNT(*) AS total_ativos,
                COUNT(CASE WHEN nova_rup = 'C/ Compra'    THEN 1 END) AS com_compra,
                COUNT(CASE WHEN nova_rup = 'Cliente Novo' THEN 1 END) AS novos,
                COUNT(CASE WHEN nova_rup LIKE '%6 Meses%' THEN 1 END) AS criticos,
                COUNT(CASE WHEN tem_contrato = TRUE        THEN 1 END) AS com_contrato
            FROM clientes
            WHERE status = 'C'
            ${filtroVendedor ? 'AND vendedor_id = $1' : ''}
        `, filtroVendedor ? [filtroVendedor] : []);

        // KPIs de Pedidos em Carteira
        const pedidosParams: unknown[] = [mes, ano];
        let pedidosWhere = 'WHERE mes_numero = $1 AND ano = $2';
        if (filtroVendedor) {
            pedidosParams.push(filtroVendedor);
            pedidosWhere += ` AND vendedor_id = $${pedidosParams.length}`;
        }

        const pedidosKPI = await query(`
            SELECT
                COUNT(DISTINCT customer_number) AS clientes_com_pedido,
                SUM(extended_amount)            AS valor_carteira,
                COUNT(*)                        AS total_pedidos
            FROM pedidos_carteira
            ${pedidosWhere}
        `, pedidosParams);

        // Vendas por Categoria
        const vendasCategoria = await query(`
            SELECT categoria, SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas
            FROM vendas
            ${vendaWhere}
            GROUP BY categoria
            ORDER BY valor DESC
        `, p);

        // Vendas por Vendedor (somente para admin/gerente, sem filtro de canal/segmentacao)
        let vendasVendedor: unknown[] = [];
        if (!filtroVendedor) {
            const vv = await query(`
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
            `, [mes, ano]);
            vendasVendedor = vv.rows;
        }

        // Devedores resumo (não filtra por mes/ano — posição atual)
        const devedoresKPI = await query(`
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
            periodo:            { mes, ano },
            vendas:             vendasKPI.rows[0],
            ruptura:            rupturaKPI.rows[0],
            clientes:           clientesKPI.rows[0],
            pedidos:            pedidosKPI.rows[0],
            devedores:          devedoresKPI.rows[0],
            vendasPorCategoria: vendasCategoria.rows,
            vendasPorVendedor:  vendasVendedor,
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

        // Calcula o ponto de corte correto usando aritmética de datas
        // ex: junho/2026 - 6 meses = dezembro/2025 → anoCorte=2025, mesCorte=12
        const now = new Date();
        const refDate = new Date(now.getFullYear(), now.getMonth() - meses + 1, 1);
        const mesCorte = refDate.getMonth() + 1;
        const anoCorte = refDate.getFullYear();
        const corte = anoCorte * 100 + mesCorte;

        const p: unknown[] = [];
        let extraWhere = '';
        if (filtroVendedor) {
            p.push(filtroVendedor);
            extraWhere = `AND vendedor_id = $${p.length}`;
        }

        const rows = await query(`
            SELECT
                mes_numero,
                ano,
                mes_descricao,
                SUM(valor_nf)                   AS valor_nf,
                SUM(soma_litros)                AS litros,
                COUNT(DISTINCT customer_number) AS clientes
            FROM vendas
            WHERE (ano * 100 + mes_numero) >= ${corte}
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
