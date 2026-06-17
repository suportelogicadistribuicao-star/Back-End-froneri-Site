// vendedoresRoutes.js
const router = require('express').Router();
const { query } = require('../config/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

router.get('/', authMiddleware, async (_req, res) => {
    try {
        const rows = await query(`
            SELECT v.*, u.email,
                   COUNT(DISTINCT c.customer_number) AS total_clientes
            FROM vendedores v
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            LEFT JOIN clientes c ON c.vendedor_id = v.id AND c.status = 'C'
            WHERE v.ativo = TRUE
            GROUP BY v.id, u.email
            ORDER BY v.nome
        `);
        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar vendedores.' });
    }
});

router.get('/:id/resumo', authMiddleware, async (req, res) => {
    try {
        const mesAtual = new Date().getMonth() + 1;
        const anoAtual = new Date().getFullYear();

        const [vendedor, kpis, ruptura, roteirizacao] = await Promise.all([
            query('SELECT * FROM vendedores WHERE id = $1', [req.params.id]),
            query(`
                SELECT
                    COUNT(DISTINCT ve.customer_number) AS clientes_atendidos,
                    SUM(ve.valor_nf) AS valor_nf,
                    SUM(ve.soma_litros) AS litros,
                    SUM(ve.soma_caixas) AS caixas
                FROM vendas ve
                WHERE ve.vendedor_id = $1 AND ve.mes_numero = $2 AND ve.ano = $3
            `, [req.params.id, mesAtual, anoAtual]),
            query(`
                SELECT COUNT(*) AS total FROM ruptura
                WHERE vendedor_id = $1 AND mes_numero = $2 AND ano = $3
            `, [req.params.id, mesAtual, anoAtual]),
            query(`
                SELECT dia_semana, COUNT(*) AS total_clientes
                FROM roteirizacao WHERE vendedor_id = $1 AND ativa = TRUE
                GROUP BY dia_semana ORDER BY dia_semana
            `, [req.params.id]),
        ]);

        if (vendedor.rows.length === 0) return res.status(404).json({ erro: 'Vendedor não encontrado.' });

        res.json({
            ...vendedor.rows[0],
            kpis:         kpis.rows[0],
            ruptura:      ruptura.rows[0],
            roteirizacao: roteirizacao.rows,
        });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar resumo do vendedor.' });
    }
});

module.exports = router;
