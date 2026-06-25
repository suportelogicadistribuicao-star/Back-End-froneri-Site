var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var vendedoresRoutes_exports = {};
__export(vendedoresRoutes_exports, {
  default: () => vendedoresRoutes_default
});
module.exports = __toCommonJS(vendedoresRoutes_exports);
var import_express = require("express");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
const router = (0, import_express.Router)();
router.get("/aliases/todos", import_auth.authMiddleware, async (_req, res) => {
  try {
    const rows = await (0, import_database.query)(`
            SELECT v.id, v.codigo_vendedor, v.setor, v.territory_number, v.vendedor_alias,
                   v.nome, v.email, v.telefone, v.ativo,
                   (v.nome IS NOT NULL) AS preenchido,
                   COALESCE(cc.total_clientes, 0) AS total_clientes
            FROM vendedores v
            LEFT JOIN (
                SELECT vendedor_id, COUNT(*) AS total_clientes
                FROM clientes
                WHERE status = 'C'
                GROUP BY vendedor_id
            ) cc ON cc.vendedor_id = v.id
            ORDER BY v.vendedor_alias
        `);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao listar todos os aliases." });
  }
});
router.post("/", import_auth.authMiddleware, async (req, res) => {
  const { alias_id, nome, email, telefone } = req.body;
  if (!alias_id) return res.status(400).json({ erro: "alias_id \xE9 obrigat\xF3rio." });
  if (!nome?.trim()) return res.status(400).json({ erro: "Nome \xE9 obrigat\xF3rio." });
  try {
    const slotRes = await (0, import_database.query)(
      "SELECT id FROM vendedores WHERE id = $1 AND nome IS NULL AND ativo = TRUE",
      [alias_id]
    );
    if (slotRes.rows.length === 0)
      return res.status(404).json({ erro: "Slot de alias n\xE3o encontrado ou j\xE1 associado a um vendedor." });
    await (0, import_database.query)(`
            UPDATE vendedores SET
                nome       = $1,
                email      = $2,
                telefone   = $3,
                updated_at = NOW()
            WHERE id = $4
        `, [nome.trim(), email || null, telefone || null, alias_id]);
    const result = await (0, import_database.query)("SELECT * FROM vendedores WHERE id = $1", [alias_id]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao criar vendedor." });
  }
});
router.get("/", import_auth.authMiddleware, async (_req, res) => {
  try {
    const rows = await (0, import_database.query)(`
            SELECT v.*, u.email, COALESCE(cc.total_clientes, 0) AS total_clientes
            FROM vendedores v
            LEFT JOIN usuarios u ON u.id = v.usuario_id
            LEFT JOIN (
                SELECT vendedor_id, COUNT(*) AS total_clientes
                FROM clientes
                WHERE status = 'C'
                GROUP BY vendedor_id
            ) cc ON cc.vendedor_id = v.id
            WHERE v.ativo = TRUE
            ORDER BY v.nome
        `);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao listar vendedores." });
  }
});
router.get("/:id/resumo", import_auth.authMiddleware, async (req, res) => {
  try {
    const mesAtual = (/* @__PURE__ */ new Date()).getMonth() + 1;
    const anoAtual = (/* @__PURE__ */ new Date()).getFullYear();
    const [vendedor, kpis, ruptura, roteirizacao] = await Promise.all([
      (0, import_database.query)("SELECT * FROM vendedores WHERE id = $1", [req.params.id]),
      (0, import_database.query)(`
                SELECT
                    COUNT(DISTINCT ve.customer_number) AS clientes_atendidos,
                    SUM(ve.valor_nf) AS valor_nf,
                    SUM(ve.soma_litros) AS litros,
                    SUM(ve.soma_caixas) AS caixas
                FROM vendas ve
                WHERE ve.vendedor_id = $1 AND ve.mes_numero = $2 AND ve.ano = $3
            `, [req.params.id, mesAtual, anoAtual]),
      (0, import_database.query)(`
                SELECT COUNT(*) AS total FROM ruptura
                WHERE vendedor_id = $1 AND mes_numero = $2 AND ano = $3
            `, [req.params.id, mesAtual, anoAtual]),
      (0, import_database.query)(`
                SELECT dia_semana, COUNT(*) AS total_clientes
                FROM roteirizacao WHERE vendedor_id = $1 AND ativa = TRUE
                GROUP BY dia_semana ORDER BY dia_semana
            `, [req.params.id])
    ]);
    if (vendedor.rows.length === 0) return res.status(404).json({ erro: "Vendedor n\xE3o encontrado." });
    res.json({
      ...vendedor.rows[0],
      kpis: kpis.rows[0],
      ruptura: ruptura.rows[0],
      roteirizacao: roteirizacao.rows
    });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar resumo do vendedor." });
  }
});
var vendedoresRoutes_default = router;
