import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { ALLOWED_EXTENSIONS, UPLOAD_MAX_SIZE_MB } from './uploadPolicy';

export const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ts   = Date.now();
        const safe = file.originalname.replace(/[^a-z0-9._-]/gi, '_');
        cb(null, `${ts}_${safe}`);
    }
});

const fileFilter = (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error(`Formato não suportado: ${ext}. Use ${ALLOWED_EXTENSIONS.join(', ')}`));
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: UPLOAD_MAX_SIZE_MB * 1024 * 1024 }
});

const UPLOAD_STALE_MINUTES = parseInt(process.env.UPLOAD_STALE_MINUTES || '60', 10);

// Remove arquivos esquecidos em UPLOAD_DIR (ex.: sobras de um processo morto
// no meio de uma importação, antes do fs.unlinkSync da rota rodar). Não mexe
// em arquivos recentes, para não afetar uma importação concorrente em andamento.
export function limparArquivosAntigos(): void {
    const limiteMs = UPLOAD_STALE_MINUTES * 60 * 1000;
    const agora = Date.now();
    for (const nome of fs.readdirSync(UPLOAD_DIR)) {
        const caminho = path.join(UPLOAD_DIR, nome);
        try {
            const stat = fs.statSync(caminho);
            if (stat.isFile() && agora - stat.mtimeMs > limiteMs) {
                fs.unlinkSync(caminho);
                console.log(`[upload] Arquivo antigo removido: ${nome}`);
            }
        } catch (err) {
            console.error(`[upload] Falha ao limpar arquivo antigo ${nome}:`, err.message);
        }
    }
}

export default upload;

