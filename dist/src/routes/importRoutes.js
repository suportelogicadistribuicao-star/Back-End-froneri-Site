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
var importRoutes_exports = {};
__export(importRoutes_exports, {
  default: () => importRoutes_default
});
module.exports = __toCommonJS(importRoutes_exports);
var import_express = require("express");
var import_fs = __toESM(require("fs"));
var import_path = __toESM(require("path"));
var import_promises = require("stream/promises");
var import_client_s3 = require("@aws-sdk/client-s3");
var import_auth = require("../middleware/auth");
var import_multer = __toESM(require("../config/multer"));
var import_b2 = require("../config/b2");
var import_uploadPolicy = require("../config/uploadPolicy");
var import_importService = require("../services/importService");
var import_database = require("../config/database");
const router = (0, import_express.Router)();
const protegido = [import_auth.authMiddleware, (0, import_auth.requireRole)("admin", "gerente")];
async function processarImportacaoEResponder(localFilePath, usuarioId, sync, res) {
  try {
    if (sync) {
      const resultado = await (0, import_importService.importarRelatorioVendas)(localFilePath, usuarioId);
      (0, import_multer.limparArquivosAntigos)();
      res.json({
        mensagem: "Relat\xF3rio de Vendas importado com sucesso.",
        importacaoId: resultado.logId,
        contadores: resultado.contadores
      });
      return;
    }
    const { logId, promise } = await (0, import_importService.iniciarImportacaoRelatorioVendas)(localFilePath, usuarioId);
    promise.then(() => {
      console.log(`[import/vendas] Importa\xE7\xE3o conclu\xEDda. logId=${logId}`);
      (0, import_multer.limparArquivosAntigos)();
    }).catch((err) => {
      console.error(`[import/vendas] Falha na importa\xE7\xE3o em background. logId=${logId}`, err);
    }).finally(() => {
      if (import_fs.default.existsSync(localFilePath)) {
        import_fs.default.unlinkSync(localFilePath);
      }
    });
    res.status(202).json({
      mensagem: "Importa\xE7\xE3o iniciada. Acompanhe o status pelo hist\xF3rico.",
      importacaoId: logId,
      status: "processando"
    });
  } catch (err) {
    console.error("[import/vendas]", err);
    res.status(500).json({ erro: `Erro na importa\xE7\xE3o: ${err.message}` });
  } finally {
    if (sync && import_fs.default.existsSync(localFilePath)) {
      import_fs.default.unlinkSync(localFilePath);
    }
  }
}
router.post("/", ...protegido, import_multer.default.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });
  const sync = String(req.query.sync || "").toLowerCase() === "true";
  await processarImportacaoEResponder(req.file.path, String(req.usuario.id), sync, res);
});
router.post("/upload-url", ...protegido, async (req, res) => {
  try {
    const nomeArquivo = String(req.body?.nomeArquivo || "").trim();
    if (!nomeArquivo) {
      return res.status(400).json({ erro: "Informe o nome do arquivo (nomeArquivo)." });
    }
    const ext = import_path.default.extname(nomeArquivo).toLowerCase();
    if (!import_uploadPolicy.ALLOWED_EXTENSIONS.includes(ext)) {
      return res.status(400).json({ erro: `Formato n\xE3o suportado: ${ext}. Use ${import_uploadPolicy.ALLOWED_EXTENSIONS.join(", ")}` });
    }
    const safe = nomeArquivo.replace(/[^a-z0-9._-]/gi, "_");
    const key = `imports/${req.usuario.id}/${Date.now()}_${safe}`;
    const uploadUrl = await (0, import_b2.getPresignedPutUrl)(key);
    console.log(`[B2] Presigned URL emitida. usuario=${req.usuario.id} key=${key}`);
    res.json({ uploadUrl, key, expiresIn: import_b2.PRESIGN_EXPIRES_SECONDS });
  } catch (err) {
    console.error("[B2] Erro ao gerar URL pr\xE9-assinada:", err.message);
    res.status(500).json({ erro: "Erro ao gerar URL pr\xE9-assinada. Verifique as credenciais do B2." });
  }
});
router.post("/confirmar", ...protegido, async (req, res) => {
  const key = String(req.body?.key || "").trim();
  const sync = String(req.query.sync || "").toLowerCase() === "true";
  console.log(`[import/confirmar] recebido. usuario=${req.usuario?.id} key=${key} sync=${sync}`);
  if (!key || key.includes("..")) {
    console.warn(`[import/confirmar] chave inv\xE1lida: "${key}"`);
    return res.status(400).json({ erro: "Chave de arquivo inv\xE1lida." });
  }
  if (!key.startsWith(`imports/${req.usuario.id}/`)) {
    console.warn(`[import/confirmar] chave fora do escopo do usu\xE1rio. usuario=${req.usuario.id} key=${key}`);
    return res.status(403).json({ erro: "Voc\xEA n\xE3o tem permiss\xE3o para acessar este arquivo." });
  }
  const ext = import_path.default.extname(key).toLowerCase();
  if (!import_uploadPolicy.ALLOWED_EXTENSIONS.includes(ext)) {
    return res.status(400).json({ erro: `Formato n\xE3o suportado: ${ext}. Use ${import_uploadPolicy.ALLOWED_EXTENSIONS.join(", ")}` });
  }
  let localFilePath;
  try {
    let head;
    try {
      head = await import_b2.s3Client.send(new import_client_s3.HeadObjectCommand({ Bucket: import_b2.B2_BUCKET, Key: key }));
      console.log(`[import/confirmar] HeadObject ok. key=${key} tamanho=${head.ContentLength}`);
    } catch (err) {
      console.error(`[import/confirmar] HeadObject falhou. key=${key}`, err);
      return res.status(404).json({
        erro: "Arquivo n\xE3o encontrado no armazenamento tempor\xE1rio. Verifique se o upload foi conclu\xEDdo ou solicite uma nova URL."
      });
    }
    const maxBytes = import_uploadPolicy.UPLOAD_MAX_SIZE_MB * 1024 * 1024;
    if ((head.ContentLength || 0) > maxBytes) {
      await import_b2.s3Client.send(new import_client_s3.DeleteObjectCommand({ Bucket: import_b2.B2_BUCKET, Key: key })).catch(() => {
      });
      return res.status(413).json({ erro: `Arquivo excede o tamanho m\xE1ximo de ${import_uploadPolicy.UPLOAD_MAX_SIZE_MB}MB.` });
    }
    const getResult = await import_b2.s3Client.send(new import_client_s3.GetObjectCommand({ Bucket: import_b2.B2_BUCKET, Key: key }));
    (0, import_multer.ensureUploadDir)();
    localFilePath = import_path.default.join(import_multer.UPLOAD_DIR, `${Date.now()}_${import_path.default.basename(key)}`);
    console.log(`[import/confirmar] baixando para ${localFilePath}`);
    await (0, import_promises.pipeline)(getResult.Body, import_fs.default.createWriteStream(localFilePath));
    console.log(`[import/confirmar] download conclu\xEDdo. ${localFilePath}`);
    import_b2.s3Client.send(new import_client_s3.DeleteObjectCommand({ Bucket: import_b2.B2_BUCKET, Key: key })).catch((err) => {
      console.error("[B2] Falha ao remover objeto ap\xF3s download:", err.message);
    });
  } catch (err) {
    console.error(`[import/confirmar] Erro ao baixar arquivo do B2. key=${key}`, err);
    return res.status(500).json({ erro: `Erro ao baixar arquivo do armazenamento tempor\xE1rio: ${err.message}` });
  }
  console.log(`[import/confirmar] iniciando processamento. arquivo=${localFilePath}`);
  try {
    await processarImportacaoEResponder(localFilePath, String(req.usuario.id), sync, res);
  } catch (err) {
    console.error(`[import/confirmar] Erro n\xE3o tratado ao processar importa\xE7\xE3o. arquivo=${localFilePath}`, err);
    if (!res.headersSent) {
      res.status(500).json({ erro: `Erro ao processar importa\xE7\xE3o: ${err.message}` });
    }
  }
});
router.get("/", ...protegido, async (_req, res) => {
  return res.status(405).json({
    erro: 'M\xE9todo n\xE3o permitido. Use POST /api/import/upload-url + /api/import/confirmar (produ\xE7\xE3o) ou POST /api/import com multipart/form-data no campo "arquivo" (dev local).'
  });
});
router.get("/historico", ...protegido, async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit || 20);
    const limit = Math.min(Math.max(rawLimit, 1), 100);
    const rows = await (0, import_database.query)(`
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
    res.status(500).json({ erro: "Erro ao buscar hist\xF3rico." });
  }
});
router.get("/historico/:id", ...protegido, async (req, res) => {
  try {
    const rows = await (0, import_database.query)(
      "SELECT * FROM importacoes_log WHERE id = $1",
      [req.params.id]
    );
    if (rows.rows.length === 0) return res.status(404).json({ erro: "Importa\xE7\xE3o n\xE3o encontrada." });
    res.json(rows.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar importa\xE7\xE3o." });
  }
});
var importRoutes_default = router;
