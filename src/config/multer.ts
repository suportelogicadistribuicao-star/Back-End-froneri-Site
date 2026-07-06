import multer from 'multer';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { ALLOWED_EXTENSIONS, UPLOAD_MAX_SIZE_MB } from './uploadPolicy';

// Fora da pasta da aplicação de propósito: o "Restart automático" do painel
// da KingHost reinicia o processo ao detectar qualquer arquivo novo dentro do
// diretório do app, o que derrubava a requisição no meio do download do B2
// quando UPLOAD_DIR era relativo (./uploads, dentro da pasta observada).
export const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'froneri-uploads');

// Alguns provedores de hospedagem compartilhada limpam periodicamente o /tmp
// (inclusive a própria pasta, não só os arquivos dentro dela). Como o processo
// Node fica de pé por muito tempo, não basta criar a pasta uma vez no boot —
// ela precisa ser garantida a cada uso.
export function ensureUploadDir(): void {
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

ensureUploadDir();

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
        ensureUploadDir();
        cb(null, UPLOAD_DIR);
    },
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
    ensureUploadDir();
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

