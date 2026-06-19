/**
 * importService.ts
 * Serviço de importação do Relatório_Vendas_BROKER (xlsb) da Froneri.
 * Sheets: "Base Vendas", "Base Ordens Carteira", "Base Ruptura"
 */

import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { withTransaction, query } from '../config/database';

// ─── Mapa de Vendedores por descrição/território ─────────────────────────────
// Populado dinamicamente do banco na inicialização
let vendedoresMap = {};  // key: "territorio_number" ou "description_string" → vendedor_id

async function loadVendedoresMap() {
    const res = await query(
        'SELECT id, codigo_vendedor, setor, territorio, descricao FROM vendedores WHERE ativo = TRUE'
    );
    vendedoresMap = {};
    for (const row of res.rows) {
        if (row.territorio)  vendedoresMap[String(row.territorio)]  = row.id;
        if (row.setor)       vendedoresMap[row.setor.toUpperCase()]  = row.id;
        if (row.descricao)   vendedoresMap[row.descricao.trim()]     = row.id;
        if (row.codigo_vendedor) vendedoresMap[String(row.codigo_vendedor)] = row.id;
    }
    return vendedoresMap;
}

// ─── Helper: resolver vendedor_id a partir de vários campos ──────────────────
function resolveVendedorId(description2, vendedorDesc, codigoSetor) {
    // Description 2 é o número do território (ex: 295235)
    if (description2 && vendedoresMap[String(description2)]) return vendedoresMap[String(description2)];
    if (codigoSetor   && vendedoresMap[codigoSetor.toUpperCase()]) return vendedoresMap[codigoSetor.toUpperCase()];
    if (vendedorDesc  && vendedoresMap[vendedorDesc.trim()])  return vendedoresMap[vendedorDesc.trim()];
    return null;
}

// ─── Helper: normalizar string ───────────────────────────────────────────────
const norm = v => (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) ? null : String(v).trim();
const normNum = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
};
const normDate = v => {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0];
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
    if (!dateStr) return { mes: null, ano: null };
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { mes: null, ano: null };
    return { mes: d.getMonth() + 1, ano: d.getFullYear() };
}

const MESES_MAP = {
    'janeiro': 1, 'fevereiro': 2, 'março': 3, 'marco': 3,
    'abril': 4, 'maio': 5, 'junho': 6, 'julho': 7, 'agosto': 8,
    'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12
};

function parseMesDescricao(mesDesc) {
    if (!mesDesc) return null;
    return MESES_MAP[mesDesc.toLowerCase().trim()] || null;
}

// ─── Ler planilha com xlsx ────────────────────────────────────────────────────
function readWorkbook(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const opts = { type: 'buffer' as const, cellDates: true };
    const buffer = fs.readFileSync(filePath);
    if (ext === '.xlsb') {
        return XLSX.read(buffer, { ...opts, type: 'buffer' });
    }
    return XLSX.read(buffer, opts);
}

