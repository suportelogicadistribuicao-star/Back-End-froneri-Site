"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const fs_1 = __importDefault(require("fs"));
const auth_1 = require("../middleware/auth");
const multer_1 = __importDefault(require("../config/multer"));
const importService_1 = require("../services/importService");
const database_1 = require("../config/database");
const router = (0, express_1.Router)();
// Apenas admin e gerente podem importar
const protegido = [auth_1.authMiddleware, (0, auth_1.requireRole)('admin', 'gerente')];
/**
 * POST /api/import/vendas
 * Importa o Relatório de Vendas da Froneri (.xlsb)
 */
router.post('/vendas', ...protegido, multer_1.default.single('arquivo'), async (req, res) => {
    if (!req.file)
        return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    try {
        const resultado = await (0, importService_1.importarRelatorioVendas)(req.file.path, req.usuario.id);
        res.json({
            mensagem: 'Relatório de Vendas importado com sucesso.',
            importacaoId: resultado.logId,
            contadores: resultado.contadores,
        });
    }
    catch (err) {
        console.error('[import/vendas]', err);
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    }
    finally {
        // Remover arquivo temporário após processamento
        if (req.file?.path && fs_1.default.existsSync(req.file.path)) {
            fs_1.default.unlinkSync(req.file.path);
        }
    }
});
/**
 * GET /api/import/historico
 * Histórico de importações realizadas
 */
router.get('/historico', ...protegido, async (req, res) => {
    try {
        const { limit = 20 } = req.query;
        const rows = await (0, database_1.query)(`
            SELECT
                il.id, il.arquivo_nome, il.tipo_arquivo,
                il.mes_referencia, il.status,
                il.registros_vendas, il.registros_clientes,
                il.registros_ruptura, il.registros_pedidos, il.registros_erros,
                il.created_at, il.finished_at,
                u.nome AS importado_por
            FROM importacoes_log il
            LEFT JOIN usuarios u ON u.id = il.usuario_id
            ORDER BY il.created_at DESC
            LIMIT $1
        `, [Number(limit)]);
        res.json(rows.rows);
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
});
/**
 * GET /api/import/historico/:id
 * Detalhes de uma importação (com log de erros)
 */
router.get('/historico/:id', ...protegido, async (req, res) => {
    try {
        const rows = await (0, database_1.query)('SELECT * FROM importacoes_log WHERE id = $1', [req.params.id]);
        if (rows.rows.length === 0)
            return res.status(404).json({ erro: 'Importação não encontrada.' });
        res.json(rows.rows[0]);
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar importação.' });
    }
});
exports.default = router;
