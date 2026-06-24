// vendedoresRoutes.js
import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Lista todos os aliases (disponíveis e preenchidos), com campo `preenchido`
router.get('/aliases/todos', authMiddleware, async (_req, res) => {
    try {
        const rows = await query(`
            SELECT v.id, v.codigo_vendedor, v.setor, v.territory_number, v.vendedor_alias,
                   v.nome, v.email, v.telefone, v.ativo,
                   (v.nome IS NOT NULL) AS preenchido,
                   COALESCE(cc.total_clientes, 0) AS total_clientes
            FROM vendedores v
            LEFT JOIN (
                SELECT vendedor_id, COUNT(*) AS total_clientes
                FROM clientes
                WHERE status = 'C'
                GROUP BY vendedor_id
            ) cc ON cc.vendedor_id = v.id
            ORDER BY v.vendedor_alias
        `);
        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar todos os aliases.' });
    }
});

// // Lista slots de alias disponíveis (ainda sem vendedor real atribuído)
// router.get('/aliases', authMiddleware, async (_req, res) => {
//     try {
//         const rows = await query(`
//             SELECT v.id, v.codigo_vendedor, v.setor, v.territory_number, v.vendedor_alias,
//                    COUNT(DISTINCT c.customer_number) AS total_clientes
//             FROM vendedores v
//             LEFT JOIN clientes c ON c.vendedor_id = v.id AND c.status = 'C'
//             WHERE v.nome IS NULL AND v.ativo = TRUE
//             GROUP BY v.id
//             ORDER BY v.vendedor_alias
//         `);
//         res.json(rows.rows);
//     } catch (err) {
//         res.status(500).json({ erro: 'Erro ao listar aliases disponíveis.' });
//     }
// });

// Associa um vendedor real a um slot de alias existente.
// O slot já tem os dados técnicos da indústria (codigo_vendedor, setor, territory_number).
// Esta rota apenas preenche nome/email/telefone nesse slot — nenhum novo registro é criado.
router.post('/', authMiddleware, async (req, res) => {
    const { alias_id, nome, email, telefone } = req.body;

    if (!alias_id) return res.status(400).json({ erro: 'alias_id é obrigatório.' });
    if (!nome?.trim()) return res.status(400).json({ erro: 'Nome é obrigatório.' });

    try {
        const slotRes = await query(
            'SELECT id FROM vendedores WHERE id = $1 AND nome IS NULL AND ativo = TRUE',
            [alias_id]
        );
        if (slotRes.rows.length === 0)
            return res.status(404).json({ erro: 'Slot de alias não encontrado ou já associado a um vendedor.' });

        await query(`
            UPDATE vendedores SET
                nome       = $1,
                email      = $2,
                telefone   = $3,
                updated_at = NOW()
            WHERE id = $4
        `, [nome.trim(), email || null, telefone || null, alias_id]);

        const result = await query('SELECT * FROM vendedores WHERE id = $1', [alias_id]);

        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao criar vendedor.' });
    }
});

router.get('/', authMiddleware, async (_req, res) => {
    try {
        const rows = await query(`
            SELECT v.*, u.email, COALESCE(cc.total_clientes, 0) AS total_clientes
            FROM vendedores v
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            LEFT JOIN (
                SELECT vendedor_id, COUNT(*) AS total_clientes
                FROM clientes
                WHERE status = 'C'
                GROUP BY vendedor_id
            ) cc ON cc.vendedor_id = v.id
            WHERE v.ativo = TRUE
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

export default router;