function sheetToRows(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
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
            await withTransaction(async (client) => {
                for (const row of vendasRows) {
                    try {
                        const statusVenda = norm(row['Status']);
                        if (statusVenda && statusVenda !== 'VENDA') continue;

                        const dataFat = normDate(row['Data Faturamento']);
                        const { mes, ano } = getMesAno(dataFat);
                        const mesDesc = norm(row['Mês Descrição']);

                        const vendedorId = resolveVendedorId(
                            norm(row['Description 2']),
                            norm(row['Vendedor.Description']),
                            null
                        );

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
                            ON CONFLICT (customer_number, numero_nf, cod_item, data_faturamento)
                            DO NOTHING
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
                            path.basename(filePath),
                            logId
                        ]);
                        contadores.vendas++;
                    } catch (e) {
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
                await query(
                    'DELETE FROM pedidos_carteira WHERE mes_numero = $1 AND ano = $2',
                    [mesRef, anoRef]
                );
            }

            await withTransaction(async (client) => {
                for (const row of pedidosRows) {
                    try {
                        const orderDate = normDate(row['Order Date']);
                        const mesDesc   = norm(row['Mês']);
                        const vendedorId = resolveVendedorId(
                            norm(row['Description 2']),
                            norm(row['Vendedor.Description']),
                            null
                        );

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
                    } catch (e) {
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
            await query('DELETE FROM ruptura WHERE mes_numero=$1 AND ano=$2', [mesAtual, anoAtual]);

            await withTransaction(async (client) => {
                for (const row of rupturaRows) {
                    try {
                        const customerNumber = normNum(row['Customer Number']);
                        if (!customerNumber) continue;

                        const vendedorId = resolveVendedorId(
                            norm(row['Description 2']),
                            null,
                            norm(row['Código'])
                        );

                        await client.query(`
                            INSERT INTO ruptura (
                                customer_number, vendedor_id, status_ruptura,
                                mes_numero, ano, importacao_id
                            ) VALUES ($1,$2,$3,$4,$5,$6)
                            ON CONFLICT DO NOTHING
                        `, [
                            customerNumber,
                            vendedorId,
                            norm(row['Nova Rup']) || 'Ruptura',
                            mesAtual,
                            anoAtual,
                            logId
                        ]);
                        contadores.ruptura++;
                    } catch (e) {
                        contadores.erros++;
                        errosLog.push(`Ruptura ${row['Customer Number']}: ${e.message}`);
                    }
                }
            });
        }

        await finalizarLog(logId, 'concluido', contadores, errosLog);
        return { sucesso: true, logId, contadores };

    } catch (err) {
        await finalizarLog(logId, 'erro', contadores, [err.message]);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Upsert clientes a partir de qualquer base (BASE ATIVA, BASE RUPTURA...)
// ═══════════════════════════════════════════════════════════════════════════════
async function importarClientesDaBase(rows) {
    await withTransaction(async (client) => {
        for (const row of rows) {
            try {
                const customerNumber = normNum(row['Customer Number'] || row['Sold'] || row['SOLD']);
                if (!customerNumber) continue;

                const description2   = norm(row['Description 2']);
                const codigoSetor    = norm(row['Código'] || row['Codigo']);
                const vendedorDesc   = norm(row['Description'] || row['Vendedor']);
                const vendedorId     = resolveVendedorId(description2, vendedorDesc, codigoSetor);

                const flagRuptura      = !!(norm(row['Ruptura']) && norm(row['Ruptura']) !== '');
                const flagDevedor      = !!(norm(row['Devedor']) && norm(row['Devedor']) !== '');
                const flagCancelamento = !!(norm(row['CANCELAMENTO']) && norm(row['CANCELAMENTO']) !== '');
                const observacao       = norm(row['OBSERVAÇÃO'] || row['obs'] || row['Observação']);

                await client.query(`
                    INSERT INTO clientes (
                        customer_number, customer_name, cnpj, address_line1, address_line2,
                        postal_code, city, region, filial, canal_cliente, hierarquia,
                        hierarquia_code, segmentacao_cliente, categoria_code24, payment_terms,
                        credit_limit, telefone, gln_number, additional_tax_id, status,
                        nova_rup, tem_contrato, qtd_conservadora, codigo_hierarquia,
                        descricao1, codigo_setor, territory_number, territory_description,
                        vendedor_id, ruptura_garoto,
                        observacao, flag_ruptura, flag_devedor, flag_cancelamento
                    ) VALUES (
                        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                        $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
                        $31,$32,$33,$34
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
                        observacao           = COALESCE(EXCLUDED.observacao, clientes.observacao),
                        flag_ruptura         = EXCLUDED.flag_ruptura,
                        flag_devedor         = EXCLUDED.flag_devedor,
                        flag_cancelamento    = EXCLUDED.flag_cancelamento,
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
                    norm(row['Ruptura Garoto']),
                    observacao,
                    flagRuptura,
                    flagDevedor,
                    flagCancelamento
                ]);
            } catch (e) {
                // Log silencioso para não interromper o loop
                console.warn('[importarClientes] Erro cliente:', norm(row['Customer Number']), '-', e.message);
            }
        }
    });
}

// ─── Upsert produto ──────────────────────────────────────────────────────────
async function upsertProduto(client, row) {
    const codItem = norm(row['COD_ITEM']);
    if (!codItem) return;

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
    const res = await query(`
        INSERT INTO importacoes_log (arquivo_nome, tipo_arquivo, status, usuario_id)
        VALUES ($1, $2, 'processando', $3)
        RETURNING id
    `, [path.basename(filePath), tipoArquivo, usuarioId]);
    return res.rows[0].id;
}

async function finalizarLog(logId, status, contadores, erros) {
    const logText = erros.length > 0 ? erros.slice(0, 100).join('\n') : null;
    await query(`
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
        contadores.vendas   || 0,
        contadores.clientes || 0,
        contadores.ruptura  || 0,
        contadores.pedidos  || 0,
        contadores.erros    || 0,
        logText,
        logId
    ]);
}

export {
    importarRelatorioVendas,
    loadVendedoresMap,
};

