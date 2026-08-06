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
var cadastrosRoutes_exports = {};
__export(cadastrosRoutes_exports, {
  default: () => cadastrosRoutes_default
});
module.exports = __toCommonJS(cadastrosRoutes_exports);
var import_express = require("express");
var import_client_s3 = require("@aws-sdk/client-s3");
var import_multer = __toESM(require("multer"));
var import_fs = __toESM(require("fs"));
var import_crypto = require("crypto");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
var import_multer2 = require("../config/multer");
var import_b2 = require("../config/b2");
const router = (0, import_express.Router)();
const STATUS_VALIDOS = ["pendente", "em_analise", "aprovado", "recusado", "concluido"];
const CANAIS_VALIDOS = ["ATC", "C&C", "PQS", "SMR", "VAREJO"];
const VOLTAGENS_VALIDAS = ["110V", "220V"];
const CAMPOS_OBRIGATORIOS = [
  "cnpj",
  "razao_social",
  "canal_cliente",
  "segmento",
  "cidade",
  "email",
  "telefone",
  "dia_atendimento",
  "prospector",
  "vendedor_territorio",
  "modelo_freezer",
  "horario_recebimento_freezer"
];
const SOLD_GERADO_MIN = 900000001;
const SOLD_GERADO_MAX = 999999999;
function validarCampos(body) {
  const dados = {};
  for (const campo of CAMPOS_OBRIGATORIOS) {
    const valor = typeof body[campo] === "string" ? body[campo].trim() : body[campo];
    if (valor === void 0 || valor === null || valor === "") {
      return { erro: `Campo obrigat\xF3rio n\xE3o informado: ${campo}.` };
    }
    dados[campo] = String(valor);
  }
  if (body.cadastro_froneri_wmc === void 0 || body.cadastro_froneri_wmc === null || body.cadastro_froneri_wmc === "") {
    return { erro: "Campo obrigat\xF3rio n\xE3o informado: cadastro_froneri_wmc." };
  }
  dados.cadastro_froneri_wmc = ["true", "1", "sim", "s"].includes(String(body.cadastro_froneri_wmc).toLowerCase()) ? 1 : 0;
  if (dados.cnpj.replace(/\D/g, "").length !== 14) {
    return { erro: "CNPJ inv\xE1lido: informe os 14 d\xEDgitos." };
  }
  if (!CANAIS_VALIDOS.includes(dados.canal_cliente)) {
    return { erro: `Canal do cliente inv\xE1lido. Use: ${CANAIS_VALIDOS.join(", ")}.` };
  }
  const voltagem = typeof body.voltagem_freezer === "string" ? body.voltagem_freezer.trim().toUpperCase() : "";
  if (voltagem && !VOLTAGENS_VALIDAS.includes(voltagem)) {
    return { erro: "Voltagem do freezer inv\xE1lida. Use 110V ou 220V." };
  }
  dados.voltagem_freezer = voltagem || null;
  return { dados };
}
function chavesDasFotos(valor) {
  if (Array.isArray(valor)) return valor.filter((v) => typeof v === "string");
  if (typeof valor === "string" && valor.trim()) {
    try {
      const parsed = JSON.parse(valor);
      return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}
function limparTemporarios(files) {
  for (const file of files) {
    import_fs.default.unlink(file.path, () => {
    });
  }
}
async function apagarFotosDoB2(chaves) {
  await Promise.all(chaves.map(
    (chave) => import_b2.s3Client.send(new import_client_s3.DeleteObjectCommand({ Bucket: import_b2.B2_BUCKET, Key: chave })).catch((err) => console.error("[cadastros] Falha ao remover foto do B2:", chave, err.message))
  ));
}
async function subirFotosParaB2(files, cadastroId) {
  const chaves = [];
  try {
    for (const file of files) {
      const chave = `cadastros/${cadastroId}/${file.filename}`;
      await import_b2.s3Client.send(new import_client_s3.PutObjectCommand({
        Bucket: import_b2.B2_BUCKET,
        Key: chave,
        Body: import_fs.default.createReadStream(file.path),
        ContentType: file.mimetype,
        ContentLength: file.size
      }));
      chaves.push(chave);
    }
    return chaves;
  } catch (err) {
    await apagarFotosDoB2(chaves);
    throw err;
  }
}
function paraIso(valor) {
  if (valor instanceof Date) return valor.toISOString();
  return valor ?? null;
}
async function montarCadastro(row) {
  const chaves = chavesDasFotos(row.fotos);
  const fotos = await Promise.all(chaves.map((chave) => (0, import_b2.getPresignedGetUrl)(chave)));
  return {
    id: row.id,
    cadastro_froneri_wmc: ["1", "true", "sim", "s"].includes(String(row.cadastro_froneri_wmc).toLowerCase()),
    cnpj: row.cnpj,
    razao_social: row.razao_social,
    canal_cliente: row.canal_cliente ?? null,
    segmento: row.segmento ?? null,
    cidade: row.cidade ?? null,
    email: row.email ?? null,
    telefone: row.telefone ?? null,
    dia_atendimento: row.dia_atendimento ?? null,
    prospector: row.prospector ?? null,
    vendedor_territorio: row.vendedor_territorio ?? null,
    modelo_freezer: row.modelo_freezer ?? null,
    voltagem_freezer: row.voltagem_freezer ?? null,
    horario_recebimento_freezer: row.horario_recebimento_freezer ?? null,
    fotos,
    status: row.status,
    observacao: row.observacao ?? null,
    codigo_vendedor: row.codigo_vendedor != null ? String(row.codigo_vendedor) : null,
    vendedor_nome: row.vendedor_nome_atual ?? row.vendedor_nome ?? null,
    criado_em: paraIso(row.created_at),
    atualizado_em: paraIso(row.updated_at)
  };
}
const SELECT_CADASTRO = `
    SELECT c.*, v.codigo_vendedor, v.nome AS vendedor_nome_atual
    FROM cadastros c
    LEFT JOIN vendedores v ON v.id = c.vendedor_id
`;
async function buscarCadastro(id) {
  const res = await (0, import_database.query)(`${SELECT_CADASTRO} WHERE c.id = $1 LIMIT 1`, [id]);
  return res.rows[0] || null;
}
function uploadFotosMiddleware(req, res, next) {
  import_multer2.uploadFotos.array("fotos", import_multer2.FOTOS_MAX_ARQUIVOS)(req, res, (err) => {
    if (!err) return next();
    let mensagem = err.message || "Falha no upload das fotos.";
    if (err instanceof import_multer.default.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        mensagem = `Cada arquivo deve ter no m\xE1ximo ${import_multer2.FOTO_MAX_SIZE_MB} MB.`;
      } else if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
        mensagem = `Envie no m\xE1ximo ${import_multer2.FOTOS_MAX_ARQUIVOS} arquivos.`;
      }
    }
    return res.status(400).json({ erro: mensagem });
  });
}
router.get("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const { status, vendedor_id, page = 1, limit = 1e3 } = req.query;
    const where = [];
    const params = [];
    let p = 1;
    if (req.filtroVendedor) {
      where.push(`c.vendedor_id = $${p++}`);
      params.push(req.filtroVendedor);
    } else if (vendedor_id !== void 0 && vendedor_id !== "") {
      if (/^\d+$/.test(String(vendedor_id))) {
        where.push(`v.codigo_vendedor = $${p++}`);
        params.push(Number(vendedor_id));
      } else {
        where.push(`c.vendedor_id = $${p++}`);
        params.push(String(vendedor_id));
      }
    }
    if (status) {
      if (!STATUS_VALIDOS.includes(String(status))) {
        return res.status(400).json({ erro: `Status inv\xE1lido. Use: ${STATUS_VALIDOS.join(", ")}.` });
      }
      where.push(`c.status = $${p++}`);
      params.push(String(status));
    }
    const wStr = where.length ? "WHERE " + where.join(" AND ") : "";
    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = Math.min(Math.max(Number(limit) || 1e3, 1), 2e3);
    const offset = (pageNum - 1) * limitNum;
    const rows = await (0, import_database.query)(`
            ${SELECT_CADASTRO}
            ${wStr}
            ORDER BY c.created_at DESC
            LIMIT $${p++} OFFSET $${p++}
        `, [...params, limitNum, offset]);
    res.json(await Promise.all(rows.rows.map(montarCadastro)));
  } catch (err) {
    console.error("[cadastros/get]", err);
    res.status(500).json({ erro: "Erro ao listar solicita\xE7\xF5es de cadastro." });
  }
});
router.post("/", import_auth.authMiddleware, import_auth.ownDataOnly, uploadFotosMiddleware, async (req, res) => {
  const files = req.files || [];
  try {
    const { erro, dados } = validarCampos(req.body || {});
    if (erro) return res.status(400).json({ erro });
    if (files.length === 0) {
      return res.status(400).json({ erro: "Envie ao menos 1 foto do ponto de venda." });
    }
    const id = (0, import_crypto.randomUUID)();
    const chaves = await subirFotosParaB2(files, id);
    try {
      await (0, import_database.query)(`
                INSERT INTO cadastros (
                    id, cadastro_froneri_wmc, cnpj, razao_social, canal_cliente, segmento,
                    cidade, email, telefone, dia_atendimento, prospector, vendedor_territorio,
                    modelo_freezer, voltagem_freezer, horario_recebimento_freezer, fotos,
                    status, vendedor_id, vendedor_nome
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            `, [
        id,
        dados.cadastro_froneri_wmc,
        dados.cnpj,
        dados.razao_social,
        dados.canal_cliente,
        dados.segmento,
        dados.cidade,
        dados.email,
        dados.telefone,
        dados.dia_atendimento,
        dados.prospector,
        dados.vendedor_territorio,
        dados.modelo_freezer,
        dados.voltagem_freezer,
        dados.horario_recebimento_freezer,
        JSON.stringify(chaves),
        "pendente",
        req.usuario?.vendedor_id || null,
        req.usuario?.nome ? String(req.usuario.nome) : null
      ]);
    } catch (err) {
      await apagarFotosDoB2(chaves);
      throw err;
    }
    const row = await buscarCadastro(id);
    res.status(201).json(await montarCadastro(row));
  } catch (err) {
    console.error("[cadastros/post]", err);
    res.status(500).json({ erro: "Erro ao criar solicita\xE7\xE3o de cadastro." });
  } finally {
    limparTemporarios(files);
  }
});
router.put("/:id", import_auth.authMiddleware, (0, import_auth.requireRole)("admin", "gerente"), uploadFotosMiddleware, async (req, res) => {
  const files = req.files || [];
  try {
    const existente = await buscarCadastro(req.params.id);
    if (!existente) return res.status(404).json({ erro: "Solicita\xE7\xE3o de cadastro n\xE3o encontrada." });
    const { erro, dados } = validarCampos(req.body || {});
    if (erro) return res.status(400).json({ erro });
    const chavesAtuais = chavesDasFotos(existente.fotos);
    if (chavesAtuais.length + files.length > import_multer2.FOTOS_MAX_ARQUIVOS) {
      return res.status(400).json({
        erro: `A solicita\xE7\xE3o j\xE1 tem ${chavesAtuais.length} arquivo(s); o m\xE1ximo \xE9 ${import_multer2.FOTOS_MAX_ARQUIVOS}. Exclua e recrie para trocar as fotos.`
      });
    }
    const chavesNovas = files.length ? await subirFotosParaB2(files, existente.id) : [];
    const chaves = [...chavesAtuais, ...chavesNovas];
    try {
      await (0, import_database.query)(`
                UPDATE cadastros SET
                    cadastro_froneri_wmc = $1, cnpj = $2, razao_social = $3, canal_cliente = $4,
                    segmento = $5, cidade = $6, email = $7, telefone = $8, dia_atendimento = $9,
                    prospector = $10, vendedor_territorio = $11, modelo_freezer = $12,
                    voltagem_freezer = $13, horario_recebimento_freezer = $14, fotos = $15
                WHERE id = $16
            `, [
        dados.cadastro_froneri_wmc,
        dados.cnpj,
        dados.razao_social,
        dados.canal_cliente,
        dados.segmento,
        dados.cidade,
        dados.email,
        dados.telefone,
        dados.dia_atendimento,
        dados.prospector,
        dados.vendedor_territorio,
        dados.modelo_freezer,
        dados.voltagem_freezer,
        dados.horario_recebimento_freezer,
        JSON.stringify(chaves),
        existente.id
      ]);
    } catch (err) {
      await apagarFotosDoB2(chavesNovas);
      throw err;
    }
    const row = await buscarCadastro(existente.id);
    res.json(await montarCadastro(row));
  } catch (err) {
    console.error("[cadastros/put]", err);
    res.status(500).json({ erro: "Erro ao atualizar solicita\xE7\xE3o de cadastro." });
  } finally {
    limparTemporarios(files);
  }
});
router.put("/:id/status", import_auth.authMiddleware, (0, import_auth.requireRole)("admin", "gerente"), async (req, res) => {
  try {
    const { status, observacao } = req.body || {};
    if (!status || !STATUS_VALIDOS.includes(String(status))) {
      return res.status(400).json({ erro: `Status inv\xE1lido. Use: ${STATUS_VALIDOS.join(", ")}.` });
    }
    const existente = await buscarCadastro(req.params.id);
    if (!existente) return res.status(404).json({ erro: "Solicita\xE7\xE3o de cadastro n\xE3o encontrada." });
    const novaObservacao = observacao !== void 0 ? String(observacao).trim() || null : existente.observacao;
    if (String(status) === "concluido" && !existente.customer_number) {
      await (0, import_database.withTransaction)(async (client) => {
        const proximoRes = await client.query(`
                    SELECT COALESCE(MAX(customer_number), ${SOLD_GERADO_MIN - 1}) + 1 AS proximo
                    FROM clientes
                    WHERE customer_number BETWEEN ${SOLD_GERADO_MIN} AND ${SOLD_GERADO_MAX}
                `);
        const customerNumber = Number(proximoRes.rows[0].proximo);
        let territoryNumber = null;
        if (existente.vendedor_id) {
          const vRes = await client.query(
            "SELECT territory_number FROM vendedores WHERE id = $1",
            [existente.vendedor_id]
          );
          territoryNumber = vRes.rows[0]?.territory_number ?? null;
        }
        await client.query(`
                    INSERT INTO clientes (
                        id, customer_number, customer_name, cnpj, city, canal_cliente,
                        telefone, status, nova_rup, vendedor_id, territory_number, observacao
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
                `, [
          (0, import_crypto.randomUUID)(),
          customerNumber,
          existente.razao_social,
          existente.cnpj,
          existente.cidade,
          existente.canal_cliente,
          existente.telefone,
          "C",
          "Cliente Novo",
          existente.vendedor_id,
          territoryNumber,
          `Criado a partir da solicita\xE7\xE3o de cadastro ${existente.id}`
        ]);
        await client.query(
          "UPDATE cadastros SET status = $1, observacao = $2, customer_number = $3 WHERE id = $4",
          ["concluido", novaObservacao, customerNumber, existente.id]
        );
      });
    } else {
      await (0, import_database.query)(
        "UPDATE cadastros SET status = $1, observacao = $2 WHERE id = $3",
        [String(status), novaObservacao, existente.id]
      );
    }
    const row = await buscarCadastro(existente.id);
    res.json(await montarCadastro(row));
  } catch (err) {
    console.error("[cadastros/status]", err);
    res.status(500).json({ erro: "Erro ao atualizar status da solicita\xE7\xE3o." });
  }
});
router.delete("/:id", import_auth.authMiddleware, async (req, res) => {
  try {
    const existente = await buscarCadastro(req.params.id);
    if (!existente) return res.status(404).json({ erro: "Solicita\xE7\xE3o de cadastro n\xE3o encontrada." });
    const ehGestor = ["admin", "gerente"].includes(String(req.usuario?.role || ""));
    if (!ehGestor) {
      if (!req.usuario?.vendedor_id || String(existente.vendedor_id) !== String(req.usuario.vendedor_id)) {
        return res.status(403).json({ erro: "Voc\xEA s\xF3 pode excluir as pr\xF3prias solicita\xE7\xF5es." });
      }
      if (!["pendente", "em_analise"].includes(existente.status)) {
        return res.status(403).json({ erro: "Solicita\xE7\xE3o j\xE1 analisada \u2014 apenas a gest\xE3o pode exclu\xED-la." });
      }
    }
    await (0, import_database.query)("DELETE FROM cadastros WHERE id = $1", [existente.id]);
    await apagarFotosDoB2(chavesDasFotos(existente.fotos));
    res.status(204).send();
  } catch (err) {
    console.error("[cadastros/delete]", err);
    res.status(500).json({ erro: "Erro ao excluir solicita\xE7\xE3o de cadastro." });
  }
});
var cadastrosRoutes_default = router;
