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
var dashboardRoutes_exports = {};
__export(dashboardRoutes_exports, {
  default: () => dashboardRoutes_default
});
module.exports = __toCommonJS(dashboardRoutes_exports);
var import_express = require("express");
var import_database = require("../config/database");
var import_auth = require("../middleware/auth");
var import_clientesHistoricoService = require("../services/clientesHistoricoService");
const router = (0, import_express.Router)();
router.get("/", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const now = /* @__PURE__ */ new Date();
    const mes = Number(req.query.mes) || now.getMonth() + 1;
    const ano = Number(req.query.ano) || now.getFullYear();
    const canal = req.query.canal || null;
    const segmentacao = req.query.segmentacao || null;
    const filtroVendedor = req.filtroVendedor;
    const p = [ano, mes];
    let vendaWhere = "WHERE ano = $1 AND mes_numero = $2";
    if (filtroVendedor) {
      p.push(filtroVendedor);
      vendaWhere += ` AND vendedor_id = $${p.length}`;
    }
    if (canal) {
      p.push(canal);
      vendaWhere += ` AND canal_cliente = $${p.length}`;
    }
    if (segmentacao) {
      p.push(segmentacao);
      vendaWhere += ` AND segmentacao_cliente = $${p.length}`;
    }
    const rupturaParams = [ano, mes];
    let rupturaWhere = "WHERE ano = $1 AND mes_numero = $2";
    if (filtroVendedor) {
      rupturaParams.push(filtroVendedor);
      rupturaWhere += ` AND vendedor_id = $${rupturaParams.length}`;
    }
    const pedidosParams = [ano, mes];
    let pedidosWhere = "WHERE ano = $1 AND mes_numero = $2";
    if (filtroVendedor) {
      pedidosParams.push(filtroVendedor);
      pedidosWhere += ` AND vendedor_id = $${pedidosParams.length}`;
    }
    const usarHistoricoClientes = await (0, import_clientesHistoricoService.hasRupturaForPeriodo)(mes, ano);
    const clientesKPIQuery = usarHistoricoClientes ? `
                SELECT
                    COUNT(DISTINCT r.customer_number) AS total_ativos,
                    COUNT(DISTINCT CASE WHEN r.status_ruptura = 'C/ Compra'    THEN r.customer_number END) AS com_compra,
                    COUNT(DISTINCT CASE WHEN r.status_ruptura = 'Cliente Novo' THEN r.customer_number END) AS novos,
                    COUNT(DISTINCT CASE WHEN r.status_ruptura LIKE '%6 Meses%' THEN r.customer_number END) AS criticos,
                    COUNT(DISTINCT CASE WHEN c.tem_contrato = TRUE THEN r.customer_number END) AS com_contrato
                FROM ruptura r
                LEFT JOIN clientes c ON c.customer_number = r.customer_number
                WHERE r.mes_numero = $1 AND r.ano = $2
                ${filtroVendedor ? "AND r.vendedor_id = $3" : ""}
            ` : `
                SELECT
                    COUNT(*) AS total_ativos,
                    COUNT(CASE WHEN nova_rup = 'C/ Compra'    THEN 1 END) AS com_compra,
                    COUNT(CASE WHEN nova_rup = 'Cliente Novo' THEN 1 END) AS novos,
                    COUNT(CASE WHEN nova_rup LIKE '%6 Meses%' THEN 1 END) AS criticos,
                    COUNT(CASE WHEN tem_contrato = TRUE        THEN 1 END) AS com_contrato
                FROM clientes
                WHERE status = 'C'
                ${filtroVendedor ? "AND vendedor_id = $1" : ""}
            `;
    const clientesKPIParams = usarHistoricoClientes ? filtroVendedor ? [mes, ano, filtroVendedor] : [mes, ano] : filtroVendedor ? [filtroVendedor] : [];
    const [
      vendasKPI,
      rupturaKPI,
      clientesKPI,
      pedidosKPI,
      vendasCategoria,
      vendasCanalRes,
      devedoresKPI,
      vendasVendedorRes
    ] = await Promise.all([
      (0, import_database.query)(`
                SELECT
                    COUNT(DISTINCT customer_number)    AS clientes_atendidos,
                    SUM(valor_nf)                      AS valor_total_nf,
                    SUM(valor_vbc)                     AS valor_total_vbc,
                    SUM(soma_caixas)                   AS total_caixas,
                    SUM(soma_litros)                   AS total_litros
                FROM vendas
                ${vendaWhere}
            `, p),
      (0, import_database.query)(`
                SELECT COUNT(DISTINCT customer_number) AS total_ruptura
                FROM ruptura
                ${rupturaWhere}
                ${rupturaWhere ? "AND" : "WHERE"} status_ruptura != 'C/ Compra'
            `, rupturaParams),
      (0, import_database.query)(clientesKPIQuery, clientesKPIParams),
      (0, import_database.query)(`
                SELECT
                    COUNT(DISTINCT customer_number) AS clientes_com_pedido,
                    SUM(extended_amount)            AS valor_carteira,
                    COUNT(*)                        AS total_pedidos
                FROM pedidos_carteira
                ${pedidosWhere}
            `, pedidosParams),
      (0, import_database.query)(`
                SELECT categoria, SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas
                FROM vendas
                ${vendaWhere}
                GROUP BY categoria
                ORDER BY valor DESC
            `, p),
      (0, import_database.query)(`
                SELECT canal_cliente AS name, SUM(valor_nf) AS value
                FROM vendas
                ${vendaWhere}
                GROUP BY canal_cliente
                ORDER BY value DESC
            `, p),
      // Devedores: usa INNER JOIN em vez de IN (subquery) para filtro por vendedor
      (0, import_database.query)(`
                SELECT
                    COUNT(DISTINCT d.documento_cliente) AS total_devedores,
                    SUM(d.valor_titulo_saldo_devedor)   AS valor_total_devedor,
                    MAX(d.dias_em_atraso)               AS max_dias_atraso
                FROM devedores d
                ${filtroVendedor ? "INNER JOIN clientes c ON c.cnpj = d.documento_cliente AND c.vendedor_id = $1" : ""}
            `, filtroVendedor ? [filtroVendedor] : []),
      // Vendas por Vendedor — somente admin/gerente
      !filtroVendedor ? (0, import_database.query)(`
                    SELECT
                        v.nome AS vendedor_nome,
                        v.setor,
                        COALESCE(SUM(ve.valor_nf), 0) AS valor_nf,
                        COUNT(DISTINCT ve.customer_number) AS clientes
                    FROM vendedores v
                    LEFT JOIN vendas ve ON ve.vendedor_id = v.id
                        AND ve.mes_numero = $1 AND ve.ano = $2
                    WHERE v.ativo = TRUE
                    GROUP BY v.id, v.nome, v.setor
                    ORDER BY valor_nf DESC
                `, [mes, ano]) : Promise.resolve({ rows: [] })
    ]);
    res.json({
      periodo: { mes, ano },
      vendas: vendasKPI.rows[0],
      ruptura: rupturaKPI.rows[0],
      clientes: { ...clientesKPI.rows[0], _fonte: usarHistoricoClientes ? "historico" : "atual" },
      pedidos: pedidosKPI.rows[0],
      devedores: devedoresKPI.rows[0],
      vendasPorCategoria: vendasCategoria.rows,
      vendasPorCanal: vendasCanalRes.rows,
      vendasPorVendedor: vendasVendedorRes.rows
    });
  } catch (err) {
    console.error("[dashboard]", err);
    res.status(500).json({ erro: "Erro ao carregar dashboard." });
  }
});
router.get("/tendencia", import_auth.authMiddleware, import_auth.ownDataOnly, async (req, res) => {
  try {
    const meses = Math.min(Number(req.query.meses || "6"), 12);
    const filtroVendedor = req.filtroVendedor;
    const now = /* @__PURE__ */ new Date();
    const refDate = new Date(now.getFullYear(), now.getMonth() - meses + 1, 1);
    const mesCorte = refDate.getMonth() + 1;
    const anoCorte = refDate.getFullYear();
    const p = [anoCorte, anoCorte, mesCorte];
    let extraWhere = "";
    if (filtroVendedor) {
      p.push(filtroVendedor);
      extraWhere = `AND vendedor_id = $${p.length}`;
    }
    const rows = await (0, import_database.query)(`
            SELECT
                mes_numero,
                ano,
                mes_descricao,
                SUM(valor_nf)                   AS valor_nf,
                SUM(soma_litros)                AS litros,
                COUNT(DISTINCT customer_number) AS clientes
            FROM vendas
            WHERE (ano > $1 OR (ano = $2 AND mes_numero >= $3))
            ${extraWhere}
            GROUP BY mes_numero, ano, mes_descricao
            ORDER BY ano, mes_numero
        `, p);
    res.json(rows.rows);
  } catch (err) {
    console.error("[dashboard/tendencia]", err);
    res.status(500).json({ erro: "Erro ao carregar tend\xEAncia." });
  }
});
var dashboardRoutes_default = router;
