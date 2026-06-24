/**
 * importService.ts
 * Serviço de importação do Relatório_Vendas_BROKER (xlsb) da Froneri.
 * Sheets processadas: "Base Ruptura", "Base Vendas", "Base Ordens Carteira"
 *
 * As abas "Ruptura" e "Venda Vendedor" são relatórios visuais (tabelas
 * dinâmicas) e NÃO são importadas.
 *
 * IMPORTANTE — fontes que NÃO vêm desta planilha (preenchidas por SQL/outras
 * planilhas e por isso intencionalmente ignoradas aqui):
 *   - ruptura.justificativa / pedido_em_carteira / observacao_* / data_solicitacao_cancelamento
 *   - tabelas devedores, cancelamentos, roteirizacao
 */

import * as XLSX from 'xlsx';
import path from 'path';
import fs from 'fs';
import { withTransaction, query } from '../config/database';

// ─── Mapa de Vendedores por descrição/território ─────────────────────────────
let vendedoresMap = {};  // key: "territorio" | "setor" | "alias" | "codigo" → vendedor_id

async function loadVendedoresMap() {
    const res = await query(
        'SELECT id, codigo_vendedor, setor, territory_number, vendedor_alias FROM vendedores WHERE ativo = TRUE'
    );
    vendedoresMap = {};
    for (const row of res.rows) {
        if (row.territory_number) vendedoresMap[String(row.territory_number)] = row.id;
        if (row.setor)            vendedoresMap[row.setor.toUpperCase()]       = row.id;
        if (row.vendedor_alias)   vendedoresMap[row.vendedor_alias.trim()]     = row.id;
        if (row.codigo_vendedor)  vendedoresMap[String(row.codigo_vendedor)]   = row.id;
    }
    return vendedoresMap;
}

// ─── Helper: resolver vendedor_id a partir de vários campos ──────────────────
function resolveVendedorId(description2, vendedorDesc, codigoSetor) {
    if (description2 && vendedoresMap[String(description2)]) return vendedoresMap[String(description2)];
    if (codigoSetor   && vendedoresMap[codigoSetor.toUpperCase()]) return vendedoresMap[codigoSetor.toUpperCase()];
    if (vendedorDesc  && vendedoresMap[vendedorDesc.trim()])  return vendedoresMap[vendedorDesc.trim()];
    return null;
}

// ─── Helpers de normalização ─────────────────────────────────────────────────
const norm = v => (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v))) ? null : String(v).trim();
// Froneri usa "Blank" como placeholder para campos sem descrição no JDE — tratar como null.
const normDesc = v => { const s = norm(v); return (s === 'Blank' || s === 'blank') ? null : s; };

// Status do CLIENTE (Base Ruptura). A Froneri usa 'C', 'I', 'S' e também 'CI'
// (Cliente Inativo). O schema de clientes.status só aceita C/I/S, então 'CI'
// (e variações de inativo/suspenso) são mapeadas corretamente em vez de virar 'C'.
const normStatus = (v: unknown): 'C' | 'I' | 'S' => {
    const s = norm(v)?.toUpperCase();
    if (s === 'CI' || s === 'I' || s === 'INATIVO' || s === 'INACTIVE') return 'I';
    if (s === 'S'  || s === 'SUSPENSO' || s === 'SUSPENDED') return 'S';
    return 'C';
};

// Status da VENDA (Base Vendas). Normaliza para um conjunto fixo, preservando
// a distinção entre venda real, amostra grátis e devolução.
const normStatusVenda = (v: unknown): 'VENDA' | 'AMOSTRA GRATIS' | 'DEVOLUCAO' | 'OUTRO' => {
    const s = norm(v)?.toUpperCase();
    if (!s) return 'VENDA';
    if (s.startsWith('VENDA')) return 'VENDA';
    if (s.startsWith('AMOSTRA')) return 'AMOSTRA GRATIS';
    if (s.startsWith('DEVOLU')) return 'DEVOLUCAO';
    return 'OUTRO';
};

