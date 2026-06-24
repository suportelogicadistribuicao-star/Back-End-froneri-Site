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
    const sync = String(req.query.sync || '').toLowerCase() === 'true';
    const uploadedFilePath = req.file.path;
    try {
        if (sync) {
            const resultado = await (0, importService_1.importarRelatorioVendas)(uploadedFilePath, req.usuario.id);
            res.json({
                mensagem: 'Relatório de Vendas importado com sucesso.',
                importacaoId: resultado.logId,
                contadores: resultado.contadores,
            });
            return;
        }
        const { logId, promise } = await (0, importService_1.iniciarImportacaoRelatorioVendas)(uploadedFilePath, req.usuario.id);
        promise
            .then(() => {
            console.log(`[import/vendas] Importação concluída. logId=${logId}`);
        })
            .catch((err) => {
            console.error(`[import/vendas] Falha na importação em background. logId=${logId}`, err);
        })
            .finally(() => {
            if (fs_1.default.existsSync(uploadedFilePath)) {
                fs_1.default.unlinkSync(uploadedFilePath);
            }
        });
        return res.status(202).json({
            mensagem: 'Importação iniciada. Acompanhe o status pelo histórico.',
            importacaoId: logId,
            status: 'processando',
        });
    }
    catch (err) {
        console.error('[import/vendas]', err);
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    }
    finally {
        // No modo síncrono, remove arquivo ao final da requisição.
        if (sync && fs_1.default.existsSync(uploadedFilePath)) {
            fs_1.default.unlinkSync(uploadedFilePath);
        }
    }
});
router.get('/vendas', ...protegido, async (_req, res) => {
    return res.status(405).json({
        erro: 'Método não permitido. Use POST /api/import/vendas com multipart/form-data no campo "arquivo".',
    });
});
/**
 * GET /api/import/historico
 * Histórico de importações realizadas
 */
router.get('/historico', ...protegido, async (req, res) => {
    try {
        const rawLimit = Number(req.query.limit || 20);
        const limit = Math.min(Math.max(rawLimit, 1), 100);
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
            ORDER BY il.id DESC
            LIMIT $1
        `, [limit]);
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
