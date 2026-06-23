"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// vendasRoutes.js
const express_1 = require("express");
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/', auth_1.authMiddleware, auth_1.ownDataOnly, async (req, res) => {
    try {
        const { mes, ano, vendedor_id, canal, categoria, page = 1, limit = 100 } = req.query;
        const where = [];
        const params = [];
        let p = 1;
        const fvId = req.filtroVendedor || vendedor_id;
        if (fvId) {
            where.push(`vendedor_id = $${p++}`);
            params.push(fvId);
        }
        if (mes) {
            where.push(`mes_numero = $${p++}`);
            params.push(Number(mes));
        }
        if (ano) {
            where.push(`ano = $${p++}`);
            params.push(Number(ano));
        }
        if (canal) {
            where.push(`canal_cliente = $${p++}`);
            params.push(canal);
        }
        if (categoria) {
            where.push(`categoria = $${p++}`);
            params.push(categoria);
        }
        const offset = (Number(page) - 1) * Number(limit);
        const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const [total, rows] = await Promise.all([
            (0, database_1.query)(`SELECT COUNT(*) FROM vendas ${wStr}`, params),
            (0, database_1.query)(`
                SELECT ve.*, v.nome AS vendedor_nome
                FROM vendas ve
                LEFT JOIN vendedores v ON v.id = ve.vendedor_id
                ${wStr}
                ORDER BY ve.data_faturamento DESC
                LIMIT $${p++} OFFSET $${p++}
            `, [...params, Number(limit), offset]),
        ]);
        res.json({ total: Number(total.rows[0].count), pagina: Number(page), dados: rows.rows });
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao listar vendas.' });
    }
});
// Resumo agrupado por categoria/mês
router.get('/resumo', auth_1.authMiddleware, auth_1.ownDataOnly, async (req, res) => {
    try {
        const { mes, ano, agrupar = 'categoria' } = req.query;
        const fvId = req.filtroVendedor;
        const where = [];
        const params = [];
        let p = 1;
        if (fvId) {
            where.push(`vendedor_id = $${p++}`);
            params.push(fvId);
        }
        if (mes) {
            where.push(`mes_numero = $${p++}`);
            params.push(Number(mes));
        }
        if (ano) {
            where.push(`ano = $${p++}`);
            params.push(Number(ano));
        }
        const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const grupoCol = agrupar === 'vendedor' ? 'vendedor_id, vendedor_alias' : 'categoria';
        const rows = await (0, database_1.query)(`
            SELECT ${grupoCol},
                   SUM(valor_nf) AS valor_nf, SUM(soma_caixas) AS caixas,
                   SUM(soma_litros) AS litros, COUNT(DISTINCT customer_number) AS clientes
            FROM vendas ${wStr}
            GROUP BY ${grupoCol}
            ORDER BY valor_nf DESC
        `, params);
        res.json(rows.rows);
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao carregar resumo.' });
    }
});
exports.default = router;
