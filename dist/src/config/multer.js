var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var multer_exports = {};
__export(multer_exports, {
  UPLOAD_DIR: () => UPLOAD_DIR,
  default: () => multer_default,
  ensureUploadDir: () => ensureUploadDir,
  limparArquivosAntigos: () => limparArquivosAntigos
});
module.exports = __toCommonJS(multer_exports);
var import_multer = __toESM(require("multer"));
var import_os = __toESM(require("os"));
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
var import_uploadPolicy = require("./uploadPolicy");
const UPLOAD_DIR = process.env.UPLOAD_DIR || import_path.default.join(import_os.default.tmpdir(), "froneri-uploads");
function ensureUploadDir() {
  if (!import_fs.default.existsSync(UPLOAD_DIR)) import_fs.default.mkdirSync(UPLOAD_DIR, { recursive: true });
}
ensureUploadDir();
const storage = import_multer.default.diskStorage({
  destination: (_req, _file, cb) => {
    ensureUploadDir();
    cb(null, UPLOAD_DIR);
  },
  filename: (_req, file, cb) => {
    const ts = Date.now();
    const safe = file.originalname.replace(/[^a-z0-9._-]/gi, "_");
    cb(null, `${ts}_${safe}`);
  }
});
const fileFilter = (_req, file, cb) => {
  const ext = import_path.default.extname(file.originalname).toLowerCase();
  if (import_uploadPolicy.ALLOWED_EXTENSIONS.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Formato n\xE3o suportado: ${ext}. Use ${import_uploadPolicy.ALLOWED_EXTENSIONS.join(", ")}`));
  }
};
const upload = (0, import_multer.default)({
  storage,
  fileFilter,
  limits: { fileSize: import_uploadPolicy.UPLOAD_MAX_SIZE_MB * 1024 * 1024 }
});
const UPLOAD_STALE_MINUTES = parseInt(process.env.UPLOAD_STALE_MINUTES || "60", 10);
function limparArquivosAntigos() {
  ensureUploadDir();
  const limiteMs = UPLOAD_STALE_MINUTES * 60 * 1e3;
  const agora = Date.now();
  for (const nome of import_fs.default.readdirSync(UPLOAD_DIR)) {
    const caminho = import_path.default.join(UPLOAD_DIR, nome);
    try {
      const stat = import_fs.default.statSync(caminho);
      if (stat.isFile() && agora - stat.mtimeMs > limiteMs) {
        import_fs.default.unlinkSync(caminho);
        console.log(`[upload] Arquivo antigo removido: ${nome}`);
      }
    } catch (err) {
      console.error(`[upload] Falha ao limpar arquivo antigo ${nome}:`, err.message);
    }
  }
}
var multer_default = upload;
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  UPLOAD_DIR,
  ensureUploadDir,
  limparArquivosAntigos
});
