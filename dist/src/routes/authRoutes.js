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
var authRoutes_exports = {};
__export(authRoutes_exports, {
  default: () => authRoutes_default
});
module.exports = __toCommonJS(authRoutes_exports);
var import_express = require("express");
var import_bcryptjs = __toESM(require("bcryptjs"));
var import_jsonwebtoken = __toESM(require("jsonwebtoken"));
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
const router = (0, import_express.Router)();
const JWT_SECRET = process.env.JWT_SECRET;
const ROLES_PERMITIDAS = ["admin", "gerente", "vendedor"];
function extrairTokenDoHeader(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  return authHeader.split(" ")[1];
}
router.post("/login", async (req, res) => {
  try {
    const { email, senha } = req.body;
    if (!email || !senha) {
      return res.status(400).json({ erro: "Email e senha s\xE3o obrigat\xF3rios." });
    }
    const result = await (0, import_database.query)(
      `SELECT
                u.id,
                u.nome,
                u.email,
                u.role,
                u.senha_hash,
                u.ativo,
                u.ultimo_login,
                v.id AS vendedor_id,
                v.nome AS vendedor_nome,
                v.setor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.email = $1 AND u.ativo = TRUE
             LIMIT 1`,
      [email.toLowerCase().trim()]
    );
    if (result.rows.length === 0) {
      return res.status(401).json({ erro: "Credenciais inv\xE1lidas." });
    }
    const usuario = result.rows[0];
    const senhaOk = await import_bcryptjs.default.compare(senha, usuario.senha_hash);
    if (!senhaOk) {
      return res.status(401).json({ erro: "Credenciais inv\xE1lidas." });
    }
    await (0, import_database.query)("UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1", [usuario.id]);
    const token = import_jsonwebtoken.default.sign(
      {
        id: usuario.id,
        email: usuario.email,
        role: usuario.role,
        nome: usuario.nome,
        vendedor_id: usuario.vendedor_id || null,
        setor: usuario.setor || null
      },
      JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || "8h" }
    );
    res.json({
      token,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        email: usuario.email,
        role: usuario.role,
        vendedor_id: usuario.vendedor_id,
        vendedorNome: usuario.vendedor_nome,
        setor: usuario.setor
      }
    });
  } catch (err) {
    console.error("[auth/login]", err);
    res.status(500).json({ erro: "Erro ao fazer login." });
  }
});
router.post("/register", async (req, res) => {
  try {
    const { nome, email, senha, role } = req.body;
    if (!nome || !email || !senha) {
      return res.status(400).json({ erro: "Nome, email e senha s\xE3o obrigat\xF3rios." });
    }
    if (String(senha).length < 8) {
      return res.status(400).json({ erro: "A senha deve ter ao menos 8 caracteres." });
    }
    const emailNormalizado = String(email).toLowerCase().trim();
    const nomeNormalizado = String(nome).trim();
    const totalRes = await (0, import_database.query)("SELECT COUNT(*)::int AS total FROM usuarios");
    const primeiroCadastro = (totalRes.rows[0]?.total || 0) === 0;
    if (!primeiroCadastro) {
      const token = extrairTokenDoHeader(req);
      if (!token) {
        return res.status(401).json({ erro: "Token de autentica\xE7\xE3o n\xE3o fornecido." });
      }
      let payload;
      try {
        payload = import_jsonwebtoken.default.verify(token, JWT_SECRET);
      } catch (_err) {
        return res.status(401).json({ erro: "Token inv\xE1lido." });
      }
      if (payload.role !== "admin") {
        return res.status(403).json({ erro: "Apenas admin pode cadastrar usu\xE1rios." });
      }
    }
    const existente = await (0, import_database.query)("SELECT id FROM usuarios WHERE email = $1 LIMIT 1", [emailNormalizado]);
    if (existente.rows.length > 0) {
      return res.status(409).json({ erro: "Email j\xE1 cadastrado." });
    }
    let roleFinal = String(role || "vendedor").toLowerCase().trim();
    if (primeiroCadastro) {
      roleFinal = "admin";
    } else if (!ROLES_PERMITIDAS.includes(roleFinal)) {
      return res.status(400).json({ erro: "Role inv\xE1lida. Use: admin, gerente ou vendedor." });
    }
    const senhaHash = await import_bcryptjs.default.hash(String(senha), 12);
    const criadoInsert = await (0, import_database.query)(
      `INSERT INTO usuarios (nome, email, senha_hash, role, ativo)
             VALUES ($1, $2, $3, $4, TRUE)`,
      [nomeNormalizado, emailNormalizado, senhaHash, roleFinal]
    );
    const criado = await (0, import_database.query)(
      "SELECT id, nome, email, role, ativo FROM usuarios WHERE id = $1",
      [criadoInsert.insertId]
    );
    return res.status(201).json({
      mensagem: "Usu\xE1rio criado com sucesso.",
      usuario: criado.rows[0]
    });
  } catch (err) {
    console.error("[auth/register]", err);
    return res.status(500).json({ erro: "Erro ao registrar usu\xE1rio." });
  }
});
router.post("/register-vendedor", import_auth.authMiddleware, (0, import_auth.requireRole)("admin"), async (req, res) => {
  try {
    const { vendedorId, email, senha, nome } = req.body;
    if (!vendedorId || !email || !senha) {
      return res.status(400).json({ erro: "vendedorId, email e senha s\xE3o obrigat\xF3rios." });
    }
    if (String(senha).length < 8) {
      return res.status(400).json({ erro: "A senha deve ter ao menos 8 caracteres." });
    }
    const vendedorRes = await (0, import_database.query)(
      "SELECT id, nome, usuario_id, ativo FROM vendedores WHERE id = $1",
      [vendedorId]
    );
    if (vendedorRes.rows.length === 0) {
      return res.status(404).json({ erro: "Vendedor n\xE3o encontrado." });
    }
    const vendedor = vendedorRes.rows[0];
    if (!vendedor.ativo) {
      return res.status(400).json({ erro: "Vendedor inativo. Ative o cadastro antes de criar acesso." });
    }
    if (vendedor.usuario_id) {
      return res.status(409).json({ erro: "Este vendedor j\xE1 possui usu\xE1rio vinculado." });
    }
    const emailNormalizado = String(email).toLowerCase().trim();
    const nomeFinal = String(nome || vendedor.nome || "").trim();
    if (!nomeFinal) {
      return res.status(400).json({ erro: "Nome do usu\xE1rio inv\xE1lido." });
    }
    const emailEmUso = await (0, import_database.query)("SELECT id FROM usuarios WHERE email = $1 LIMIT 1", [emailNormalizado]);
    if (emailEmUso.rows.length > 0) {
      return res.status(409).json({ erro: "Email j\xE1 cadastrado." });
    }
    const senhaHash = await import_bcryptjs.default.hash(String(senha), 12);
    const resultado = await (0, import_database.withTransaction)(async (client) => {
      const usuarioCriadoInsert = await client.query(
        `INSERT INTO usuarios (nome, email, senha_hash, role, ativo)
                 VALUES ($1, $2, $3, 'vendedor', TRUE)`,
        [nomeFinal, emailNormalizado, senhaHash]
      );
      const usuarioId = usuarioCriadoInsert.insertId;
      const usuarioCriado = await client.query(
        "SELECT id, nome, email, role, ativo FROM usuarios WHERE id = $1",
        [usuarioId]
      );
      const vinculacao = await client.query(
        "UPDATE vendedores SET usuario_id = $1 WHERE id = $2 AND usuario_id IS NULL",
        [usuarioId, vendedor.id]
      );
      if (vinculacao.rowCount !== 1) {
        throw new Error("N\xE3o foi poss\xEDvel vincular o usu\xE1rio ao vendedor.");
      }
      return {
        usuario: usuarioCriado.rows[0],
        vendedor: { id: vendedor.id, nome: vendedor.nome }
      };
    });
    return res.status(201).json({
      mensagem: "Acesso do vendedor criado e vinculado com sucesso.",
      ...resultado
    });
  } catch (err) {
    console.error("[auth/register-vendedor]", err);
    return res.status(500).json({ erro: "Erro ao criar acesso do vendedor." });
  }
});
router.get("/me", import_auth.authMiddleware, async (req, res) => {
  try {
    const result = await (0, import_database.query)(
      `SELECT u.id, u.nome, u.email, u.role, u.ultimo_login,
                    v.id AS vendedor_id, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.id = $1
             LIMIT 1`,
      [req.usuario.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ erro: "Usu\xE1rio n\xE3o encontrado." });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar dados do usu\xE1rio." });
  }
});
async function alterarSenhaHandler(req, res) {
  try {
    const { senhaAtual, novaSenha } = req.body;
    if (!senhaAtual || !novaSenha || novaSenha.length < 8) {
      return res.status(400).json({ erro: "Nova senha deve ter ao menos 8 caracteres." });
    }
    const result = await (0, import_database.query)("SELECT senha_hash FROM usuarios WHERE id = $1", [req.usuario.id]);
    const ok = await import_bcryptjs.default.compare(senhaAtual, result.rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: "Senha atual incorreta." });
    const hash = await import_bcryptjs.default.hash(novaSenha, 12);
    await (0, import_database.query)("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hash, req.usuario.id]);
    res.json({ mensagem: "Senha alterada com sucesso." });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao alterar senha." });
  }
}
router.put("/senha", import_auth.authMiddleware, alterarSenhaHandler);
router.patch("/trocar-senha", import_auth.authMiddleware, alterarSenhaHandler);
router.patch("/reset-senha-vendedor", import_auth.authMiddleware, (0, import_auth.requireRole)("admin"), async (req, res) => {
  try {
    const { vendedorId, novaSenha } = req.body;
    if (!vendedorId || !novaSenha) {
      return res.status(400).json({ erro: "vendedorId e novaSenha s\xE3o obrigat\xF3rios." });
    }
    if (String(novaSenha).length < 8) {
      return res.status(400).json({ erro: "A nova senha deve ter ao menos 8 caracteres." });
    }
    const vendedorRes = await (0, import_database.query)(
      `SELECT v.id, v.nome, v.usuario_id, u.email
             FROM vendedores v
             LEFT JOIN usuarios u ON u.id = v.usuario_id
             WHERE v.id = $1`,
      [vendedorId]
    );
    if (vendedorRes.rows.length === 0) {
      return res.status(404).json({ erro: "Vendedor n\xE3o encontrado." });
    }
    const vendedor = vendedorRes.rows[0];
    if (!vendedor.usuario_id) {
      return res.status(400).json({ erro: "Vendedor sem usu\xE1rio vinculado." });
    }
    const hash = await import_bcryptjs.default.hash(String(novaSenha), 12);
    await (0, import_database.query)("UPDATE usuarios SET senha_hash = $1 WHERE id = $2", [hash, vendedor.usuario_id]);
    return res.json({
      mensagem: "Senha do vendedor redefinida com sucesso.",
      vendedor: {
        id: vendedor.id,
        nome: vendedor.nome,
        email: vendedor.email
      }
    });
  } catch (err) {
    console.error("[auth/reset-senha-vendedor]", err);
    return res.status(500).json({ erro: "Erro ao redefinir senha do vendedor." });
  }
});
var authRoutes_default = router;
