"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const UPLOAD_DIR = process.env.UPLOAD_DIR || './uploads';
if (!fs_1.default.existsSync(UPLOAD_DIR))
    fs_1.default.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer_1.default.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const ts = Date.now();
        const safe = file.originalname.replace(/[^a-z0-9._-]/gi, '_');
        cb(null, `${ts}_${safe}`);
    }
});
const fileFilter = (_req, file, cb) => {
    const allowed = ['.xlsx', '.xlsb', '.xls'];
    const ext = path_1.default.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
        cb(null, true);
    }
    else {
        cb(new Error(`Formato não suportado: ${ext}. Use ${allowed.join(', ')}`));
    }
};
const maxMB = parseInt(process.env.UPLOAD_MAX_SIZE_MB || '50');
const upload = (0, multer_1.default)({
    storage,
    fileFilter,
    limits: { fileSize: maxMB * 1024 * 1024 }
});
exports.default = upload;
