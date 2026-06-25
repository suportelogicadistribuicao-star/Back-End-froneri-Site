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
var importService_exports = {};
__export(importService_exports, {
  importarRelatorioVendas: () => importarRelatorioVendas,
  iniciarImportacaoRelatorioVendas: () => iniciarImportacaoRelatorioVendas,
  loadVendedoresMap: () => loadVendedoresMap
});
module.exports = __toCommonJS(importService_exports);
var XLSX = __toESM(require("xlsx"));
var import_path = __toESM(require("path"));
var import_fs = __toESM(require("fs"));
var import_crypto = require("crypto");
var import_database = require("../config/database");
let vendedoresMap = {};
async function loadVendedoresMap() {
  const res = await (0, import_database.query)(
    "SELECT id, codigo_vendedor, setor, territory_number, vendedor_alias FROM vendedores WHERE ativo = TRUE"
  );
  vendedoresMap = {};
  for (const row of res.rows) {
    if (row.territory_number) vendedoresMap[String(row.territory_number)] = row.id;
    if (row.setor) vendedoresMap[row.setor.toUpperCase()] = row.id;
    if (row.vendedor_alias) vendedoresMap[row.vendedor_alias.trim()] = row.id;
    if (row.codigo_vendedor) vendedoresMap[String(row.codigo_vendedor)] = row.id;
  }
  return vendedoresMap;
}
function resolveVendedorId(description2, vendedorDesc, codigoSetor) {
  if (description2 && vendedoresMap[String(description2)]) return vendedoresMap[String(description2)];
  if (codigoSetor && vendedoresMap[codigoSetor.toUpperCase()]) return vendedoresMap[codigoSetor.toUpperCase()];
  if (vendedorDesc && vendedoresMap[vendedorDesc.trim()]) return vendedoresMap[vendedorDesc.trim()];
  return null;
}
const norm = (v) => v === null || v === void 0 || v === "" || typeof v === "number" && isNaN(v) ? null : String(v).trim();
const normDesc = (v) => {
  const s = norm(v);
  return s === "Blank" || s === "blank" ? null : s;
};
const normStatus = (v) => {
  const s = norm(v)?.toUpperCase();
  if (s === "CI" || s === "I" || s === "INATIVO" || s === "INACTIVE") return "I";
  if (s === "S" || s === "SUSPENSO" || s === "SUSPENDED") return "S";
  return "C";
};
const normStatusVenda = (v) => {
  const s = norm(v)?.toUpperCase();
  if (!s) return "VENDA";
  if (s.startsWith("VENDA")) return "VENDA";
  if (s.startsWith("AMOSTRA")) return "AMOSTRA GRATIS";
  if (s.startsWith("DEVOLU")) return "DEVOLUCAO";
  return "OUTRO";
};
const normNum = (v) => {
  if (v === null || v === void 0 || v === "") return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const normDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().split("T")[0];
  if (typeof v === "number") {
    const d = new Date(Math.round((v - 25569) * 86400 * 1e3));
    return isNaN(d.getTime()) ? null : d.toISOString().split("T")[0];
  }
  const parsed = new Date(v);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().split("T")[0];
};
function getMesAno(dateStr) {
  if (!dateStr) return { mes: null, ano: null };
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return { mes: null, ano: null };
  return { mes: d.getMonth() + 1, ano: d.getFullYear() };
}
const MESES_MAP = {
  "janeiro": 1,
  "fevereiro": 2,
  "mar\xE7o": 3,
  "marco": 3,
  "abril": 4,
  "maio": 5,
  "junho": 6,
  "julho": 7,
  "agosto": 8,
  "setembro": 9,
  "outubro": 10,
  "novembro": 11,
  "dezembro": 12
};
function parseMesDescricao(mesDesc) {
  if (!mesDesc) return null;
  return MESES_MAP[mesDesc.toLowerCase().trim()] || null;
}
function formatMesReferencia(mes, ano) {
  if (!mes || !ano) return null;
  return `${String(mes).padStart(2, "0")}/${ano}`;
}
function pickPeriodoFromRows(rows, dateColumns, monthColumns = []) {
  const counts = /* @__PURE__ */ new Map();
  for (const row of rows) {
    const dateValue = col(row, ...dateColumns);
    const dateStr = normDate(dateValue);
    const { mes, ano } = getMesAno(dateStr);
    if (!mes || !ano) continue;
    const mesDesc = norm(col(row, ...monthColumns));
    const key = `${ano}-${mes}`;
    const atual = counts.get(key);
    if (atual) {
      atual.total += 1;
      if (!atual.mesReferencia && mesDesc) atual.mesReferencia = mesDesc;
      continue;
    }
    counts.set(key, {
      mes,
      ano,
      mesReferencia: mesDesc || formatMesReferencia(mes, ano),
      total: 1
    });
  }
  let escolhido = null;
  for (const periodo of counts.values()) {
    if (!escolhido || periodo.total > escolhido.total) escolhido = periodo;
  }
  return escolhido;
}
function pickPeriodoFromFileName(filePath) {
  const baseName = import_path.default.basename(filePath, import_path.default.extname(filePath)).toLowerCase();
  const anoMatch = baseName.match(/(20\d{2})/);
  const ano = anoMatch ? Number(anoMatch[1]) : null;
  for (const [mesDesc, mes] of Object.entries(MESES_MAP)) {
    if (baseName.includes(mesDesc)) {
      return {
        mes,
        ano: ano || (/* @__PURE__ */ new Date()).getFullYear(),
        mesReferencia: mesDesc
      };
    }
  }
  const numericMatch = baseName.match(/(?:^|[^\d])(0?[1-9]|1[0-2])[\/_-](20\d{2})(?:[^\d]|$)/);
  if (numericMatch) {
    return {
      mes: Number(numericMatch[1]),
      ano: Number(numericMatch[2]),
      mesReferencia: `${numericMatch[1]}/${numericMatch[2]}`
    };
  }
  return null;
}
function inferPeriodoRelatorio(filePath, vendasRows, pedidosRows) {
  const periodoVendas = pickPeriodoFromRows(vendasRows, ["Data Faturamento"], ["M\xEAs Descri\xE7\xE3o"]);
  if (periodoVendas) return periodoVendas;
  const periodoPedidos = pickPeriodoFromRows(pedidosRows, ["Order Date"], ["M\xEAs", "Mes"]);
  if (periodoPedidos) return periodoPedidos;
  const periodoArquivo = pickPeriodoFromFileName(filePath);
  if (periodoArquivo) return { ...periodoArquivo, total: 0 };
  const hoje = /* @__PURE__ */ new Date();
  return {
    mes: hoje.getMonth() + 1,
    ano: hoje.getFullYear(),
    mesReferencia: formatMesReferencia(hoje.getMonth() + 1, hoje.getFullYear()),
    total: 0
  };
}
function readWorkbook(filePath) {
  const ext = import_path.default.extname(filePath).toLowerCase();
  const opts = { type: "buffer", cellDates: true };
  const buffer = import_fs.default.readFileSync(filePath);
  if (ext === ".xlsb") {
    return XLSX.read(buffer, { ...opts, type: "buffer" });
  }
  return XLSX.read(buffer, opts);
}
function normalizeKeys(rows) {
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      out[k.trim().replace(/\s+/g, " ")] = v;
    }
    return out;
  });
}
function sheetToRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) return [];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
  return normalizeKeys(rows);
}
function normalizeSheetName(name) {
  return String(name || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().replace(/\s+/g, " ").toLowerCase();
}
function findSheetName(wb, expected, aliases = []) {
  const names = Object.keys(wb?.Sheets || {});
  const candidates = [expected, ...aliases].map(normalizeSheetName);
  for (const name of names) {
    const normalized = normalizeSheetName(name);
    if (candidates.includes(normalized)) return name;
  }
  return null;
}
function sheetToRowsFlexible(wb, expected, aliases = []) {
  const realName = findSheetName(wb, expected, aliases);
  if (!realName) return { rows: [], sheetName: null };
  return { rows: sheetToRows(wb, realName), sheetName: realName };
}
function col(row, ...names) {
  for (const name of names) {
    const v = row[name];
    if (v !== null && v !== void 0 && v !== "") return v;
  }
  return null;
}
const IMPORT_CHUNK_SIZE = parseInt(process.env.IMPORT_CHUNK_SIZE || "1000", 10);
function bulkSql(table, cols, rowCount, onDup) {
  const rowPlaceholder = `(${cols.map(() => "?").join(",")})`;
  return `INSERT INTO ${table} (${cols.join(",")}) VALUES ` + Array(rowCount).fill(rowPlaceholder).join(",") + ` ON DUPLICATE KEY UPDATE ${onDup}`;
}
async function processarRelatorioVendas(filePath, usuarioId, logId) {
  await loadVendedoresMap();
  let contadores = {
    vendas: 0,
    amostras: 0,
    devolucoes: 0,
    outros: 0,
    pedidos: 0,
    ruptura: 0,
    clientes: 0,
    erros: 0
  };
  const errosLog = [];
  try {
    const wb = readWorkbook(filePath);
    const vendasSheet = sheetToRowsFlexible(wb, "Base Vendas", ["Base vendas", "Vendas"]);
    const pedidosSheet = sheetToRowsFlexible(wb, "Base Ordens Carteira", ["Base Ordens de Carteira", "Ordens Carteira"]);
    const rupturaSheet = sheetToRowsFlexible(wb, "Base Ruptura", ["Ruptura", "Base ruptura"]);
    const vendasRows = vendasSheet.rows;
    const pedidosRows = pedidosSheet.rows;
    const periodoRelatorio = inferPeriodoRelatorio(filePath, vendasRows, pedidosRows);
    const rupturaRows = rupturaSheet.rows;
    if (vendasRows.length === 0 && pedidosRows.length === 0 && rupturaRows.length === 0) {
      const disponiveis = Object.keys(wb?.Sheets || {}).join(", ");
      throw new Error(
        `Nenhuma linha encontrada nas abas esperadas. Abas encontradas: [${disponiveis}]. Esperadas: Base Ruptura, Base Vendas, Base Ordens Carteira.`
      );
    }
    console.log("[import/vendas] Abas lidas:", {
      ruptura: rupturaSheet.sheetName,
      vendas: vendasSheet.sheetName,
      pedidos: pedidosSheet.sheetName,
      linhas: { ruptura: rupturaRows.length, vendas: vendasRows.length, pedidos: pedidosRows.length }
    });
    if (rupturaRows.length > 0) {
      await importarClientesDaBase(rupturaRows);
      contadores.clientes += rupturaRows.length;
      const RUPTURA_COLS = [
        "customer_number",
        "vendedor_id",
        "status_ruptura",
        "mes_referencia",
        "mes_numero",
        "ano",
        "importacao_id"
      ];
      const RUPTURA_ON_DUP = "vendedor_id=VALUES(vendedor_id),status_ruptura=VALUES(status_ruptura),importacao_id=VALUES(importacao_id),updated_at=NOW()";
      for (let i = 0; i < rupturaRows.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = rupturaRows.slice(i, i + IMPORT_CHUNK_SIZE);
        const params = [];
        let rowCount = 0;
        for (const row of chunk) {
          const customerNumber = normNum(row["Customer Number"]);
          if (!customerNumber) continue;
          const vendedorId = resolveVendedorId(norm(row["Description 2"]), null, norm(row["C\xF3digo"]));
          params.push(
            customerNumber,
            vendedorId,
            norm(row["Nova Rup"]) || "Ruptura",
            periodoRelatorio.mesReferencia,
            periodoRelatorio.mes,
            periodoRelatorio.ano,
            logId
          );
          rowCount++;
        }
        if (rowCount === 0) continue;
        try {
          await (0, import_database.query)(bulkSql("ruptura", RUPTURA_COLS, rowCount, RUPTURA_ON_DUP), params);
          contadores.ruptura += rowCount;
        } catch (e) {
          contadores.erros += rowCount;
          errosLog.push(`Ruptura chunk ${i}: ${e.message}`);
        }
      }
    }
    if (vendasRows.length > 0) {
      const PRODUTO_COLS = [
        "cod_item",
        "descricao",
        "categoria",
        "subcategoria",
        "segmento_sku",
        "categoria_total_sku"
      ];
      const PRODUTO_ON_DUP = "descricao=VALUES(descricao),categoria=COALESCE(VALUES(categoria),categoria),subcategoria=COALESCE(VALUES(subcategoria),subcategoria),segmento_sku=COALESCE(VALUES(segmento_sku),segmento_sku),categoria_total_sku=COALESCE(VALUES(categoria_total_sku),categoria_total_sku),updated_at=NOW()";
      const CLI_VENDAS_COLS = [
        "customer_number",
        "customer_name",
        "cnpj",
        "city",
        "canal_cliente",
        "hierarquia",
        "segmentacao_cliente",
        "filial",
        "vendedor_id"
      ];
      const CLI_VENDAS_ON_DUP = "customer_name=VALUES(customer_name),updated_at=NOW()";
      const VENDA_COLS = [
        "customer_number",
        "customer_name",
        "vendedor_id",
        "vendedor_alias",
        "numero_nf",
        "data_faturamento",
        "mes_descricao",
        "mes_numero",
        "ano",
        "cod_item",
        "descricao_produto",
        "categoria",
        "subcategoria",
        "segmento_sku",
        "categoria_total_sku",
        "soma_caixas",
        "soma_pallets",
        "soma_litros",
        "valor_nf",
        "valor_vbc",
        "status_venda",
        "canal_cliente",
        "hierarquia",
        "segmentacao_cliente",
        "filial",
        "city",
        "cnpj",
        "fonte_arquivo",
        "importacao_id"
      ];
      const VENDA_ON_DUP = "status_venda=VALUES(status_venda),soma_caixas=VALUES(soma_caixas),soma_pallets=VALUES(soma_pallets),soma_litros=VALUES(soma_litros),valor_nf=VALUES(valor_nf),valor_vbc=VALUES(valor_vbc)";
      for (let i = 0; i < vendasRows.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = vendasRows.slice(i, i + IMPORT_CHUNK_SIZE);
        const produtosMap = /* @__PURE__ */ new Map();
        const cliParams = [];
        const vendaParams = [];
        let chunkVendas = 0, chunkAmostras = 0, chunkDevolucoes = 0, chunkOutros = 0;
        for (const row of chunk) {
          const statusVenda = normStatusVenda(row["Status"]);
          const dataFat = normDate(row["Data Faturamento"]);
          const { mes, ano } = getMesAno(dataFat);
          const mesDesc = norm(row["M\xEAs Descri\xE7\xE3o"]);
          const vendedorId = resolveVendedorId(
            norm(row["Description 2"]),
            norm(row["Vendedor.Description"]),
            null
          );
          const codItem = norm(row["COD_ITEM"]);
          if (codItem && !produtosMap.has(codItem)) {
            produtosMap.set(codItem, [
              codItem,
              norm(row["Descri\xE7\xE3o Produto"]),
              norm(row["CATEGORIA"]),
              norm(row["SUBCATEGORIA"]),
              norm(row["Segmento SKU"]),
              norm(row["Categoria TOTAL SKU"])
            ]);
          }
          cliParams.push(
            normNum(row["Customer Number"]),
            norm(row["Customer Name"]),
            norm(row["CNPJ"]),
            norm(row["City"]),
            norm(row["Canal Cliente"]),
            norm(row["Hierarquia.Description"]),
            norm(row["SEGMENTA\xC7\xC3O CLIENTE"]),
            norm(row["Filial"]),
            vendedorId
          );
          vendaParams.push(
            normNum(row["Customer Number"]),
            norm(row["Customer Name"]),
            vendedorId,
            norm(row["Vendedor.Description"]),
            normNum(row["N\xFAmero NF"]),
            dataFat,
            mesDesc,
            parseMesDescricao(mesDesc) || mes,
            ano,
            codItem,
            norm(row["Descri\xE7\xE3o Produto"]),
            norm(row["CATEGORIA"]),
            norm(row["SUBCATEGORIA"]),
            norm(row["Segmento SKU"]),
            norm(row["Categoria TOTAL SKU"]),
            normNum(col(row, "SomaDeCaixas", "Soma Caixas", "Caixas")),
            normNum(col(row, "SomaDePallets", "Soma Pallets", "Pallets")),
            normNum(col(row, "SomaDeLitros", "Soma Litros", "Litros")),
            normNum(col(row, "SomaDeValor NF", "Valor NF", "ValorNF")),
            normNum(col(row, "SomaDeValor VBC", "Valor VBC", "ValorVBC")),
            statusVenda,
            norm(row["Canal Cliente"]),
            norm(row["Hierarquia.Description"]),
            norm(row["SEGMENTA\xC7\xC3O CLIENTE"]),
            norm(row["Filial"]),
            norm(row["City"]),
            norm(row["CNPJ"]),
            import_path.default.basename(filePath),
            logId
          );
          if (statusVenda === "VENDA") chunkVendas++;
          else if (statusVenda === "AMOSTRA GRATIS") chunkAmostras++;
          else if (statusVenda === "DEVOLUCAO") chunkDevolucoes++;
          else chunkOutros++;
        }
        try {
          await (0, import_database.withTransaction)(async (client) => {
            if (produtosMap.size > 0) {
              await client.query(
                bulkSql("produtos", PRODUTO_COLS, produtosMap.size, PRODUTO_ON_DUP),
                [...produtosMap.values()].flat()
              );
            }
            if (chunk.length > 0) {
              await client.query(
                bulkSql("clientes", CLI_VENDAS_COLS, chunk.length, CLI_VENDAS_ON_DUP),
                cliParams
              );
              await client.query(
                bulkSql("vendas", VENDA_COLS, chunk.length, VENDA_ON_DUP),
                vendaParams
              );
            }
          });
          contadores.vendas += chunkVendas;
          contadores.amostras += chunkAmostras;
          contadores.devolucoes += chunkDevolucoes;
          contadores.outros += chunkOutros;
        } catch (e) {
          contadores.erros += chunk.length;
          errosLog.push(`Vendas chunk ${i}: ${e.message}`);
        }
      }
    }
    if (pedidosRows.length > 0) {
      const PEDIDO_COLS = [
        "customer_number",
        "customer_name",
        "order_number",
        "order_date",
        "vendedor_id",
        "vendedor_alias",
        "territory_number",
        "cod_item",
        "descricao_produto",
        "categoria",
        "subcategoria",
        "soma_litros",
        "quantity_shipped",
        "extended_amount",
        "soma_pallets",
        "segmento_sku",
        "categoria_total_sku",
        "mes_descricao",
        "mes_numero",
        "ano",
        "hierarquia",
        "canal_cliente",
        "filial",
        "status",
        "importacao_id"
      ];
      const PEDIDO_ON_DUP = [
        "customer_name=VALUES(customer_name)",
        "order_date=VALUES(order_date)",
        "vendedor_id=VALUES(vendedor_id)",
        "vendedor_alias=VALUES(vendedor_alias)",
        "territory_number=VALUES(territory_number)",
        "descricao_produto=VALUES(descricao_produto)",
        "categoria=VALUES(categoria)",
        "subcategoria=VALUES(subcategoria)",
        "soma_litros=VALUES(soma_litros)",
        "quantity_shipped=VALUES(quantity_shipped)",
        "extended_amount=VALUES(extended_amount)",
        "soma_pallets=VALUES(soma_pallets)",
        "segmento_sku=VALUES(segmento_sku)",
        "categoria_total_sku=VALUES(categoria_total_sku)",
        "mes_descricao=VALUES(mes_descricao)",
        "mes_numero=VALUES(mes_numero)",
        "ano=VALUES(ano)",
        "hierarquia=VALUES(hierarquia)",
        "canal_cliente=VALUES(canal_cliente)",
        "filial=VALUES(filial)",
        "status=VALUES(status)",
        "importacao_id=VALUES(importacao_id)"
      ].join(",");
      for (let i = 0; i < pedidosRows.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = pedidosRows.slice(i, i + IMPORT_CHUNK_SIZE);
        const params = [];
        for (const row of chunk) {
          const orderDate = normDate(row["Order Date"]);
          const mesDesc = norm(col(row, "M\xEAs", "Mes"));
          const vendedorId = resolveVendedorId(
            norm(row["Description 2"]),
            norm(row["Vendedor.Description"]),
            null
          );
          params.push(
            normNum(col(row, "Ship To Number", "Customer Number")),
            norm(col(row, "Alpha Name", "Customer Name")),
            normNum(row["OrderNumber"]),
            orderDate,
            vendedorId,
            norm(row["Vendedor.Description"]),
            normNum(row["Description 2"]),
            norm(col(row, "2nd Item Number", "COD_ITEM")),
            norm(col(row, "Ordem_Delivery.Description", "Descri\xE7\xE3o Produto")),
            norm(row["CATEGORIA"]),
            norm(row["SUBCATEGORIA"]),
            normNum(row["Litros"]),
            normNum(row["Quantity Shipped"]),
            normNum(row["Extended Amount"]),
            normNum(row["Pallets"]),
            norm(col(row, "Segmento", "Segmento SKU")),
            norm(col(row, "Categoria TOTAL", "Categoria TOTAL SKU")),
            mesDesc,
            parseMesDescricao(mesDesc),
            orderDate ? new Date(orderDate).getFullYear() : (/* @__PURE__ */ new Date()).getFullYear(),
            norm(row["Hierarquia"]),
            norm(row["Canal Cliente"]),
            norm(row["Filial"]),
            norm(row["Status"]),
            logId
          );
        }
        try {
          await (0, import_database.query)(bulkSql("pedidos_carteira", PEDIDO_COLS, chunk.length, PEDIDO_ON_DUP), params);
          contadores.pedidos += chunk.length;
        } catch (e) {
          contadores.erros += chunk.length;
          errosLog.push(`Pedidos chunk ${i}: ${e.message}`);
        }
      }
    }
    await finalizarLog(logId, "concluido", contadores, errosLog);
    return { sucesso: true, logId, contadores };
  } catch (err) {
    await finalizarLog(logId, "erro", contadores, [err.message]);
    throw err;
  }
}
async function importarRelatorioVendas(filePath, usuarioId) {
  const logId = await criarLog(filePath, "froneri_vendas", usuarioId);
  const resultado = await processarRelatorioVendas(filePath, usuarioId, logId);
  return { ...resultado, logId };
}
async function iniciarImportacaoRelatorioVendas(filePath, usuarioId) {
  const logId = await criarLog(filePath, "froneri_vendas", usuarioId);
  const promise = processarRelatorioVendas(filePath, usuarioId, logId);
  return { logId, promise };
}
async function importarClientesDaBase(rows) {
  const COLS = [
    "customer_number",
    "customer_name",
    "cnpj",
    "logradouro",
    "bairro",
    "postal_code",
    "city",
    "region",
    "filial",
    "canal_cliente",
    "hierarquia",
    "hierarquia_code",
    "segmentacao_cliente",
    "categoria_code24",
    "payment_terms",
    "credit_limit",
    "telefone",
    "gln_number",
    "additional_tax_id",
    "status",
    "nova_rup",
    "tem_contrato",
    "qtd_conservadora",
    "codigo_hierarquia",
    "descricao1",
    "codigo_setor",
    "territory_number",
    "territory_description",
    "vendedor_id",
    "ruptura_garoto"
  ];
  const ON_DUP = "customer_name=VALUES(customer_name),cnpj=COALESCE(VALUES(cnpj),cnpj),logradouro=COALESCE(VALUES(logradouro),logradouro),bairro=COALESCE(VALUES(bairro),bairro),postal_code=COALESCE(VALUES(postal_code),postal_code),city=COALESCE(VALUES(city),city),region=COALESCE(VALUES(region),region),filial=COALESCE(VALUES(filial),filial),canal_cliente=COALESCE(VALUES(canal_cliente),canal_cliente),hierarquia=COALESCE(VALUES(hierarquia),hierarquia),hierarquia_code=COALESCE(VALUES(hierarquia_code),hierarquia_code),segmentacao_cliente=COALESCE(VALUES(segmentacao_cliente),segmentacao_cliente),categoria_code24=COALESCE(VALUES(categoria_code24),categoria_code24),payment_terms=COALESCE(VALUES(payment_terms),payment_terms),credit_limit=COALESCE(VALUES(credit_limit),credit_limit),telefone=COALESCE(VALUES(telefone),telefone),gln_number=COALESCE(VALUES(gln_number),gln_number),additional_tax_id=COALESCE(VALUES(additional_tax_id),additional_tax_id),status=VALUES(status),nova_rup=COALESCE(VALUES(nova_rup),nova_rup),tem_contrato=VALUES(tem_contrato),qtd_conservadora=COALESCE(VALUES(qtd_conservadora),qtd_conservadora),codigo_hierarquia=COALESCE(VALUES(codigo_hierarquia),codigo_hierarquia),descricao1=COALESCE(VALUES(descricao1),descricao1),codigo_setor=COALESCE(VALUES(codigo_setor),codigo_setor),territory_number=COALESCE(VALUES(territory_number),territory_number),territory_description=COALESCE(VALUES(territory_description),territory_description),vendedor_id=COALESCE(VALUES(vendedor_id),vendedor_id),ruptura_garoto=COALESCE(VALUES(ruptura_garoto),ruptura_garoto),updated_at=NOW()";
  for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
    const params = [];
    let rowCount = 0;
    for (const row of chunk) {
      const customerNumber = normNum(row["Customer Number"] || row["Sold"] || row["SOLD"]);
      if (!customerNumber) continue;
      const description2 = norm(row["Description 2"]);
      const codigoSetor = norm(row["C\xF3digo"] || row["Codigo"]);
      const vendedorDesc = norm(row["Description"] || row["Vendedor"]);
      const vendedorId = resolveVendedorId(description2, vendedorDesc, codigoSetor);
      const paymentTerms = norm(col(row, "Payment Terms", "Descri\xE7\xE3o"));
      params.push(
        customerNumber,
        norm(col(row, "Customer Name", "Raz\xE3o Social")),
        norm(row["CNPJ"]),
        norm(col(row, "Address Line 2", "Endere\xE7o")),
        norm(col(row, "Address Line 4", "Bairro")),
        norm(row["Postal Code"]),
        norm(col(row, "City", "Cidade")),
        norm(row["Regi\xE3o"]) || "Minas Gerais",
        norm(row["Filial"]),
        norm(row["Canal Cliente"]),
        normDesc(row["Category Code 23 Description"]),
        normDesc(row["Category Code 13 Description"]),
        norm(row["SEGMENTA\xC7\xC3O CLIENTE"]),
        norm(row["Category Code 24"]),
        paymentTerms,
        normNum(row["Credit Limit"]),
        norm(row["Telefone"]),
        normNum(row["GLN Number"]),
        norm(row["Additional Tax ID"]),
        normStatus(row["Status"]),
        norm(row["Nova Rup"]),
        norm(row["C/ Contrato?"]) === "Sim",
        normNum(row["Qtd Conservadora"]) || 0,
        normNum(row["C\xF3digo Hierarquia"]),
        norm(row["Descri\xE7\xE3o 1"]),
        codigoSetor,
        normNum(description2),
        vendedorDesc,
        vendedorId,
        norm(row["Ruptura Garoto"])
      );
      rowCount++;
    }
    if (rowCount === 0) continue;
    try {
      await (0, import_database.query)(bulkSql("clientes", COLS, rowCount, ON_DUP), params);
    } catch (e) {
      console.warn("[importarClientes] Erro no chunk:", e.message);
    }
  }
}
async function criarLog(filePath, tipoArquivo, usuarioId) {
  const logId = (0, import_crypto.randomUUID)();
  await (0, import_database.query)(`
        INSERT INTO importacoes_log (id, arquivo_nome, tipo_arquivo, status, usuario_id)
        VALUES ($1, $2, $3, 'processando', $4)
    `, [logId, import_path.default.basename(filePath), tipoArquivo, usuarioId]);
  return logId;
}
async function finalizarLog(logId, status, contadores, erros) {
  const logText = erros.length > 0 ? erros.slice(0, 100).join("\n") : null;
  const totalLinhasVendas = (contadores.vendas || 0) + (contadores.amostras || 0) + (contadores.devolucoes || 0) + (contadores.outros || 0);
  await (0, import_database.query)(`
        UPDATE importacoes_log SET
            status             = $1,
            registros_vendas   = $2,
            registros_clientes = $3,
            registros_ruptura  = $4,
            registros_pedidos  = $5,
            registros_erros    = $6,
            log_erros          = $7,
            finished_at        = NOW()
        WHERE id = $8
    `, [
    status,
    totalLinhasVendas,
    contadores.clientes || 0,
    contadores.ruptura || 0,
    contadores.pedidos || 0,
    contadores.erros || 0,
    logText,
    logId
  ]);
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  importarRelatorioVendas,
  iniciarImportacaoRelatorioVendas,
  loadVendedoresMap
});
