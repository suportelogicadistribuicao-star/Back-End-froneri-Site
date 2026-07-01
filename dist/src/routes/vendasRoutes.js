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
var vendasRoutes_exports = {};
__export(vendasRoutes_exports, {
  default: () => vendasRoutes_default
});
module.exports = __toCommonJS(vendasRoutes_exports);
var import_express = require("express");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
const router = (0, import_express.Router)();
router.get("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const { mes, ano, vendedor_id, canal, categoria, page = 1, limit = 100 } = req.query;
    const where = [];
    const params = [];
    let p = 1;
    const fvId = req.filtroVendedor || vendedor_id;
    if (fvId) {
      where.push(`vendedor_id = $${p++}`);
      params.push(fvId);
    }
    if (mes) {
      where.push(`mes_numero = $${p++}`);
      params.push(Number(mes));
    }
    if (ano) {
      where.push(`ano = $${p++}`);
      params.push(Number(ano));
    }
    if (canal) {
      where.push(`canal_cliente = $${p++}`);
      params.push(canal);
    }
    if (categoria) {
      where.push(`categoria = $${p++}`);
      params.push(categoria);
    }
    const offset = (Number(page) - 1) * Number(limit);
    const wStr = where.length ? "WHERE " + where.join(" AND ") : "";
    const [total, rows] = await Promise.all([
      (0, import_database.query)(`SELECT COUNT(*) AS count FROM vendas ${wStr}`, params),
      (0, import_database.query)(`
                SELECT ve.*, v.nome AS vendedor_nome
                FROM vendas ve
                LEFT JOIN vendedores v ON v.id = ve.vendedor_id
                ${wStr}
                ORDER BY ve.data_faturamento DESC
                LIMIT $${p++} OFFSET $${p++}
            `, [...params, Number(limit), offset])
    ]);
    res.json({ total: Number(total.rows[0].count), pagina: Number(page), dados: rows.rows });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao listar vendas." });
  }
});
router.get("/resumo", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const { mes, ano, agrupar = "categoria" } = req.query;
    const fvId = req.filtroVendedor;
    const where = [];
    const params = [];
    let p = 1;
    if (fvId) {
      where.push(`vendedor_id = $${p++}`);
      params.push(fvId);
    }
    if (mes) {
      where.push(`mes_numero = $${p++}`);
      params.push(Number(mes));
    }
    if (ano) {
      where.push(`ano = $${p++}`);
      params.push(Number(ano));
    }
    const wStr = where.length ? "WHERE " + where.join(" AND ") : "";
    const GRUPO_COLS = {
      vendedor: "vendedor_id, vendedor_alias",
      categoria: "categoria"
    };
    const grupoCol = GRUPO_COLS[String(agrupar)] ?? "categoria";
    const rows = await (0, import_database.query)(`
            SELECT ${grupoCol},
                   SUM(valor_nf) AS valor_nf, SUM(soma_caixas) AS caixas,
                   SUM(soma_litros) AS litros, COUNT(DISTINCT customer_number) AS clientes
            FROM vendas ${wStr}
            GROUP BY ${grupoCol}
            ORDER BY valor_nf DESC
        `, params);
    res.json(rows.rows);
  } catch (err) {
    res.status(500).json({ erro: "Erro ao carregar resumo." });
  }
});
var vendasRoutes_default = router;