const normNum = v => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
};
const normDate = v => {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0];
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

function formatMesReferencia(mes, ano) {
    if (!mes || !ano) return null;
    return `${String(mes).padStart(2, '0')}/${ano}`;
}

function pickPeriodoFromRows(rows: Record<string, unknown>[], dateColumns: string[], monthColumns: string[] = []) {
    const counts = new Map<string, { mes: number; ano: number; mesReferencia: string | null; total: number }>();

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
            total: 1,
        });
    }

    let escolhido: { mes: number; ano: number; mesReferencia: string | null; total: number } | null = null;
    for (const periodo of counts.values()) {
        if (!escolhido || periodo.total > escolhido.total) escolhido = periodo;
    }

    return escolhido;
}

function pickPeriodoFromFileName(filePath: string) {
    const baseName = path.basename(filePath, path.extname(filePath)).toLowerCase();
    const anoMatch = baseName.match(/(20\d{2})/);
    const ano = anoMatch ? Number(anoMatch[1]) : null;

    for (const [mesDesc, mes] of Object.entries(MESES_MAP)) {
        if (baseName.includes(mesDesc)) {
            return {
                mes,
                ano: ano || new Date().getFullYear(),
                mesReferencia: mesDesc,
            };
        }
    }

    const numericMatch = baseName.match(/(?:^|[^\d])(0?[1-9]|1[0-2])[\/_-](20\d{2})(?:[^\d]|$)/);
    if (numericMatch) {
        return {
            mes: Number(numericMatch[1]),
            ano: Number(numericMatch[2]),
            mesReferencia: `${numericMatch[1]}/${numericMatch[2]}`,
        };
    }

    return null;
}

function inferPeriodoRelatorio(filePath: string, vendasRows: Record<string, unknown>[], pedidosRows: Record<string, unknown>[]) {
    const periodoVendas = pickPeriodoFromRows(vendasRows, ['Data Faturamento'], ['Mês Descrição']);
    if (periodoVendas) return periodoVendas;

    const periodoPedidos = pickPeriodoFromRows(pedidosRows, ['Order Date'], ['Mês', 'Mes']);
    if (periodoPedidos) return periodoPedidos;

    const periodoArquivo = pickPeriodoFromFileName(filePath);
    if (periodoArquivo) return { ...periodoArquivo, total: 0 };

    const hoje = new Date();
    return {
        mes: hoje.getMonth() + 1,
        ano: hoje.getFullYear(),
        mesReferencia: formatMesReferencia(hoje.getMonth() + 1, hoje.getFullYear()),
        total: 0,
    };
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

// Normaliza chaves das colunas: remove espaços extras e colapsa múltiplos espaços.
function normalizeKeys(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return rows.map(row => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) {
            out[k.trim().replace(/\s+/g, ' ')] = v;
        }
        return out;
    });
}

function sheetToRows(wb, sheetName) {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: false }) as Record<string, unknown>[];
    return normalizeKeys(rows);
}

