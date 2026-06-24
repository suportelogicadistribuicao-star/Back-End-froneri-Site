import { Router } from 'express';
import fs from 'fs';
import { authMiddleware, requireRole } from '../middleware/auth';
import upload from '../config/multer';
import { importarRelatorioVendas, iniciarImportacaoRelatorioVendas } from '../services/importService';
import { query } from '../config/database';

const router = Router();

// Apenas admin e gerente podem importar
const protegido = [authMiddleware, requireRole('admin', 'gerente')];

/**
 * POST /api/import/vendas
 * Importa o Relatório de Vendas da Froneri (.xlsb)
 */
router.post('/vendas', ...protegido, upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const sync = String(req.query.sync || '').toLowerCase() === 'true';
    const uploadedFilePath = req.file.path;

    try {
        if (sync) {
            const resultado = await importarRelatorioVendas(uploadedFilePath, req.usuario.id);
            res.json({
                mensagem: 'Relatório de Vendas importado com sucesso.',
                importacaoId: resultado.logId,
                contadores: resultado.contadores,
            });
            return;
        }

        const { logId, promise } = await iniciarImportacaoRelatorioVendas(uploadedFilePath, req.usuario.id);

        promise
            .then(() => {
                console.log(`[import/vendas] Importação concluída. logId=${logId}`);
            })
            .catch((err) => {
                console.error(`[import/vendas] Falha na importação em background. logId=${logId}`, err);
            })
            .finally(() => {
                if (fs.existsSync(uploadedFilePath)) {
                    fs.unlinkSync(uploadedFilePath);
                }
            });

        return res.status(202).json({
            mensagem: 'Importação iniciada. Acompanhe o status pelo histórico.',
            importacaoId: logId,
            status: 'processando',
        });
    } catch (err) {
        console.error('[import/vendas]', err);
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    } finally {
        // No modo síncrono, remove arquivo ao final da requisição.
        if (sync && fs.existsSync(uploadedFilePath)) {
            fs.unlinkSync(uploadedFilePath);
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
        const rows = await query(`
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
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar histórico.' });
    }
});

/**
 * GET /api/import/historico/:id
 * Detalhes de uma importação (com log de erros)
 */
router.get('/historico/:id', ...protegido, async (req, res) => {
    try {
        const rows = await query(
            'SELECT * FROM importacoes_log WHERE id = $1',
            [req.params.id]
        );
        if (rows.rows.length === 0) return res.status(404).json({ erro: 'Importação não encontrada.' });
        res.json(rows.rows[0]);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar importação.' });
    }
});

export default router;


