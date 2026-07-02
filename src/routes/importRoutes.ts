import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import { HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { authMiddleware, requireRole } from '../middleware/auth';
import upload, { UPLOAD_DIR, limparArquivosAntigos } from '../config/multer';
import { s3Client, B2_BUCKET, PRESIGN_EXPIRES_SECONDS, getPresignedPutUrl } from '../config/b2';
import { ALLOWED_EXTENSIONS, UPLOAD_MAX_SIZE_MB } from '../config/uploadPolicy';
import { importarRelatorioVendas, iniciarImportacaoRelatorioVendas } from '../services/importService';
import { query } from '../config/database';

const router = Router();

// Apenas admin e gerente podem importar
const protegido = [authMiddleware, requireRole('admin', 'gerente')];

// Executa a importação a partir de um arquivo local e responde a requisição —
// compartilhado pela rota legada (multer) e pela rota nova (upload-url + confirmar),
// já que ambas terminam com o mesmo arquivo já salvo em UPLOAD_DIR.
async function processarImportacaoEResponder(localFilePath: string, usuarioId: string, sync: boolean, res) {
    try {
        if (sync) {
            const resultado = await importarRelatorioVendas(localFilePath, usuarioId);
            limparArquivosAntigos();
            res.json({
                mensagem: 'Relatório de Vendas importado com sucesso.',
                importacaoId: resultado.logId,
                contadores: resultado.contadores,
            });
            return;
        }

        const { logId, promise } = await iniciarImportacaoRelatorioVendas(localFilePath, usuarioId);

        promise
            .then(() => {
                console.log(`[import/vendas] Importação concluída. logId=${logId}`);
                limparArquivosAntigos();
            })
            .catch((err) => {
                console.error(`[import/vendas] Falha na importação em background. logId=${logId}`, err);
            })
            .finally(() => {
                if (fs.existsSync(localFilePath)) {
                    fs.unlinkSync(localFilePath);
                }
            });

        res.status(202).json({
            mensagem: 'Importação iniciada. Acompanhe o status pelo histórico.',
            importacaoId: logId,
            status: 'processando',
        });
    } catch (err) {
        console.error('[import/vendas]', err);
        res.status(500).json({ erro: `Erro na importação: ${err.message}` });
    } finally {
        // No modo síncrono, remove arquivo ao final da requisição.
        if (sync && fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }
    }
}

/**
 * POST /api/import
 * Importa o Relatório de Vendas da Froneri (.xlsb) via multipart/form-data.
 * Mantida para uso local/dev — em produção na KingHost o proxy bloqueia uploads
 * multipart antes de chegar ao Node; use POST /api/import/upload-url + /confirmar.
 */
router.post('/', ...protegido, upload.single('arquivo'), async (req, res) => {
    if (!req.file) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
    const sync = String(req.query.sync || '').toLowerCase() === 'true';
    await processarImportacaoEResponder(req.file.path, String(req.usuario.id), sync, res);
});

/**
 * POST /api/import/upload-url
 * Gera uma URL pré-assinada para o cliente enviar o arquivo direto ao R2,
 * sem passar pelo proxy da KingHost.
 * Body: { nomeArquivo: string }
 */
router.post('/upload-url', ...protegido, async (req, res) => {
    try {
        const nomeArquivo = String(req.body?.nomeArquivo || '').trim();
        if (!nomeArquivo) {
            return res.status(400).json({ erro: 'Informe o nome do arquivo (nomeArquivo).' });
        }

        const ext = path.extname(nomeArquivo).toLowerCase();
        if (!ALLOWED_EXTENSIONS.includes(ext)) {
            return res.status(400).json({ erro: `Formato não suportado: ${ext}. Use ${ALLOWED_EXTENSIONS.join(', ')}` });
        }

        const safe = nomeArquivo.replace(/[^a-z0-9._-]/gi, '_');
        const key = `imports/${req.usuario.id}/${Date.now()}_${safe}`;
        const uploadUrl = await getPresignedPutUrl(key);

        console.log(`[B2] Presigned URL emitida. usuario=${req.usuario.id} key=${key}`);
        res.json({ uploadUrl, key, expiresIn: PRESIGN_EXPIRES_SECONDS });
    } catch (err) {
        console.error('[B2] Erro ao gerar URL pré-assinada:', err.message);
        res.status(500).json({ erro: 'Erro ao gerar URL pré-assinada. Verifique as credenciais do B2.' });
    }
});

/**
 * POST /api/import/confirmar
 * Confirma que o upload ao R2 terminou, baixa o arquivo para o servidor
 * (requisição de saída — não passa pelo proxy da KingHost) e dispara a importação.
 * Body: { key: string }
 */
router.post('/confirmar', ...protegido, async (req, res) => {
    const key = String(req.body?.key || '').trim();
    const sync = String(req.query.sync || '').toLowerCase() === 'true';
    console.log(`[import/confirmar] recebido. usuario=${req.usuario?.id} key=${key} sync=${sync}`);

    if (!key || key.includes('..')) {
        console.warn(`[import/confirmar] chave inválida: "${key}"`);
        return res.status(400).json({ erro: 'Chave de arquivo inválida.' });
    }
    if (!key.startsWith(`imports/${req.usuario.id}/`)) {
        console.warn(`[import/confirmar] chave fora do escopo do usuário. usuario=${req.usuario.id} key=${key}`);
        return res.status(403).json({ erro: 'Você não tem permissão para acessar este arquivo.' });
    }
    const ext = path.extname(key).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
        return res.status(400).json({ erro: `Formato não suportado: ${ext}. Use ${ALLOWED_EXTENSIONS.join(', ')}` });
    }

    let localFilePath: string;
    try {
        let head;
        try {
            head = await s3Client.send(new HeadObjectCommand({ Bucket: B2_BUCKET, Key: key }));
            console.log(`[import/confirmar] HeadObject ok. key=${key} tamanho=${head.ContentLength}`);
        } catch (err) {
            console.error(`[import/confirmar] HeadObject falhou. key=${key}`, err);
            return res.status(404).json({
                erro: 'Arquivo não encontrado no armazenamento temporário. Verifique se o upload foi concluído ou solicite uma nova URL.',
            });
        }

        const maxBytes = UPLOAD_MAX_SIZE_MB * 1024 * 1024;
        if ((head.ContentLength || 0) > maxBytes) {
            await s3Client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key })).catch(() => {});
            return res.status(413).json({ erro: `Arquivo excede o tamanho máximo de ${UPLOAD_MAX_SIZE_MB}MB.` });
        }

        const getResult = await s3Client.send(new GetObjectCommand({ Bucket: B2_BUCKET, Key: key }));
        localFilePath = path.join(UPLOAD_DIR, `${Date.now()}_${path.basename(key)}`);
        console.log(`[import/confirmar] baixando para ${localFilePath}`);
        await pipeline(getResult.Body as NodeJS.ReadableStream, fs.createWriteStream(localFilePath));
        console.log(`[import/confirmar] download concluído. ${localFilePath}`);

        s3Client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: key })).catch((err) => {
            console.error('[B2] Falha ao remover objeto após download:', err.message);
        });
    } catch (err) {
        console.error(`[import/confirmar] Erro ao baixar arquivo do B2. key=${key}`, err);
        return res.status(500).json({ erro: `Erro ao baixar arquivo do armazenamento temporário: ${err.message}` });
    }

    console.log(`[import/confirmar] iniciando processamento. arquivo=${localFilePath}`);
    try {
        await processarImportacaoEResponder(localFilePath, String(req.usuario.id), sync, res);
    } catch (err) {
        console.error(`[import/confirmar] Erro não tratado ao processar importação. arquivo=${localFilePath}`, err);
        if (!res.headersSent) {
            res.status(500).json({ erro: `Erro ao processar importação: ${err.message}` });
        }
    }
});

router.get('/', ...protegido, async (_req, res) => {
    return res.status(405).json({
        erro: 'Método não permitido. Use POST /api/import/upload-url + /api/import/confirmar (produção) ou POST /api/import com multipart/form-data no campo "arquivo" (dev local).',
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
            ORDER BY il.created_at DESC
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


