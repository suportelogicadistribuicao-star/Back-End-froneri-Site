const multer = require('multer');
const path   = require('path');
const fs     = require('fs');

const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
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
    const allowed = ['.xlsx', '.xlsb', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
        cb(null, true);
    } else {
        cb(new Error(`Formato não suportado: ${ext}. Use ${allowed.join(', ')}`));
    }
};

const maxMB = parseInt(process.env.UPLOAD_MAX_SIZE_MB || '50');

const upload = multer({
    storage,
    fileFilter,
    limits: { fileSize: maxMB * 1024 * 1024 }
});

module.exports = upload;
