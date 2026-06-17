const router = require('express').Router();
const { query } = require('../config/database');
const { authMiddleware, ownDataOnly } = require('../middleware/auth');

// GET /api/clientes  — lista com filtros e paginação
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const {
            page = 1, limit = 50,
            busca, canal, segmentacao, nova_rup,
            cidade, vendedor_id, status = 'C', com_ruptura
        } = req.query;

        const offset = (parseInt(page) - 1) * parseInt(limit);
        const where  = ['c.status = $1'];
        const params = [status];
        let   p      = 2;

        // Filtro automático por vendedor para role vendedor
        const fvId = req.filtroVendedor || vendedor_id;
        if (fvId) { where.push(`c.vendedor_id = $${p++}`); params.push(fvId); }

        if (busca) {
            where.push(`(
                unaccent(c.customer_name) ILIKE unaccent($${p}) OR
                c.cnpj ILIKE $${p} OR
                c.city ILIKE $${p++}
            )`);
            params.push(`%${busca}%`);
        }
        if (canal)       { where.push(`c.canal_cliente = $${p++}`);       params.push(canal);       }
        if (segmentacao) { where.push(`c.segmentacao_cliente = $${p++}`); params.push(segmentacao); }
        if (nova_rup)    { where.push(`c.nova_rup = $${p++}`);            params.push(nova_rup);    }
        if (cidade)      { where.push(`c.city ILIKE $${p++}`);            params.push(`%${cidade}%`); }

        if (com_ruptura === 'true') {
            const mesAtual = new Date().getMonth() + 1;
            const anoAtual = new Date().getFullYear();
            where.push(`EXISTS (
                SELECT 1 FROM ruptura r
                WHERE r.customer_number = c.customer_number
                  AND r.mes_numero = ${mesAtual} AND r.ano = ${anoAtual}
            )`);
        }

        const whereClause = 'WHERE ' + where.join(' AND ');

        const total = await query(
            `SELECT COUNT(*) FROM clientes c ${whereClause}`, params
        );

        const rows = await query(`
            SELECT
                c.customer_number, c.customer_name, c.cnpj, c.city,
                c.canal_cliente, c.segmentacao_cliente, c.nova_rup, c.status,
                c.telefone, c.tem_contrato, c.qtd_conservadora,
                c.payment_terms, c.credit_limit, c.address_line1, c.address_line2,
                c.postal_code, c.hierarquia, c.codigo_setor,
                v.nome AS vendedor_nome, v.setor AS vendedor_setor,
                rot.dia_semana, rot.frequencia, rot.sequencia,
                CASE
                    WHEN c.nova_rup = 'C/ Compra'    THEN 'ATIVO'
                    WHEN c.nova_rup = 'Cliente Novo' THEN 'NOVO'
                    WHEN c.nova_rup LIKE '% Mês%'    THEN 'RISCO'
                    WHEN c.nova_rup LIKE '%6 Meses%' THEN 'CRÍTICO'
                    ELSE 'INDEFINIDO'
                END AS status_compra
            FROM clientes c
            LEFT JOIN vendedores v   ON v.id = c.vendedor_id
            LEFT JOIN roteirizacao rot ON rot.sold = c.customer_number AND rot.ativa = TRUE
            ${whereClause}
            ORDER BY c.customer_name
            LIMIT $${p++} OFFSET $${p++}
        `, [...params, parseInt(limit), offset]);

        res.json({
            total:   parseInt(total.rows[0].count),
            pagina:  parseInt(page),
            limite:  parseInt(limit),
            dados:   rows.rows
        });
    } catch (err) {
        console.error('[clientes/list]', err);
        res.status(500).json({ erro: 'Erro ao listar clientes.' });
    }
});

// GET /api/clientes/:customerNumber  — detalhe completo
router.get('/:id', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        const [cliente, vendas, ruptura, pedidos] = await Promise.all([
            query(`
                SELECT c.*, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor,
                       rot.dia_semana, rot.frequencia, rot.sequencia, rot.visitas_semana
                FROM clientes c
                LEFT JOIN vendedores v ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.sold = c.customer_number AND rot.ativa = TRUE
                WHERE c.customer_number = $1
            `, [id]),

            query(`
                SELECT mes_descricao, mes_numero, ano,
                       SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas,
                       SUM(soma_litros) AS litros, COUNT(*) AS itens
                FROM vendas WHERE customer_number = $1
                GROUP BY mes_descricao, mes_numero, ano
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [id]),

            query(`
                SELECT * FROM ruptura
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 6
            `, [id]),

            query(`
                SELECT * FROM pedidos_carteira
                WHERE ship_to_number = $1
                ORDER BY order_date DESC
                LIMIT 20
            `, [id]),
        ]);

        if (cliente.rows.length === 0) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        res.json({
            ...cliente.rows[0],
            historico_vendas:  vendas.rows,
            historico_ruptura: ruptura.rows,
            pedidos_carteira:  pedidos.rows,
        });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar cliente.' });
    }
});

// PUT /api/clientes/:id/observacao  — atualizar observações manualmente
router.put('/:id/observacao', authMiddleware, async (req, res) => {
    try {
        const { observacao } = req.body;
        await query(
            'UPDATE clientes SET updated_at = NOW() WHERE customer_number = $1',
            [parseInt(req.params.id)]
        );
        res.json({ mensagem: 'Observação salva.' });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao salvar observação.' });
    }
});

// GET /api/clientes/exportar/csv
router.get('/exportar/csv', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const fvId = req.filtroVendedor;
        const rows = await query(`
            SELECT
                c.customer_number AS "SOLD",
                c.customer_name AS "Razão Social",
                c.cnpj AS "CNPJ",
                c.city AS "Cidade",
                c.canal_cliente AS "Canal",
                c.segmentacao_cliente AS "Segmentação",
                c.nova_rup AS "Status Compra",
                c.telefone AS "Telefone",
                v.nome AS "Vendedor",
                v.setor AS "Setor",
                rot.dia_semana AS "Dia Visita",
                rot.frequencia AS "Frequência"
            FROM clientes c
            LEFT JOIN vendedores v ON v.id = c.vendedor_id
            LEFT JOIN roteirizacao rot ON rot.sold = c.customer_number AND rot.ativa = TRUE
            WHERE c.status = 'C'
            ${fvId ? 'AND c.vendedor_id = $1' : ''}
            ORDER BY v.nome, c.customer_name
        `, fvId ? [fvId] : []);

        if (rows.rows.length === 0) return res.status(404).json({ erro: 'Nenhum dado.' });

        const cols = Object.keys(rows.rows[0]);
        const csvLines = [
            cols.join(';'),
            ...rows.rows.map(r =>
                cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g, '""')}"`).join(';')
            )
        ];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
        res.send('\uFEFF' + csvLines.join('\r\n'));
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao exportar.' });
    }
});

module.exports = router;
