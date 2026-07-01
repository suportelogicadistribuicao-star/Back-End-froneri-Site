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
var import_auth = require("../middleware/auth");
var import_multer = __toESM(require("../config/multer"));
var import_importService = require("../services/importService");
var import_database = require("../config/database");
const router = (0, import_express.Router)();
const protegido = [import_auth.authMiddleware, (0, import_auth.requireRole)("admin", "gerente")];
router.post("/vendas", ...protegido, import_multer.default.single("arquivo"), async (req, res) => {
  if (!req.file) return res.status(400).json({ erro: "Nenhum arquivo enviado." });
  const sync = String(req.query.sync || "").toLowerCase() === "true";
  const uploadedFilePath = req.file.path;
  try {
    if (sync) {
      const resultado = await (0, import_importService.importarRelatorioVendas)(uploadedFilePath, String(req.usuario.id));
      res.json({
        mensagem: "Relat\xF3rio de Vendas importado com sucesso.",
        importacaoId: resultado.logId,
        contadores: resultado.contadores
      });
      return;
    }
    const { logId, promise } = await (0, import_importService.iniciarImportacaoRelatorioVendas)(uploadedFilePath, String(req.usuario.id));
    promise.then(() => {
      console.log(`[import/vendas] Importa\xE7\xE3o conclu\xEDda. logId=${logId}`);
    }).catch((err) => {
      console.error(`[import/vendas] Falha na importa\xE7\xE3o em background. logId=${logId}`, err);
    }).finally(() => {
      if (import_fs.default.existsSync(uploadedFilePath)) {
        import_fs.default.unlinkSync(uploadedFilePath);
      }
    });
    return res.status(202).json({
      mensagem: "Importa\xE7\xE3o iniciada. Acompanhe o status pelo hist\xF3rico.",
      importacaoId: logId,
      status: "processando"
    });
  } catch (err) {
    console.error("[import/vendas]", err);
    res.status(500).json({ erro: `Erro na importa\xE7\xE3o: ${err.message}` });
  } finally {
    if (sync && import_fs.default.existsSync(uploadedFilePath)) {
      import_fs.default.unlinkSync(uploadedFilePath);
    }
  }
});
router.get("/vendas", ...protegido, async (_req, res) => {
  return res.status(405).json({
    erro: 'M\xE9todo n\xE3o permitido. Use POST /api/import/vendas com multipart/form-data no campo "arquivo".'
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
            ORDER BY il.id DESC
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