// Lê um campo com suporte a múltiplos nomes alternativos.
function col(row: Record<string, unknown>, ...names: string[]): unknown {
    for (const name of names) {
        const v = row[name];
        if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. IMPORTAR RELATÓRIO DE VENDAS (xlsb da Froneri)
//    Ordem obrigatória: Base Ruptura → Base Vendas → Base Ordens Carteira
//    Base Ruptura primeiro para garantir que clientes existam antes dos FKs.
// ═══════════════════════════════════════════════════════════════════════════════
async function importarRelatorioVendas(filePath, usuarioId) {
    const logId = await criarLog(filePath, 'froneri_vendas', usuarioId);
    await loadVendedoresMap();

    let contadores = {
        vendas: 0, amostras: 0, devolucoes: 0, outros: 0,
        pedidos: 0, ruptura: 0, clientes: 0, erros: 0
    };
    const errosLog = [];

    try {
        const wb = readWorkbook(filePath);
        const vendasRows = sheetToRows(wb, 'Base Vendas');
        const pedidosRows = sheetToRows(wb, 'Base Ordens Carteira');
        const periodoRelatorio = inferPeriodoRelatorio(filePath, vendasRows, pedidosRows);

        // ── 1a. Base Ruptura — PRIMEIRO (popula clientes) ─────────────────────
        const rupturaRows = sheetToRows(wb, 'Base Ruptura');
        if (rupturaRows.length > 0) {
            await importarClientesDaBase(rupturaRows);
            contadores.clientes += rupturaRows.length;

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

                        // Só os campos que ESTA planilha fornece. Os campos de
                        // tratamento (justificativa, observação, pedido em carteira,
                        // data de cancelamento) NÃO vêm da planilha Froneri e por
                        // isso não são tocados aqui — são mantidos via SQL/outras fontes.
                        await client.query(`
                            INSERT INTO ruptura (
                                customer_number, vendedor_id, status_ruptura,
                                mes_referencia, mes_numero, ano, importacao_id
                            ) VALUES ($1,$2,$3,$4,$5,$6,$7)
                            ON DUPLICATE KEY UPDATE
                                vendedor_id    = VALUES(vendedor_id),
                                status_ruptura = VALUES(status_ruptura),
                                importacao_id  = VALUES(importacao_id),
                                updated_at     = NOW()
                        `, [
                            customerNumber,
                            vendedorId,
                            norm(row['Nova Rup']) || 'Ruptura',
                            periodoRelatorio.mesReferencia,
                            periodoRelatorio.mes,
                            periodoRelatorio.ano,
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

        // ── 1b. Base Vendas ──────────────────────────────────────────────────
        // Agora importa TODAS as linhas: VENDA, AMOSTRA GRÁTIS e DEVOLUÇÃO.
        // O status é gravado em vendas.status_venda para permitir filtrar depois.
        // Devoluções têm caixas/litros/valores NEGATIVOS (vêm assim da planilha)
        // e são preservadas como tal.
        if (vendasRows.length > 0) {
            await withTransaction(async (client) => {
                for (const row of vendasRows) {
                    try {
                        const statusVenda = normStatusVenda(row['Status']);

                        const dataFat = normDate(row['Data Faturamento']);
                        const { mes, ano } = getMesAno(dataFat);
                        const mesDesc = norm(row['Mês Descrição']);

                        const vendedorId = resolveVendedorId(
                            norm(row['Description 2']),
                            norm(row['Vendedor.Description']),
                            null
                        );

                        await upsertProduto(client, row);

                        // Garante que o cliente existe mesmo se não vier na Base Ruptura
                        await client.query(`
                            INSERT INTO clientes (customer_number, customer_name, cnpj, city,
                                canal_cliente, hierarquia, segmentacao_cliente, filial, vendedor_id)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
                            ON DUPLICATE KEY UPDATE
                                customer_name = VALUES(customer_name),
                                updated_at    = NOW()
                        `, [
                            normNum(row['Customer Number']),
                            norm(row['Customer Name']),
                            norm(row['CNPJ']),
                            norm(row['City']),
                            norm(row['Canal Cliente']),
                            norm(row['Hierarquia.Description']),
                            norm(row['SEGMENTAÇÃO CLIENTE']),
                            norm(row['Filial']),
                            vendedorId
                        ]);

                        await client.query(`
                            INSERT INTO vendas (
                                customer_number, customer_name, vendedor_id, vendedor_alias,
                                numero_nf, data_faturamento, mes_descricao, mes_numero, ano,
                                cod_item, descricao_produto, categoria, subcategoria,
                                segmento_sku, categoria_total_sku,
                                soma_caixas, soma_pallets, soma_litros, valor_nf, valor_vbc,
                                status_venda,
                                canal_cliente, hierarquia, segmentacao_cliente, filial,
                                city, cnpj, fonte_arquivo, importacao_id
                            ) VALUES (
                                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29
                            )
                            ON DUPLICATE KEY UPDATE
                                status_venda = VALUES(status_venda),
                                soma_caixas  = VALUES(soma_caixas),
                                soma_pallets = VALUES(soma_pallets),
                                soma_litros  = VALUES(soma_litros),
                                valor_nf     = VALUES(valor_nf),
                                valor_vbc    = VALUES(valor_vbc)
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
                            normNum(col(row, 'SomaDeCaixas', 'Soma Caixas', 'Caixas')),
                            normNum(col(row, 'SomaDePallets', 'Soma Pallets', 'Pallets')),
                            normNum(col(row, 'SomaDeLitros', 'Soma Litros', 'Litros')),
                            normNum(col(row, 'SomaDeValor NF', 'Valor NF', 'ValorNF')),
                            normNum(col(row, 'SomaDeValor VBC', 'Valor VBC', 'ValorVBC')),
                            statusVenda,
                            norm(row['Canal Cliente']),
                            norm(row['Hierarquia.Description']),
                            norm(row['SEGMENTAÇÃO CLIENTE']),
                            norm(row['Filial']),
                            norm(row['City']),
                            norm(row['CNPJ']),
                            path.basename(filePath),
                            logId
                        ]);

                        // Contadores por tipo
                        if (statusVenda === 'VENDA')              contadores.vendas++;
                        else if (statusVenda === 'AMOSTRA GRATIS') contadores.amostras++;
                        else if (statusVenda === 'DEVOLUCAO')      contadores.devolucoes++;
                        else                                       contadores.outros++;
                    } catch (e) {
                        contadores.erros++;
                        errosLog.push(`Venda NF ${row['Número NF']} (${row['Status']}): ${e.message}`);
                    }
                }
            });
        }

        // ── 1c. Base Ordens Carteira ─────────────────────────────────────────
        // Pode vir vazia em alguns meses; nesse caso simplesmente não há pedidos.
        if (pedidosRows.length > 0) {
            await withTransaction(async (client) => {
                for (const row of pedidosRows) {
                    try {
                        const orderDate  = normDate(row['Order Date']);
                        const mesDesc    = norm(col(row, 'Mês', 'Mes'));
                        const vendedorId = resolveVendedorId(
                            norm(row['Description 2']),
                            norm(row['Vendedor.Description']),
                            null
                        );

                        await client.query(`
                            INSERT INTO pedidos_carteira (
                                customer_number, customer_name, order_number, order_date,
                                vendedor_id, vendedor_alias, territory_number,
                                cod_item, descricao_produto, categoria, subcategoria,
                                soma_litros, quantity_shipped, extended_amount, soma_pallets,
                                segmento_sku, categoria_total_sku, mes_descricao, mes_numero, ano,
                                hierarquia, canal_cliente, filial, status, importacao_id
                            ) VALUES (
                                $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                                $16,$17,$18,$19,$20,$21,$22,$23,$24,$25
                            )
                            ON DUPLICATE KEY UPDATE
                                customer_name       = VALUES(customer_name),
                                order_date          = VALUES(order_date),
                                vendedor_id         = VALUES(vendedor_id),
                                vendedor_alias      = VALUES(vendedor_alias),
                                territory_number    = VALUES(territory_number),
                                descricao_produto   = VALUES(descricao_produto),
                                categoria           = VALUES(categoria),
                                subcategoria        = VALUES(subcategoria),
                                soma_litros         = VALUES(soma_litros),
                                quantity_shipped    = VALUES(quantity_shipped),
                                extended_amount     = VALUES(extended_amount),
                                soma_pallets        = VALUES(soma_pallets),
                                segmento_sku        = VALUES(segmento_sku),
                                categoria_total_sku = VALUES(categoria_total_sku),
                                mes_descricao       = VALUES(mes_descricao),
                                mes_numero          = VALUES(mes_numero),
                                ano                 = VALUES(ano),
                                hierarquia          = VALUES(hierarquia),
                                canal_cliente       = VALUES(canal_cliente),
                                filial              = VALUES(filial),
                                status              = VALUES(status),
                                importacao_id       = VALUES(importacao_id)
                        `, [
                            normNum(col(row, 'Ship To Number', 'Customer Number')),
                            norm(col(row, 'Alpha Name', 'Customer Name')),
                            normNum(row['OrderNumber']),
                            orderDate,
                            vendedorId,
                            norm(row['Vendedor.Description']),
                            normNum(row['Description 2']),
                            norm(col(row, '2nd Item Number', 'COD_ITEM')),
                            norm(col(row, 'Ordem_Delivery.Description', 'Descrição Produto')),
                            norm(row['CATEGORIA']),
                            norm(row['SUBCATEGORIA']),
                            normNum(row['Litros']),
                            normNum(row['Quantity Shipped']),
                            normNum(row['Extended Amount']),
                            normNum(row['Pallets']),
                            norm(col(row, 'Segmento', 'Segmento SKU')),
                            norm(col(row, 'Categoria TOTAL', 'Categoria TOTAL SKU')),
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

        await finalizarLog(logId, 'concluido', contadores, errosLog);
        return { sucesso: true, logId, contadores };

    } catch (err) {
        await finalizarLog(logId, 'erro', contadores, [err.message]);
        throw err;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Upsert clientes a partir da Base Ruptura (base completa de cadastro)
// ═══════════════════════════════════════════════════════════════════════════════
async function importarClientesDaBase(rows) {
    await withTransaction(async (client) => {
        for (const row of rows) {
            const customerNumber = normNum(row['Customer Number'] || row['Sold'] || row['SOLD']);
            if (!customerNumber) continue;

            try {
                await client.query('SAVEPOINT sp_cliente');

                const description2   = norm(row['Description 2']);
                const codigoSetor    = norm(row['Código'] || row['Codigo']);
                const vendedorDesc   = norm(row['Description'] || row['Vendedor']);
                const vendedorId     = resolveVendedorId(description2, vendedorDesc, codigoSetor);

                // payment_terms: a Base Ruptura traz tanto "Payment Terms" quanto a
                // coluna "Descrição" (ex: "Preço à Prazo 14 dias"). Usa a que vier.
                const paymentTerms = norm(col(row, 'Payment Terms', 'Descrição'));

                await client.query(`
                    INSERT INTO clientes (
                        customer_number, customer_name, cnpj, logradouro, bairro,
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
                    ON DUPLICATE KEY UPDATE
                        customer_name        = VALUES(customer_name),
                        cnpj                 = COALESCE(VALUES(cnpj), clientes.cnpj),
                        logradouro           = COALESCE(VALUES(logradouro), clientes.logradouro),
                        bairro               = COALESCE(VALUES(bairro), clientes.bairro),
                        postal_code          = COALESCE(VALUES(postal_code), clientes.postal_code),
                        city                 = COALESCE(VALUES(city), clientes.city),
                        region               = COALESCE(VALUES(region), clientes.region),
                        filial               = COALESCE(VALUES(filial), clientes.filial),
                        canal_cliente        = COALESCE(VALUES(canal_cliente), clientes.canal_cliente),
                        hierarquia           = COALESCE(VALUES(hierarquia), clientes.hierarquia),
                        hierarquia_code      = COALESCE(VALUES(hierarquia_code), clientes.hierarquia_code),
                        segmentacao_cliente  = COALESCE(VALUES(segmentacao_cliente), clientes.segmentacao_cliente),
                        categoria_code24     = COALESCE(VALUES(categoria_code24), clientes.categoria_code24),
                        payment_terms        = COALESCE(VALUES(payment_terms), clientes.payment_terms),
                        credit_limit         = COALESCE(VALUES(credit_limit), clientes.credit_limit),
                        telefone             = COALESCE(VALUES(telefone), clientes.telefone),
                        gln_number           = COALESCE(VALUES(gln_number), clientes.gln_number),
                        additional_tax_id    = COALESCE(VALUES(additional_tax_id), clientes.additional_tax_id),
                        status               = VALUES(status),
                        nova_rup             = COALESCE(VALUES(nova_rup), clientes.nova_rup),
                        tem_contrato         = VALUES(tem_contrato),
                        qtd_conservadora     = COALESCE(VALUES(qtd_conservadora), clientes.qtd_conservadora),
                        codigo_hierarquia    = COALESCE(VALUES(codigo_hierarquia), clientes.codigo_hierarquia),
                        descricao1           = COALESCE(VALUES(descricao1), clientes.descricao1),
                        codigo_setor         = COALESCE(VALUES(codigo_setor), clientes.codigo_setor),
                        territory_number     = COALESCE(VALUES(territory_number), clientes.territory_number),
                        territory_description = COALESCE(VALUES(territory_description), clientes.territory_description),
                        vendedor_id          = COALESCE(VALUES(vendedor_id), clientes.vendedor_id),
                        ruptura_garoto       = COALESCE(VALUES(ruptura_garoto), clientes.ruptura_garoto),
                        updated_at           = NOW()
                `, [
                    customerNumber,
                    norm(col(row, 'Customer Name', 'Razão Social')),
                    norm(row['CNPJ']),
                    norm(col(row, 'Address Line 2', 'Endereço')),  // logradouro
                    norm(col(row, 'Address Line 4', 'Bairro')),    // bairro
                    norm(row['Postal Code']),
                    norm(col(row, 'City', 'Cidade')),
                    norm(row['Região']) || 'Minas Gerais',
                    norm(row['Filial']),
                    norm(row['Canal Cliente']),
                    normDesc(row['Category Code 23 Description']),
                    normDesc(row['Category Code 13 Description']),
                    norm(row['SEGMENTAÇÃO CLIENTE']),
                    norm(row['Category Code 24']),
                    paymentTerms,
                    normNum(row['Credit Limit']),
                    norm(row['Telefone']),
                    normNum(row['GLN Number']),
                    norm(row['Additional Tax ID']),
                    normStatus(row['Status']),
                    norm(row['Nova Rup']),
                    norm(row["C/ Contrato?"]) === 'Sim',
                    normNum(row['Qtd Conservadora']) || 0,
                    normNum(row['Código Hierarquia']),
                    norm(row['Descrição 1']),
                    codigoSetor,
                    normNum(description2),
                    vendedorDesc,   // territory_description
                    vendedorId,
                    norm(row['Ruptura Garoto'])
                ]);

                await client.query('RELEASE SAVEPOINT sp_cliente');
            } catch (e) {
                await client.query('ROLLBACK TO SAVEPOINT sp_cliente');
                console.warn('[importarClientes] Erro cliente:', customerNumber, '-', e.message);
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
        ON DUPLICATE KEY UPDATE
            descricao           = VALUES(descricao),
            categoria           = COALESCE(VALUES(categoria), produtos.categoria),
            subcategoria        = COALESCE(VALUES(subcategoria), produtos.subcategoria),
            segmento_sku        = COALESCE(VALUES(segmento_sku), produtos.segmento_sku),
            categoria_total_sku = COALESCE(VALUES(categoria_total_sku), produtos.categoria_total_sku),
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
    const result = await query(`
        INSERT INTO importacoes_log (arquivo_nome, tipo_arquivo, status, usuario_id)
        VALUES ($1, $2, 'processando', $3)
    `, [path.basename(filePath), tipoArquivo, usuarioId]);
    return result.insertId;
}

async function finalizarLog(logId, status, contadores, erros) {
    const logText = erros.length > 0 ? erros.slice(0, 100).join('\n') : null;
    // registros_vendas agrega venda + amostra + devolução (todas as linhas da Base Vendas)
    const totalLinhasVendas =
        (contadores.vendas || 0) + (contadores.amostras || 0) +
        (contadores.devolucoes || 0) + (contadores.outros || 0);
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
        totalLinhasVendas,
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