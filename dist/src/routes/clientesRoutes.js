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
var import_crypto = require("crypto");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
var import_clientesHistoricoService = require("../services/clientesHistoricoService");
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
async function resolverCliente(param, filtroVendedor) {
  const chave = String(param ?? "").trim();
  if (!chave) return null;
  const coluna = /^\d+$/.test(chave) ? "customer_number" : "id";
  const res = await (0, import_database.query)(
    `SELECT id, customer_number
         FROM clientes
         WHERE ${coluna} = $1
           ${filtroVendedor ? "AND vendedor_id = $2" : ""}
         LIMIT 1`,
    filtroVendedor ? [chave, filtroVendedor] : [chave]
  );
  return res.rows[0] || null;
}
router.post("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const payload = pickClienteFields(req.body || {});
    if (!payload.customer_name?.toString().trim()) {
      return res.status(400).json({ erro: "customer_name \xE9 obrigat\xF3rio." });
    }
    if (payload.customer_number === void 0 || payload.customer_number === null || payload.customer_number === "") {
      payload.customer_number = null;
    } else {
      const customerNumber = Number(payload.customer_number);
      if (!Number.isInteger(customerNumber) || customerNumber <= 0) {
        return res.status(400).json({ erro: "customer_number deve ser um n\xFAmero inteiro positivo." });
      }
      payload.customer_number = customerNumber;
    }
    if (!payload.status) payload.status = "C";
    if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;
    const clienteId = (0, import_crypto.randomUUID)();
    const fields = ["id", ...Object.keys(payload)];
    const values = [clienteId, ...Object.values(payload)];
    const placeholders = fields.map((_, i) => `$${i + 1}`);
    await (0, import_database.query)(
      `INSERT INTO clientes (${fields.join(", ")})
             VALUES (${placeholders.join(", ")})`,
      values
    );
    const created = await (0, import_database.query)("SELECT * FROM clientes WHERE id = $1", [clienteId]);
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
      status,
      com_ruptura,
      mes,
      ano
    } = req.query;
    const isExport = String(req.query.export ?? "") === "true";
    const pageNum = Math.max(Number(page) || 1, 1);
    const limitNum = isExport ? 5e4 : Math.min(Math.max(Number(limit) || 50, 1), 500);
    const offset = isExport ? 0 : (pageNum - 1) * limitNum;
    const periodoInformado = mes !== void 0 && mes !== "" && ano !== void 0 && ano !== "";
    const mesNum = periodoInformado ? Number(mes) : null;
    const anoNum = periodoInformado ? Number(ano) : null;
    if (periodoInformado && (!Number.isInteger(mesNum) || mesNum < 1 || mesNum > 12 || !Number.isInteger(anoNum))) {
      return res.status(400).json({ erro: "Par\xE2metros mes/ano inv\xE1lidos." });
    }
    const usarHistorico = periodoInformado && await (0, import_clientesHistoricoService.hasSnapshotForPeriodo)(mesNum, anoNum);
    const tabela = usarHistorico ? "clientes_historico_mensal" : "clientes";
    const where = [];
    const params = [];
    let p = 1;
    if (usarHistorico) {
      where.push(`c.mes_numero = $${p++} AND c.ano = $${p++}`);
      params.push(mesNum, anoNum);
    }
    if (status !== void 0 && status !== null && String(status).trim() !== "") {
      where.push(`c.status = $${p++}`);
      params.push(status);
    }
    const vendedorQuery = vendedor_id !== void 0 && vendedor_id !== "" ? Number(vendedor_id) : null;
    if (vendedorQuery !== null && !Number.isFinite(vendedorQuery)) {
      return res.status(400).json({ erro: "Par\xE2metro vendedor_id inv\xE1lido." });
    }
    const fvId = req.filtroVendedor ?? vendedorQuery;
    if (fvId) {
      where.push(`c.vendedor_id = $${p++}`);
      params.push(fvId);
    }
    if (busca) {
      const buscaParam = `%${String(busca).replace(/[\\%_]/g, "\\$&")}%`;
      where.push(`(
                c.customer_name LIKE $${p++} OR
                c.cnpj LIKE $${p++} OR
                c.city LIKE $${p++} OR
                CAST(c.customer_number AS CHAR) LIKE $${p++}
            )`);
      params.push(buscaParam, buscaParam, buscaParam, buscaParam);
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
      where.push(`c.city LIKE $${p++}`);
      params.push(`%${String(cidade).replace(/[\\%_]/g, "\\$&")}%`);
    }
    if (com_ruptura === "true") {
      const now = /* @__PURE__ */ new Date();
      const mesRup = mesNum ?? now.getMonth() + 1;
      const anoRup = anoNum ?? now.getFullYear();
      params.push(mesRup, anoRup);
      where.push(`EXISTS (
                SELECT 1 FROM ruptura r
                WHERE r.customer_number = c.customer_number
                  AND r.mes_numero = $${p++} AND r.ano = $${p++}
            )`);
    }
    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limitIdx = p;
    const offsetIdx = p + 1;
    const camposSemHistorico = usarHistorico ? "NULL AS telefone, NULL AS payment_terms, NULL AS credit_limit, NULL AS logradouro, NULL AS bairro, NULL AS postal_code, NULL AS codigo_setor" : "c.telefone, c.payment_terms, c.credit_limit, c.logradouro, c.bairro, c.postal_code, c.codigo_setor";
    const [total, rows] = await Promise.all([
      (0, import_database.query)(`SELECT COUNT(*) AS count FROM ${tabela} c ${whereClause}`, params),
      (0, import_database.query)(`
                SELECT
                    ${usarHistorico ? "NULL AS id" : "c.id"},
                    c.customer_number, c.customer_name, c.cnpj, c.city,
                    c.canal_cliente, c.segmentacao_cliente, c.nova_rup, c.status,
                    c.tem_contrato, c.qtd_conservadora, c.hierarquia,
                    ${camposSemHistorico},
                    v.nome AS vendedor_nome, v.setor AS vendedor_setor,
                    rot.dia_semana, rot.frequencia, rot.sequencia,
                    CASE
                        WHEN c.nova_rup = 'C/ Compra'    THEN 'ATIVO'
                        WHEN c.nova_rup = 'Cliente Novo' THEN 'NOVO'
                        WHEN c.nova_rup LIKE '% M\xEAs%'    THEN 'RISCO'
                        WHEN c.nova_rup LIKE '%6 Meses%' THEN 'CR\xCDTICO'
                        ELSE 'INDEFINIDO'
                    END AS status_compra
                FROM ${tabela} c
                LEFT JOIN vendedores v   ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                ${whereClause}
                ORDER BY c.customer_name
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `, [...params, limitNum, offset])
    ]);
    res.json({
      total: Number(total.rows[0].count),
      pagina: pageNum,
      limite: limitNum,
      dados: rows.rows,
      ...periodoInformado ? { periodo: { mes: mesNum, ano: anoNum, fonte: usarHistorico ? "historico" : "atual" } } : {}
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
    const alvo = await resolverCliente(req.params.id, req.filtroVendedor);
    if (!alvo) return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    const sold = alvo.customer_number;
    const vazio = { rows: [] };
    const [cliente, vendas, ruptura, pedidos, historicoCadastral] = await Promise.all([
      (0, import_database.query)(`
                SELECT c.*, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor,
                       rot.dia_semana, rot.frequencia, rot.sequencia, rot.visitas_semana
                FROM clientes c
                LEFT JOIN vendedores v ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                WHERE c.id = $1
            `, [alvo.id]),
      sold === null ? vazio : (0, import_database.query)(`
                SELECT mes_descricao, mes_numero, ano,
                       SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas,
                       SUM(soma_litros) AS litros, COUNT(*) AS itens
                FROM vendas WHERE customer_number = $1
                GROUP BY mes_descricao, mes_numero, ano
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [sold]),
      sold === null ? vazio : (0, import_database.query)(`
                SELECT * FROM ruptura
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 6
            `, [sold]),
      sold === null ? vazio : (0, import_database.query)(`
                SELECT * FROM pedidos_carteira
                WHERE customer_number = $1
                ORDER BY order_date DESC
                LIMIT 20
            `, [sold]),
      // Snapshot mensal do cadastro — como o cliente estava em cada mês
      // (status, nova_rup, tem_contrato etc.), diferente do estado atual
      // acima (cliente.rows[0]), que só reflete a última importação.
      sold === null ? vazio : (0, import_database.query)(`
                SELECT mes_referencia, mes_numero, ano, status, nova_rup, tem_contrato,
                       qtd_conservadora, segmentacao_cliente, canal_cliente, hierarquia,
                       filial, vendedor_id
                FROM clientes_historico_mensal
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [sold])
    ]);
    if (cliente.rows.length === 0) {
      return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    }
    res.json({
      ...cliente.rows[0],
      historico_vendas: vendas.rows,
      historico_ruptura: ruptura.rows,
      historico_cadastral: historicoCadastral.rows,
      pedidos_carteira: pedidos.rows
    });
  } catch (err) {
    console.error("[clientes/detalhe]", err);
    res.status(500).json({ erro: "Erro ao buscar cliente." });
  }
});
router.put("/:id/observacao", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const alvo = await resolverCliente(req.params.id, req.filtroVendedor);
    if (!alvo) return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    const { observacao } = req.body;
    await (0, import_database.query)(
      "UPDATE clientes SET observacao = $1, updated_at = NOW() WHERE id = $2",
      [observacao ?? null, alvo.id]
    );
    res.json({ mensagem: "Observa\xE7\xE3o salva." });
  } catch (err) {
    console.error("[clientes/observacao]", err);
    res.status(500).json({ erro: "Erro ao salvar observa\xE7\xE3o." });
  }
});
router.put("/:id", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const alvo = await resolverCliente(req.params.id, req.filtroVendedor);
    if (!alvo) return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    const payload = pickClienteFields(req.body || {});
    delete payload.customer_number;
    if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;
    const fields = Object.keys(payload);
    if (fields.length === 0) {
      return res.status(400).json({ erro: "Nenhum campo v\xE1lido para atualizar." });
    }
    const setClause = fields.map((field, i) => `${field} = $${i + 1}`).join(", ");
    const values = [...fields.map((field) => payload[field]), alvo.id];
    await (0, import_database.query)(
      `UPDATE clientes
             SET ${setClause}, updated_at = NOW()
             WHERE id = $${values.length}`,
      values
    );
    const updated = await (0, import_database.query)("SELECT * FROM clientes WHERE id = $1", [alvo.id]);
    res.json(updated.rows[0]);
  } catch (err) {
    console.error("[clientes/update]", err);
    res.status(500).json({ erro: "Erro ao atualizar cliente." });
  }
});
router.delete("/:id", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const alvo = await resolverCliente(req.params.id, req.filtroVendedor);
    if (!alvo) return res.status(404).json({ erro: "Cliente n\xE3o encontrado." });
    await (0, import_database.query)(
      "UPDATE clientes SET status = $1, updated_at = NOW() WHERE id = $2",
      ["I", alvo.id]
    );
    res.status(204).send();
  } catch (err) {
    console.error("[clientes/delete]", err);
    res.status(500).json({ erro: "Erro ao remover cliente." });
  }
});
var clientesRoutes_default = router;
