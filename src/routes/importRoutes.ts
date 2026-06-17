import { Router } from 'express';
import fs from 'fs';
import { authMiddleware, requireRole } from '../middleware/auth';
import upload from '../config/multer';
import {
    importarRelatorioVendas,
    importarBaseAtiva,
    importarCadastros,
} from '../services/importService';
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

    try {
        const resultado = await importarRelatorioVendas(req.file.path, req.usuario.id);
        res.json({
            mensagem:   'Relatório de Vendas importado com sucesso.',
            importacaoId: resultado.logId,
            contadores:   resultado.contadores,
        });
    } catch (err) {
        console.error('[import/vendas]', err);
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    } finally {
        // Remover arquivo temporário após processamento
        if (req.file?.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
});

/**
 * POST /api/import/base-ativa
 * Importa Base_Froneri_Ativa_Roteirizações (.xlsx)
 */
router.post('/base-ativa', ...protegido, upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    try {
        const resultado = await importarBaseAtiva(req.file.path, req.usuario.id);
        res.json({
            mensagem:   'Base Ativa importada com sucesso.',
            importacaoId: resultado.logId,
            contadores:   resultado.contadores,
        });
    } catch (err) {
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    } finally {
        if (req.file?.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
    }
});

/**
 * POST /api/import/cadastros
 * Importa CADASTROS_FRONERI (.xlsx)
 */
router.post('/cadastros', ...protegido, upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });

    try {
        const resultado = await importarCadastros(req.file.path, req.usuario.id);
        res.json({
            mensagem:   'Cadastros importados com sucesso.',
            importacaoId: resultado.logId,
            contadores:   resultado.contadores,
        });
    } catch (err) {
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    } finally {
        if (req.file?.path && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
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
            ORDER BY il.created_at DESC
            LIMIT $1
        `, [Number(limit)]);

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


