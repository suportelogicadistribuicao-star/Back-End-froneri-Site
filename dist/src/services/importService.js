"use strict";
/**
 * importService.js
 * Serviço de importação das planilhas da Froneri para o banco de dados.
 *
 * Planilhas suportadas:
 *  1. Relatório_Vendas_BROKER (xlsb) - Relatório mensal de vendas da Froneri
 *  2. Base_Froneri_Ativa_Roteirizações (xlsx) - Base ativa + roteirização
 *  3. CADASTROS_FRONERI (xlsx) - Cadastros de novos clientes
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.importarRelatorioVendas = importarRelatorioVendas;
exports.importarBaseAtiva = importarBaseAtiva;
exports.importarCadastros = importarCadastros;
exports.loadVendedoresMap = loadVendedoresMap;
const XLSX = __importStar(require("xlsx"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../config/database");
// ─── Mapa de Vendedores por descrição/território ─────────────────────────────
// Populado dinamicamente do banco na inicialização
let vendedoresMap = {}; // key: "territorio_number" ou "description_string" → vendedor_id
async function loadVendedoresMap() {
    const res = await (0, database_1.query)('SELECT id, codigo_vendedor, setor, territorio, descricao FROM vendedores WHERE ativo = TRUE');
    vendedoresMap = {};
    for (const row of res.rows) {
        if (row.territorio)
            vendedoresMap[String(row.territorio)] = row.id;
        if (row.setor)
            vendedoresMap[row.setor.toUpperCase()] = row.id;
        if (row.descricao)
            vendedoresMap[row.descricao.trim()] = row.id;
        if (row.codigo_vendedor)
            vendedoresMap[String(row.codigo_vendedor)] = row.id;
    }
    return vendedoresMap;
}
// ─── Helper: resolver vendedor_id a partir de vários campos ──────────────────
function resolveVendedorId(description2, vendedorDesc, codigoSetor) {
    // Description 2 é o número do território (ex: 295235)
    if (description2 && vendedoresMap[String(description2)])
        return vendedoresMap[String(description2)];
    if (codigoSetor && vendedoresMap[codigoSetor.toUpperCase()])
        return vendedoresMap[codigoSetor.toUpperCase()];
    if (vendedorDesc && vendedoresMap[vendedorDesc.trim()])
        return vendedoresMap[vendedorDesc.trim()];
    return null;
}
// ─── Helper: normalizar string ───────────────────────────────────────────────
const norm = v => (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) ? null : String(v).trim();
const normNum = v => {
    if (v === null || v === undefined || v === '')
        return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
};
const normDate = v => {
    if (!v)
        return null;
    if (v instanceof Date)
        return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0];
    // Excel serial date
    if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    }
    const parsed = new Date(v);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
};
// ─── Extrair mês/ano de uma data ─────────────────────────────────────────────
function getMesAno(dateStr) {
    if (!dateStr)
        return { mes: null, ano: null };
    const d = new Date(dateStr);
    if (isNaN(d.getTime()))
        return { mes: null, ano: null };
    return { mes: d.getMonth() + 1, ano: d.getFullYear() };
}
const MESES_MAP = {
    'janeiro': 1, 'fevereiro': 2, 'março': 3, 'marco': 3,
    'abril': 4, 'maio': 5, 'junho': 6, 'julho': 7, 'agosto': 8,
    'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12
};
function parseMesDescricao(mesDesc) {
    if (!mesDesc)
        return null;
    return MESES_MAP[mesDesc.toLowerCase().trim()] || null;
}
// ─── Ler planilha com xlsx ────────────────────────────────────────────────────
function readWorkbook(filePath) {
    const ext = path_1.default.extname(filePath).toLowerCase();
    const opts = { type: 'buffer', cellDates: true };
    const buffer = fs_1.default.readFileSync(filePath);
    if (ext === '.xlsb') {
        return XLSX.read(buffer, { ...opts, type: 'buffer' });
    }
    return XLSX.read(buffer, opts);
}
function sheetToRows(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws)
        return [];
    return XLSX.utils.sheet_to_json(ws, { defval: null, raw: false });
}
// ═══════════════════════════════════════════════════════════════════════════════
// 1. IMPORTAR RELATÓRIO DE VENDAS (xlsb da Froneri)
//    Sheets: "Base Vendas", "Base Ordens Carteira", "Base Ruptura"
// ═══════════════════════════════════════════════════════════════════════════════
async function importarRelatorioVendas(filePath, usuarioId) {
    const logId = await criarLog(filePath, 'froneri_vendas', usuarioId);
    await loadVendedoresMap();
    let contadores = { vendas: 0, pedidos: 0, ruptura: 0, clientes: 0, erros: 0 };
    const errosLog = [];
    try {
        const wb = readWorkbook(filePath);
        // ── 1a. Base Vendas ──────────────────────────────────────────────────
        const vendasRows = sheetToRows(wb, 'Base Vendas');
        if (vendasRows.length > 0) {
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of vendasRows) {
                    try {
                        const dataFat = normDate(row['Data Faturamento']);
                        const { mes, ano } = getMesAno(dataFat);
                        const mesDesc = norm(row['Mês Descrição']);
                        const vendedorId = resolveVendedorId(norm(row['Description 2']), norm(row['Vendedor.Description']), null);
                        await upsertProduto(client, row);
                        await client.query(`
                            INSERT INTO vendas (
                                customer_number, customer_name, vendedor_id, vendedor_descricao,
                                numero_nf, data_faturamento, mes_descricao, mes_numero, ano,
                                cod_item, descricao_produto, categoria, subcategoria,
                                segmento_sku, categoria_total_sku,
                                soma_caixas, soma_pallets, soma_litros, valor_nf, valor_vbc,
                                canal_cliente, hierarquia, segmentacao_cliente, filial,
                                city, cnpj, fonte_arquivo, importacao_id
                            ) VALUES (
                                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28
                            )
                        `, [
                            normNum(row['Customer Number']),
                            norm(row['Customer Name']),
                            vendedorId,
                            norm(row['Vendedor.Description']),
                            normNum(row['Número NF']),
                            dataFat,
                            mesDesc,
                            parseMesDescricao(mesDesc) || mes,
                            ano,
                            norm(row['COD_ITEM']),
                            norm(row['Descrição Produto']),
                            norm(row['CATEGORIA']),
                            norm(row['SUBCATEGORIA']),
                            norm(row['Segmento SKU']),
                            norm(row['Categoria TOTAL SKU']),
                            normNum(row['SomaDeCaixas']),
                            normNum(row['SomaDePallets']),
                            normNum(row['SomaDeLitros']),
                            normNum(row['SomaDeValor NF']),
                            normNum(row['SomaDeValor VBC']),
                            norm(row['Canal Cliente']),
                            norm(row['Hierarquia.Description']),
                            norm(row['SEGMENTAÇÃO CLIENTE']),
                            norm(row['Filial']),
                            norm(row['City']),
                            norm(row['CNPJ']),
                            path_1.default.basename(filePath),
                            logId
                        ]);
                        contadores.vendas++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Venda NF ${row['Número NF']}: ${e.message}`);
                    }
                }
            });
        }
        // ── 1b. Base Ordens Carteira ─────────────────────────────────────────
        const pedidosRows = sheetToRows(wb, 'Base Ordens Carteira');
        if (pedidosRows.length > 0) {
            // Limpar pedidos do mês antes de reimportar
            const mesRef = parseMesDescricao(norm(pedidosRows[0]?.['Mês']));
            if (mesRef) {
                const anoRef = new Date().getFullYear();
                await (0, database_1.query)('DELETE FROM pedidos_carteira WHERE mes_numero = $1 AND ano = $2', [mesRef, anoRef]);
            }
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of pedidosRows) {
                    try {
                        const orderDate = normDate(row['Order Date']);
                        const mesDesc = norm(row['Mês']);
                        const vendedorId = resolveVendedorId(norm(row['Description 2']), norm(row['Vendedor.Description']), null);
                        await client.query(`
                            INSERT INTO pedidos_carteira (
                                ship_to_number, alpha_name, order_number, order_date,
                                vendedor_id, vendedor_descricao, territory_number,
                                cod_item, descricao_produto, categoria, subcategoria,
                                litros, quantity_shipped, extended_amount, pallets,
                                segmento, categoria_total, mes, mes_numero, ano,
                                hierarquia, canal_cliente, filial, status, importacao_id
                            ) VALUES (
                                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25
                            )
                        `, [
                            normNum(row['Ship To Number']),
                            norm(row['Alpha Name']),
                            normNum(row['OrderNumber']),
                            orderDate,
                            vendedorId,
                            norm(row['Vendedor.Description']),
                            normNum(row['Description 2']),
                            norm(row['2nd Item Number']),
                            norm(row['Ordem_Delivery.Description']),
                            norm(row['CATEGORIA']),
                            norm(row['SUBCATEGORIA']),
                            normNum(row['Litros']),
                            normNum(row['Quantity Shipped']),
                            normNum(row['Extended Amount']),
                            normNum(row['Pallets']),
                            norm(row['Segmento']),
                            norm(row['Categoria TOTAL']),
                            mesDesc,
                            parseMesDescricao(mesDesc),
                            orderDate ? new Date(orderDate).getFullYear() : new Date().getFullYear(),
                            norm(row['Hierarquia']),
                            norm(row['Canal Cliente']),
                            norm(row['Filial']),
                            norm(row['Status']),
                            logId
                        ]);
                        contadores.pedidos++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Pedido ${row['OrderNumber']}: ${e.message}`);
                    }
                }
            });
        }
        // ── 1c. Base Ruptura ─────────────────────────────────────────────────
        const rupturaRows = sheetToRows(wb, 'Base Ruptura');
        if (rupturaRows.length > 0) {
            await importarClientesDaBase(rupturaRows);
            contadores.clientes += rupturaRows.length;
            // Registrar ruptura do mês
            const mesAtual = new Date().getMonth() + 1;
            const anoAtual = new Date().getFullYear();
            await (0, database_1.query)('DELETE FROM ruptura WHERE mes_numero=$1 AND ano=$2', [mesAtual, anoAtual]);
            await (0, database_1.withTransaction)(async (client) => {
                // Tentar ler sheet de ruptura com justificativas
                const ruptSheet = sheetToRows(wb, 'Ruptura');
                const justMap = {};
                for (const r of ruptSheet) {
                    if (r['STATUS'] && normNum(r['STATUS'])) {
                        justMap[normNum(r['STATUS'])] = {
                            justificativa: norm(r['Justificativas']),
                            pedidoCarteira: norm(r['PEDIDO EM CARTEIRA']),
                            obsRuptura: norm(r['OBSERVAÇÃO RUPTURA']),
                            obsCancelamento: norm(r['OBSERVAÇÃO CANCELAMENTO'])
                        };
                    }
                }
                for (const row of rupturaRows) {
                    try {
                        const customerNumber = normNum(row['Customer Number']);
                        if (!customerNumber)
                            continue;
                        const vendedorId = resolveVendedorId(norm(row['Description 2']), null, norm(row['Código']));
                        const j = justMap[customerNumber] || {};
                        await client.query(`
                            INSERT INTO ruptura (
                                customer_number, vendedor_id, status_ruptura,
                                justificativa, pedido_em_carteira, observacao_ruptura,
                                observacao_cancelamento, mes_numero, ano, importacao_id
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                            ON CONFLICT DO NOTHING
                        `, [
                            customerNumber,
                            vendedorId,
                            'Ruptura',
                            j.justificativa || null,
                            j.pedidoCarteira || null,
                            j.obsRuptura || null,
                            j.obsCancelamento || null,
                            mesAtual,
                            anoAtual,
                            logId
                        ]);
                        contadores.ruptura++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Ruptura ${row['Customer Number']}: ${e.message}`);
                    }
                }
            });
        }
        await finalizarLog(logId, 'concluido', contadores, errosLog);
        return { sucesso: true, logId, contadores };
    }
    catch (err) {
        await finalizarLog(logId, 'erro', contadores, [err.message]);
        throw err;
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// 2. IMPORTAR BASE ATIVA + ROTEIRIZAÇÃO (xlsx)
//    Sheets: "BASE ATIVA - ROTEIRIZADA", "ROTEIRIZAÇÕES", "DEVEDORES", "CANCELAMENTOS"
// ═══════════════════════════════════════════════════════════════════════════════
async function importarBaseAtiva(filePath, usuarioId) {
    const logId = await criarLog(filePath, 'froneri_base_ativa', usuarioId);
    await loadVendedoresMap();
    let contadores = { clientes: 0, roteirizacao: 0, devedores: 0, cancelamentos: 0, erros: 0 };
    const errosLog = [];
    try {
        const wb = readWorkbook(filePath);
        // ── 2a. BASE ATIVA - ROTEIRIZADA ─────────────────────────────────────
        const baseRows = sheetToRows(wb, 'BASE ATIVA - ROTEIRIZADA');
        if (baseRows.length > 0) {
            await importarClientesDaBase(baseRows);
            contadores.clientes = baseRows.length;
            // Desativar roteirizações antigas
            await (0, database_1.query)('UPDATE roteirizacao SET ativa = FALSE WHERE ativa = TRUE');
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of baseRows) {
                    try {
                        const sold = normNum(row['Sold']);
                        if (!sold)
                            continue;
                        const vendedorId = resolveVendedorId(null, norm(row['Description']), // ex: Vendedor 01_Logica MG
                        null);
                        const diaSemana = norm(row['Dia da Semana']);
                        const frequencia = norm(row['Frequência']);
                        if (!diaSemana)
                            continue;
                        await client.query(`
                            INSERT INTO roteirizacao (
                                sold, vendedor_id, dia_semana, frequencia,
                                visitas_semana, bairro, cidade, ativa, ultima_atualizacao
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE,NOW())
                            ON CONFLICT (sold, dia_semana)
                            DO UPDATE SET
                                vendedor_id      = EXCLUDED.vendedor_id,
                                frequencia       = EXCLUDED.frequencia,
                                visitas_semana   = EXCLUDED.visitas_semana,
                                bairro           = EXCLUDED.bairro,
                                cidade           = EXCLUDED.cidade,
                                ativa            = TRUE,
                                ultima_atualizacao = NOW(),
                                updated_at       = NOW()
                        `, [
                            sold,
                            vendedorId,
                            diaSemana,
                            frequencia,
                            normNum(row['Visitas ']) || 1,
                            norm(row['Bairro'] || row['Address Line 2']),
                            norm(row['Cidade'] || row['City']),
                        ]);
                        contadores.roteirizacao++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Roteirização sold ${row['Sold']}: ${e.message}`);
                    }
                }
            });
        }
        // ── 2b. DEVEDORES ────────────────────────────────────────────────────
        const devedoresRows = sheetToRows(wb, 'DEVEDORES');
        if (devedoresRows.length > 0) {
            // Limpar devedores antes de reimportar
            await (0, database_1.query)('DELETE FROM devedores');
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of devedoresRows) {
                    try {
                        await client.query(`
                            INSERT INTO devedores (
                                documento_cliente, nome_cliente,
                                codigo_convenio_broker, nome_convenio_broker,
                                codigo_convenio_seller, nome_convenio_seller,
                                filial, categoria, nota_fiscal, titulo,
                                nome_status_titulo, data_operacao, data_vencimento,
                                dias_em_atraso, valor_titulo, valor_titulo_saldo_devedor,
                                flag_protesto, flag_serasa, importacao_id
                            ) VALUES (
                                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
                            )
                        `, [
                            norm(row['DOCUMENTO_CLIENTE']),
                            norm(row['NOME_CLIENTE']),
                            norm(row['CODIGO_CONVENIO_BROKER']),
                            norm(row['NOME_CONVENIO_BROKER']),
                            norm(row['CODIGO_CONVENIO_SELLER']),
                            norm(row['NOME_CONVENIO_SELLER']),
                            norm(row['FILIAL']),
                            norm(row['CATEGORIA']),
                            normNum(row['NOTA_FISCAL']),
                            normNum(row['TITULO']),
                            norm(row['NOME_STATUS_TITULO']),
                            normDate(row['DATA_OPERACAO']),
                            normDate(row['DATA_VENCIMENTO']),
                            normNum(row['DIAS_EM_ATRASO']),
                            normNum(row['VALOR_TITULO']),
                            normNum(row['VALOR_TITULO_SALDO_DEVEDOR']),
                            norm(row['FLAG_COBRANCA_ELEGIVEL_PROTESTO']),
                            norm(row['FLAG_COBRANCA_ELEGIVEL_SERASA']),
                            logId
                        ]);
                        contadores.devedores++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Devedor ${row['NOME_CLIENTE']}: ${e.message}`);
                    }
                }
            });
        }
        // ── 2c. CANCELAMENTOS ────────────────────────────────────────────────
        const cancelRows = sheetToRows(wb, 'CANCELAMENTOS');
        if (cancelRows.length > 0) {
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of cancelRows) {
                    try {
                        const sold = normNum(row['SOLD']);
                        if (!sold)
                            continue;
                        await client.query(`
                            INSERT INTO cancelamentos (
                                razao_social, sold, nome_vendedor, status, observacao,
                                data_solicitacao_froneri, mes_descricao, ano
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
                            ON CONFLICT DO NOTHING
                        `, [
                            norm(row['RAZÃO SOCIAL']),
                            sold,
                            norm(row['VENDEDOR']),
                            norm(row['STATUS']),
                            norm(row['OBSERVAÇÃO']),
                            normDate(row['DATA SOLICITAÇÃO FRONERI']),
                            norm(row['Mês']),
                            normNum(row['ANO'])
                        ]);
                        contadores.cancelamentos++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Cancelamento SOLD ${row['SOLD']}: ${e.message}`);
                    }
                }
            });
        }
        await finalizarLog(logId, 'concluido', contadores, errosLog);
        return { sucesso: true, logId, contadores };
    }
    catch (err) {
        await finalizarLog(logId, 'erro', contadores, [err.message]);
        throw err;
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// 3. IMPORTAR CADASTROS FRONERI (xlsx)
//    Sheets: "CADASTROS", "BASE DE CLIENTES", "BASE DE TICKETS", "ALTERAÇÕES"
// ═══════════════════════════════════════════════════════════════════════════════
async function importarCadastros(filePath, usuarioId) {
    const logId = await criarLog(filePath, 'froneri_cadastros', usuarioId);
    await loadVendedoresMap();
    let contadores = { cadastros: 0, clientes: 0, tickets: 0, alteracoes: 0, erros: 0 };
    const errosLog = [];
    try {
        const wb = readWorkbook(filePath);
        // ── 3a. BASE DE CLIENTES (base ativa Froneri) ────────────────────────
        const clienteRows = sheetToRows(wb, 'BASE DE CLIENTES') ||
            sheetToRows(wb, 'BASE ATIVA') || [];
        if (clienteRows.length > 0) {
            await importarClientesDaBase(clienteRows);
            contadores.clientes = clienteRows.length;
        }
        // ── 3b. CADASTROS ────────────────────────────────────────────────────
        const cadRows = sheetToRows(wb, 'CADASTROS') ||
            sheetToRows(wb, 'RELATÓRIO DE CADASTROS') || [];
        await (0, database_1.withTransaction)(async (client) => {
            for (const row of cadRows) {
                try {
                    const cnpj = norm(row['CNPJ']);
                    if (!cnpj)
                        continue;
                    const nomeVendedor = norm(row['VENDEDOR - TERRITÓRIO (que irá tirar pedido do cliente)']);
                    const vendedorId = nomeVendedor
                        ? (vendedoresMap[nomeVendedor] || null)
                        : null;
                    await client.query(`
                        INSERT INTO cadastros (
                            cnpj, razao_social, canal_cliente, segmento, cidade, email, telefone,
                            vendedor_id, nome_vendedor, dia_atendimento, modelo_freezer,
                            voltagem_freezer, cadastro_froneri_wmc, nome_prospector,
                            sold, status, observacao, data_solicitacao_froneri,
                            data_solicitacao_vd, data_resolucao, mes_finalizacao,
                            data_reprovacao, solicitacao_freezer, numero_ticket,
                            mes_numero, ano
                        ) VALUES (
                            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
                            $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26
                        )
                        ON CONFLICT DO NOTHING
                    `, [
                        cnpj,
                        norm(row['RAZÃO SOCIAL']),
                        norm(row['CANAL DO CLIENTE']),
                        norm(row['SEGMENTO (TIPO DE ESTABELECIMENTO)']),
                        norm(row['CIDADE'] || row['CIDADE 2']),
                        norm(row['E-MAIL']),
                        norm(row['TELEFONE COM DDD']),
                        vendedorId,
                        nomeVendedor,
                        norm(row['DIA DO ATENDIMENTO']),
                        norm(row['MODELO FREEZER']),
                        norm(row['VOLTAGEM FREEZER']),
                        norm(row['CADASTRO FRONERI E WMC?\n(COMPRA DE SECO, REFRIGERADO E CONGELADO)\n\nSe sim, será enviado por WhatsApp o código WMC e em breve o sold Froneri, caso aprovado. ']),
                        norm(row['NOME DO PROSPECTOR QUE FEZ A ABERTURA DO CADASTRO']),
                        normNum(row['SOLD']),
                        norm(row['STATUS']),
                        norm(row['OBSERVAÇÃO']),
                        normDate(row['DATA SOLICITAÇÃO FRONERI']),
                        normDate(row['DATA SOLICITAÇÃO / REANÁLISE / REATIVAÇÃO']),
                        normDate(row['DATA RESOLUÇÃO ']),
                        normNum(row['Mês finalização Cadastro']),
                        normDate(row['DATA REPROVAÇÃO']),
                        norm(row['SOLICITAÇÃO FREEZER']),
                        norm(row['NUMERO TICKET']),
                        normNum(row['N° MÊS']),
                        normNum(row['ANO'])
                    ]);
                    contadores.cadastros++;
                }
                catch (e) {
                    contadores.erros++;
                    errosLog.push(`Cadastro CNPJ ${row['CNPJ']}: ${e.message}`);
                }
            }
        });
        // ── 3c. BASE DE TICKETS ──────────────────────────────────────────────
        const ticketRows = sheetToRows(wb, 'BASE DE TICKETS');
        if (ticketRows && ticketRows.length > 0) {
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of ticketRows) {
                    try {
                        const codigoExt = normNum(row['Codigo']);
                        if (!codigoExt)
                            continue;
                        const nomeVendedor = norm(row['VENDEDOR']);
                        const vendedorId = nomeVendedor
                            ? (vendedoresMap[nomeVendedor] || null)
                            : null;
                        await client.query(`
                            INSERT INTO tickets (
                                codigo_externo, natureza, tipo, descricao_cliente,
                                modelo_freezer, responsavel_interno, status, empresa,
                                criado_em, tipo_problema, faturado, cidade,
                                vendedor_id, nome_vendedor, rota_tipo
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                            ON CONFLICT (codigo_externo) DO UPDATE SET
                                status     = EXCLUDED.status,
                                faturado   = EXCLUDED.faturado,
                                updated_at = NOW()
                        `, [
                            codigoExt,
                            norm(row['Natureza']),
                            norm(row['Tipo']),
                            norm(row['Descrição']),
                            norm(row['Bem']),
                            norm(row['Responsável Interno']),
                            norm(row['Status']),
                            norm(row['Empresa']),
                            normDate(row['Criado em']),
                            norm(row['Tipo de Problema']),
                            norm(row['FATURADO']),
                            norm(row['CIDADE']),
                            vendedorId,
                            nomeVendedor,
                            norm(row['ROTA NORMAL/ ROTA VJ'])
                        ]);
                        contadores.tickets++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Ticket ${row['Codigo']}: ${e.message}`);
                    }
                }
            });
        }
        // ── 3d. ALTERAÇÕES ───────────────────────────────────────────────────
        const altRows = sheetToRows(wb, 'ALTERAÇÕES');
        if (altRows && altRows.length > 0) {
            await (0, database_1.withTransaction)(async (client) => {
                for (const row of altRows) {
                    try {
                        const cnpj = norm(row['CNPJ']);
                        if (!cnpj)
                            continue;
                        const quem = norm(row['QUEM SOLICITOU']);
                        const vendedorId = quem ? (vendedoresMap[quem] || null) : null;
                        await client.query(`
                            INSERT INTO alteracoes (
                                cnpj, razao_social, sold, quem_solicitou, vendedor_id,
                                status, tipo_solicitacao, observacao,
                                data_solicitacao_vd, data_solicitacao_froneri
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
                            ON CONFLICT DO NOTHING
                        `, [
                            cnpj,
                            norm(row['RAZÃO SOCIAL']),
                            normNum(row['SOLD']),
                            quem,
                            vendedorId,
                            norm(row['STATUS']),
                            norm(row['SOLICITAÇÃO']),
                            norm(row['OBSERVAÇÃO']),
                            normDate(row['DATA SOLICITAÇÃO VD']),
                            normDate(row['DATA SOLICITAÇÃO P/ FRONERI'])
                        ]);
                        contadores.alteracoes++;
                    }
                    catch (e) {
                        contadores.erros++;
                        errosLog.push(`Alteração CNPJ ${row['CNPJ']}: ${e.message}`);
                    }
                }
            });
        }
        await finalizarLog(logId, 'concluido', contadores, errosLog);
        return { sucesso: true, logId, contadores };
    }
    catch (err) {
        await finalizarLog(logId, 'erro', contadores, [err.message]);
        throw err;
    }
}
// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Upsert clientes a partir de qualquer base (BASE ATIVA, BASE RUPTURA...)
// ═══════════════════════════════════════════════════════════════════════════════
async function importarClientesDaBase(rows) {
    await (0, database_1.withTransaction)(async (client) => {
        for (const row of rows) {
            try {
                const customerNumber = normNum(row['Customer Number'] || row['Sold'] || row['SOLD']);
                if (!customerNumber)
                    continue;
                const description2 = norm(row['Description 2']);
                const codigoSetor = norm(row['Código'] || row['Codigo']);
                const vendedorDesc = norm(row['Description'] || row['Vendedor']);
                const vendedorId = resolveVendedorId(description2, vendedorDesc, codigoSetor);
                await client.query(`
                    INSERT INTO clientes (
                        customer_number, customer_name, cnpj, address_line1, address_line2,
                        postal_code, city, region, filial, canal_cliente, hierarquia,
                        hierarquia_code, segmentacao_cliente, categoria_code24, payment_terms,
                        credit_limit, telefone, gln_number, additional_tax_id, status,
                        nova_rup, tem_contrato, qtd_conservadora, codigo_hierarquia,
                        descricao1, codigo_setor, territory_number, territory_description,
                        vendedor_id, ruptura_garoto
                    ) VALUES (
                        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30
                    )
                    ON CONFLICT (customer_number) DO UPDATE SET
                        customer_name        = EXCLUDED.customer_name,
                        address_line1        = COALESCE(EXCLUDED.address_line1, clientes.address_line1),
                        address_line2        = COALESCE(EXCLUDED.address_line2, clientes.address_line2),
                        city                 = COALESCE(EXCLUDED.city, clientes.city),
                        canal_cliente        = COALESCE(EXCLUDED.canal_cliente, clientes.canal_cliente),
                        hierarquia           = COALESCE(EXCLUDED.hierarquia, clientes.hierarquia),
                        segmentacao_cliente  = COALESCE(EXCLUDED.segmentacao_cliente, clientes.segmentacao_cliente),
                        payment_terms        = COALESCE(EXCLUDED.payment_terms, clientes.payment_terms),
                        nova_rup             = COALESCE(EXCLUDED.nova_rup, clientes.nova_rup),
                        vendedor_id          = COALESCE(EXCLUDED.vendedor_id, clientes.vendedor_id),
                        status               = COALESCE(EXCLUDED.status, clientes.status),
                        qtd_conservadora     = COALESCE(EXCLUDED.qtd_conservadora, clientes.qtd_conservadora),
                        tem_contrato         = COALESCE(EXCLUDED.tem_contrato, clientes.tem_contrato),
                        ruptura_garoto       = COALESCE(EXCLUDED.ruptura_garoto, clientes.ruptura_garoto),
                        updated_at           = NOW()
                `, [
                    customerNumber,
                    norm(row['Customer Name'] || row['Razão Social']),
                    norm(row['CNPJ']),
                    norm(row['Address Line 2'] || row['Endereço']),
                    norm(row['Address Line 4'] || row['Bairro']),
                    norm(row['Postal Code']),
                    norm(row['City'] || row['Cidade']),
                    norm(row['Região']) || 'Minas Gerais',
                    norm(row['Filial']),
                    norm(row['Canal Cliente']),
                    norm(row['Category Code 23 Description']),
                    norm(row['Category Code 13 Description']),
                    norm(row['SEGMENTAÇÃO CLIENTE']),
                    norm(row['Category Code 24']),
                    norm(row['Payment Terms']),
                    normNum(row['Credit Limit']),
                    norm(row['Telefone']),
                    normNum(row['GLN Number']),
                    norm(row['Additional Tax ID']),
                    norm(row['Status']) || 'C',
                    norm(row['Nova Rup']),
                    norm(row["C/ Contrato?"]) === 'Sim',
                    normNum(row['Qtd Conservadora']) || 0,
                    normNum(row['Código Hierarquia']),
                    norm(row['Descrição 1']),
                    codigoSetor,
                    normNum(description2),
                    vendedorDesc,
                    vendedorId,
                    norm(row['Ruptura Garoto'])
                ]);
            }
            catch (e) {
                // Log silencioso para não interromper o loop
                console.warn('[importarClientes] Erro cliente:', norm(row['Customer Number']), '-', e.message);
            }
        }
    });
}
// ─── Upsert produto ──────────────────────────────────────────────────────────
async function upsertProduto(client, row) {
    const codItem = norm(row['COD_ITEM']);
    if (!codItem)
        return;
    await client.query(`
        INSERT INTO produtos (cod_item, descricao, categoria, subcategoria, segmento_sku, categoria_total_sku)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (cod_item) DO UPDATE SET
            descricao           = EXCLUDED.descricao,
            categoria           = COALESCE(EXCLUDED.categoria, produtos.categoria),
            subcategoria        = COALESCE(EXCLUDED.subcategoria, produtos.subcategoria),
            segmento_sku        = COALESCE(EXCLUDED.segmento_sku, produtos.segmento_sku),
            categoria_total_sku = COALESCE(EXCLUDED.categoria_total_sku, produtos.categoria_total_sku),
            updated_at          = NOW()
    `, [
        codItem,
        norm(row['Descrição Produto']),
        norm(row['CATEGORIA']),
        norm(row['SUBCATEGORIA']),
        norm(row['Segmento SKU']),
        norm(row['Categoria TOTAL SKU'])
    ]);
}
// ─── Log helpers ─────────────────────────────────────────────────────────────
async function criarLog(filePath, tipoArquivo, usuarioId) {
    const res = await (0, database_1.query)(`
        INSERT INTO importacoes_log (arquivo_nome, tipo_arquivo, status, usuario_id)
        VALUES ($1, $2, 'processando', $3)
        RETURNING id
    `, [path_1.default.basename(filePath), tipoArquivo, usuarioId]);
    return res.rows[0].id;
}
async function finalizarLog(logId, status, contadores, erros) {
    const logText = erros.length > 0 ? erros.slice(0, 100).join('\n') : null;
    await (0, database_1.query)(`
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
        contadores.vendas || 0,
        contadores.clientes || 0,
        contadores.ruptura || 0,
        contadores.pedidos || 0,
        contadores.erros || 0,
        logText,
        logId
    ]);
}
