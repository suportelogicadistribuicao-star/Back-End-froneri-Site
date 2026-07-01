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
var clientesRoutes_exports = {};
__export(clientesRoutes_exports, {
  default: () => clientesRoutes_default
});
module.exports = __toCommonJS(clientesRoutes_exports);
var import_express = require("express");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
const router = (0, import_express.Router)();
function pickClienteFields(body) {
  const allowed = [
    "customer_number",
    "customer_name",
    "city",
    "canal_cliente",
    "segmentacao_cliente",
    "status",
    "nova_rup",
    "observacao",
    "vendedor_id"
  ];
  const data = {};
  for (const key of allowed) {
    if (body[key] !== void 0) data[key] = body[key];
  }
  if (body.status_compra !== void 0 && data.nova_rup === void 0) {
    data.nova_rup = body.status_compra;
  }
  return data;
}
async function existsClienteForScope(customerNumber, filtroVendedor) {
  const scoped = await (0, import_database.query)(
    `SELECT 1
         FROM clientes c
         WHERE c.customer_number = $1
           ${filtroVendedor ? "AND c.vendedor_id = $2" : ""}
         LIMIT 1`,
    filtroVendedor ? [customerNumber, filtroVendedor] : [customerNumber]
  );
  return scoped.rows.length > 0;
}
router.post("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const payload = pickClienteFields(req.body || {});
    if (!payload.customer_name?.toString().trim()) {
      return res.status(400).json({ erro: "customer_name \xE9 obrigat\xF3rio." });
    }
    if (!payload.status) payload.status = "C";
    if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;
    const fields = Object.keys(payload);
    const values = Object.values(payload);
    const placeholders = fields.map((_, i) => `$${i + 1}`);
    const createdInsert = await (0, import_database.query)(
      `INSERT INTO clientes (${fields.join(", ")})
             VALUES (${placeholders.join(", ")})`,
      values
    );
    const createdId = payload.customer_number ?? createdInsert.insertId;
    const created = await (0, import_database.query)("SELECT * FROM clientes WHERE customer_number = $1", [createdId]);
    res.status(201).json(created.rows[0]);
  } catch (err) {
    console.error("[clientes/create]", err);
    res.status(500).json({ erro: "Erro ao criar cliente." });
  }
});
router.get("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      busca,
      canal,
      segmentacao,
      nova_rup,
      cidade,
      vendedor_id,
      status = "C",
      com_ruptura
    } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    const where = ["c.status = $1"];
    const params = [status];
    let p = 2;
    const fvId = req.filtroVendedor || vendedor_id;
    if (fvId) {
      where.push(`c.vendedor_id = $${p++}`);
      params.push(fvId);
    }
    if (busca) {
      const buscaParam = `%${busca}%`;
      where.push(`(
                unaccent(c.customer_name) ILIKE unaccent($${p}) OR
                c.cnpj ILIKE $${p} OR
                c.city ILIKE $${p} OR
                c.customer_number::text ILIKE $${p++}
            )`);
      params.push(buscaParam);
    }
    if (canal) {
      where.push(`c.canal_cliente = $${p++}`);
      params.push(canal);
    }
    if (segmentacao) {
      where.push(`c.segmentacao_cliente = $${p++}`);
      params.push(segmentacao);
    }
    if (nova_rup) {
      where.push(`c.nova_rup = $${p++}`);
      params.push(nova_rup);
    }
    if (cidade) {
      where.push(`c.city ILIKE $${p++}`);
      params.push(`%${cidade}%`);
    }
    if (com_ruptura === "true") {
      const mesAtual = (/* @__PURE__ */ new Date()).getMonth() + 1;
      const anoAtual = (/* @__PURE__ */ new Date()).getFullYear();
      params.push(mesAtual, anoAtual);
      where.push(`EXISTS (
                SELECT 1 FROM ruptura r
                WHERE r.customer_number = c.customer_number
                  AND r.mes_numero = $${p++} AND r.ano = $${p++}
            )`);
    }
    const whereClause = "WHERE " + where.join(" AND ");
    const limitIdx = p;
    const offsetIdx = p + 1;
    const [total, rows] = await Promise.all([
      (0, import_database.query)(`SELECT COUNT(*) AS count FROM clientes c ${whereClause}`, params),
      (0, import_database.query)(`
                SELECT
                    c.customer_number, c.customer_name, c.cnpj, c.city,
                    c.canal_cliente, c.segmentacao_cliente, c.nova_rup, c.status,
                    c.telefone, c.tem_contrato, c.qtd_conservadora,
                    c.payment_terms, c.credit_limit, c.logradouro, c.bairro,
                    c.postal_code, c.hierarquia, c.codigo_setor,
                    v.nome AS vendedor_nome, v.setor AS vendedor_setor,
                    rot.dia_semana, rot.frequencia, rot.sequencia,
                    CASE
                        WHEN c.nova_rup = 'C/ Compra'    THEN 'ATIVO'
                        WHEN c.nova_rup = 'Cliente Novo' THEN 'NOVO'
                        WHEN c.nova_rup LIKE '% M\xEAs%'    THEN 'RISCO'
                        WHEN c.nova_rup LIKE '%6 Meses%' THEN 'CR\xCDTICO'
                        ELSE 'INDEFINIDO'
                    END AS status_compra
                FROM clientes c
                LEFT JOIN vendedores v   ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                ${whereClause}
                ORDER BY c.customer_name
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `, [...params, Number(limit), offset])
    ]);
    res.json({
      total: Number(total.rows[0].count),
      pagina: Number(page),
      limite: Number(limit),
      dados: rows.rows
    });
  } catch (err) {
    console.error("[clientes/list]", err);
    res.status(500).json({ erro: "Erro ao listar clientes." });
  }
});
router.get("/exportar/csv", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const fvId = req.filtroVendedor;
    const rows = await (0, import_database.query)(`
            SELECT
                c.customer_number AS "SOLD",
                c.customer_name AS "Raz\xE3o Social",
                c.cnpj AS "CNPJ",
                c.city AS "Cidade",
                c.canal_cliente AS "Canal",
                c.segmentacao_cliente AS "Segmenta\xE7\xE3o",
                c.nova_rup AS "Status Compra",
                c.telefone AS "Telefone",
                v.nome AS "Vendedor",
                v.setor AS "Setor",
                rot.dia_semana AS "Dia Visita",
                rot.frequencia AS "Frequ\xEAncia"
            FROM clientes c
            LEFT JOIN vendedores v ON v.id = c.vendedor_id
            LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
            WHERE c.status = 'C'
            ${fvId ? "AND c.vendedor_id = $1" : ""}
            ORDER BY v.nome, c.customer_name
        `, fvId ? [fvId] : []);
    if (rows.rows.length === 0) return res.status(404).json({ erro: "Nenhum dado." });
    const cols = Object.keys(rows.rows[0]);
    const csvLines = [
      cols.join(";"),
      ...rows.rows.map(
        (r) => cols.map((c) => `"${(r[c] ?? "").toString().replace(/"/g, '""')}"`).join(";")
      )
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="clientes.csv"');
    res.send("\uFEFF" + csvLines.join("\r\n"));
  } catch (err) {
    res.status(500).json({ erro: "Erro ao exportar." });
  }
});
router.get("/:id", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [cliente, vendas, ruptura, pedidos] = await Promise.all([
      (0, import_database.query)(`
                SELECT c.*, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor,
                       rot.dia_semana, rot.frequencia, rot.sequencia, rot.visitas_semana
                FROM clientes c
                LEFT JOIN vendedores v ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                WHERE c.customer_number = $1
            `, [id]),
      (0, import_database.query)(`
                SELECT mes_descricao, mes_numero, ano,
                       SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas,
                       SUM(soma_litros) AS litros, COUNT(*) AS itens
                FROM vendas WHERE customer_number = $1
                GROUP BY mes_descricao, mes_numero, ano
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [id]),
      (0, import_database.query)(`
                SELECT * FROM ruptura
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 6
            `, [id]),
      (0, import_database.query)(`
                SELECT * FROM pedidos_carteira
                WHERE customer_number = $1
                ORDER BY order_date DESC
                LIMIT 20
            `, [id])
    ]);
    if (cliente.rows.length === 0) {
      return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    }
    res.json({
      ...cliente.rows[0],
      historico_vendas: vendas.rows,
      historico_ruptura: ruptura.rows,
      pedidos_carteira: pedidos.rows
    });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao buscar cliente." });
  }
});
router.put("/:id/observacao", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ erro: "ID inv\xE1lido." });
    const allowed = await existsClienteForScope(id, req.filtroVendedor);
    if (!allowed) {
      return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    }
    const { observacao } = req.body;
    await (0, import_database.query)(
      "UPDATE clientes SET observacao = $1, updated_at = NOW() WHERE customer_number = $2",
      [observacao ?? null, id]
    );
    res.json({ mensagem: "Observa\xE7\xE3o salva." });
  } catch (err) {
    res.status(500).json({ erro: "Erro ao salvar observa\xE7\xE3o." });
  }
});
router.put("/:id", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ erro: "ID inv\xE1lido." });
    const allowed = await existsClienteForScope(id, req.filtroVendedor);
    if (!allowed) {
      return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    }
    const payload = pickClienteFields(req.body || {});
    delete payload.customer_number;
    if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;
    const fields = Object.keys(payload);
    if (fields.length === 0) {
      return res.status(400).json({ erro: "Nenhum campo v\xE1lido para atualizar." });
    }
    const setClause = fields.map((field, i) => `${field} = $${i + 1}`).join(", ");
    const values = [...fields.map((field) => payload[field]), id];
    await (0, import_database.query)(
      `UPDATE clientes
             SET ${setClause}, updated_at = NOW()
             WHERE customer_number = $${values.length}`,
      values
    );
    const updated = await (0, import_database.query)("SELECT * FROM clientes WHERE customer_number = $1", [id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("[clientes/update]", err);
    res.status(500).json({ erro: "Erro ao atualizar cliente." });
  }
});
router.delete("/:id", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ erro: "ID inv\xE1lido." });
    const allowed = await existsClienteForScope(id, req.filtroVendedor);
    if (!allowed) {
      return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    }
    await (0, import_database.query)(
      "UPDATE clientes SET status = $1, updated_at = NOW() WHERE customer_number = $2",
      ["I", id]
    );
    res.status(204).send();
  } catch (err) {
    console.error("[clientes/delete]", err);
    res.status(500).json({ erro: "Erro ao remover cliente." });
  }
});
var clientesRoutes_default = router;
