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
import { randomUUID } from 'crypto';
import { withTransaction, query } from '../config/database';

type VendedoresMap = Record<string, number>;

// ─── Mapa de Vendedores por descrição/território ─────────────────────────────
// Retorna um mapa local — cada invocação cria seu próprio objeto para evitar
// race condition quando duas importações ocorrem em paralelo.
async function loadVendedoresMap(): Promise<VendedoresMap> {
    const res = await query(
        'SELECT id, codigo_vendedor, setor, territory_number, vendedor_alias FROM vendedores WHERE ativo = TRUE'
    );
    const map: VendedoresMap = {};
    for (const row of res.rows) {
        if (row.territory_number) map[String(row.territory_number)] = row.id;
        if (row.setor)            map[row.setor.toUpperCase()]       = row.id;
        if (row.vendedor_alias)   map[row.vendedor_alias.trim()]     = row.id;
        if (row.codigo_vendedor)  map[String(row.codigo_vendedor)]   = row.id;
    }
    console.log(`[import] Mapa de vendedores carregado: ${Object.keys(map).length} entradas`);
    return map;
}

// ─── Helper: resolver vendedor_id a partir de vários campos ──────────────────
function resolveVendedorId(
    map: VendedoresMap,
    description2: string | null,
    vendedorDesc: string | null,
    codigoSetor: string | null,
): number | null {
    if (description2 && map[String(description2)]) return map[String(description2)];
    if (codigoSetor   && map[codigoSetor.toUpperCase()]) return map[codigoSetor.toUpperCase()];
    if (vendedorDesc  && map[vendedorDesc.trim()])  return map[vendedorDesc.trim()];
    return null;
}

// ─── Helpers de normalização ─────────────────────────────────────────────────
const norm = (v: unknown): string | null =>
    (v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v)))
        ? null
        : String(v).trim();

// Froneri usa "Blank" como placeholder para campos sem descrição no JDE — tratar como null.
const normDesc = (v: unknown): string | null => {
    const s = norm(v);
    return (s === 'Blank' || s === 'blank') ? null : s;
};

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

const normNum = (v: unknown): number | null => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v));
    return isNaN(n) ? null : n;
};

const normDate = (v: unknown): string | null => {
    if (!v) return null;
    // xlsx com cellDates:true + raw:true entrega Date objects para colunas de data.
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v.toISOString().split('T')[0];
    // Serial numérico do Excel (raw:true em células sem cellDates).
    if (typeof v === 'number') {
        const d = new Date(Math.round((v - 25569) * 86400 * 1000));
        return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    }
    const s = String(v).trim();
    // Formato brasileiro DD/MM/YYYY — comum em planilhas Froneri com raw:false legado.
    const dmyMatch = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
    if (dmyMatch) {
        const d = new Date(Date.UTC(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1])));
        return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0];
    }
    // ISO 8601 e outros formatos reconhecidos pelo engine V8.
    const parsed = new Date(s);
    return isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
};

// ─── Extrair mês/ano UTC de uma data ISO ─────────────────────────────────────
// Usa getUTC* para evitar off-by-one em servidores com fuso negativo (UTC-X).
function getMesAno(dateStr: string | null): { mes: number | null; ano: number | null } {
    if (!dateStr) return { mes: null, ano: null };
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return { mes: null, ano: null };
    return { mes: d.getUTCMonth() + 1, ano: d.getUTCFullYear() };
}

const MESES_MAP: Record<string, number> = {
    'janeiro': 1, 'fevereiro': 2, 'março': 3, 'marco': 3,
    'abril': 4, 'maio': 5, 'junho': 6, 'julho': 7, 'agosto': 8,
    'setembro': 9, 'outubro': 10, 'novembro': 11, 'dezembro': 12
};

function parseMesDescricao(mesDesc: string | null): number | null {
    if (!mesDesc) return null;
    return MESES_MAP[mesDesc.toLowerCase().trim()] || null;
}

function formatMesReferencia(mes: number | null, ano: number | null): string | null {
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

function inferPeriodoRelatorio(
    filePath: string,
    vendasRows: Record<string, unknown>[],
    pedidosRows: Record<string, unknown>[],
) {
    const periodoVendas = pickPeriodoFromRows(vendasRows, ['Data Faturamento'], ['Mês Descrição']);
    if (periodoVendas) return periodoVendas;

    const periodoPedidos = pickPeriodoFromRows(pedidosRows, ['Order Date'], ['Mês', 'Mes']);
    if (periodoPedidos) return periodoPedidos;

    const periodoArquivo = pickPeriodoFromFileName(filePath);
    if (periodoArquivo) return { ...periodoArquivo, total: 0 };

    const hoje = new Date();
    console.warn('[import] Período não inferido das abas nem do nome do arquivo — usando data de hoje como fallback');
    return {
        mes: hoje.getMonth() + 1,
        ano: hoje.getFullYear(),
        mesReferencia: formatMesReferencia(hoje.getMonth() + 1, hoje.getFullYear()),
        total: 0,
    };
}

// ─── Ler planilha com xlsx ────────────────────────────────────────────────────
function readWorkbook(filePath: string) {
    const ext = path.extname(filePath).toLowerCase();
    // cellDates:true converte seriais numéricos em Date objects.
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

function sheetToRows(wb: any, sheetName: string): Record<string, unknown>[] {
    const ws = wb.Sheets[sheetName];
    if (!ws) return [];
    // raw:true preserva tipos nativos: números como number, datas como Date (via cellDates:true).
    // raw:false formata tudo como string usando o formato da célula, corrompendo Customer Number
    // (e.g. 12345 → "12,345") e impedindo que normDate receba Date objects.
    const rows = XLSX.utils.sheet_to_json(ws, { defval: null, raw: true }) as Record<string, unknown>[];
    return normalizeKeys(rows);
}

function normalizeSheetName(name: string): string {
    return String(name || '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();
}

function findSheetName(wb: any, expected: string, aliases: string[] = []): string | null {
    const names = Object.keys(wb?.Sheets || {});
    const candidates = [expected, ...aliases].map(normalizeSheetName);

    for (const name of names) {
        const normalized = normalizeSheetName(name);
        if (candidates.includes(normalized)) return name;
    }

    return null;
}

function sheetToRowsFlexible(wb: any, expected: string, aliases: string[] = []) {
    const realName = findSheetName(wb, expected, aliases);
    if (!realName) return { rows: [] as Record<string, unknown>[], sheetName: null as string | null };
    return { rows: sheetToRows(wb, realName), sheetName: realName };
}

// Lê um campo com suporte a múltiplos nomes alternativos.
function col(row: Record<string, unknown>, ...names: string[]): unknown {
    for (const name of names) {
        const v = row[name];
        if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
}

const IMPORT_CHUNK_SIZE = parseInt(process.env.IMPORT_CHUNK_SIZE || '1000', 10);

// ─── Bulk INSERT helper ────────────────────────────────────────────────────────
// Gera SQL de INSERT em lote. Reduz de N queries individuais para 1 por chunk,
// eliminando o overhead de round-trip ao banco remoto.
function bulkSql(table: string, cols: string[], rowCount: number, onDup: string): string {
    const rowPlaceholder = `(${cols.map(() => '?').join(',')})`;
    return (
        `INSERT INTO ${table} (${cols.join(',')}) VALUES ` +
        Array(rowCount).fill(rowPlaceholder).join(',') +
        ` ON DUPLICATE KEY UPDATE ${onDup}`
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. IMPORTAR RELATÓRIO DE VENDAS (xlsb da Froneri)
//    Ordem obrigatória: Base Ruptura → Base Vendas → Base Ordens Carteira
//    Base Ruptura primeiro para garantir que clientes existam antes dos FKs.
// ═══════════════════════════════════════════════════════════════════════════════
async function processarRelatorioVendas(filePath: string, _usuarioId: string, logId: string) {
    // Mapa local por invocação — duas importações simultâneas não compartilham estado.
    const vendedoresMap = await loadVendedoresMap();

    const contadores = {
        vendas: 0, amostras: 0, devolucoes: 0, outros: 0,
        pedidos: 0, ruptura: 0, clientes: 0, erros: 0,
    };
    const errosLog: string[] = [];

    try {
        const wb = readWorkbook(filePath);
        const vendasSheet  = sheetToRowsFlexible(wb, 'Base Vendas', ['Base vendas', 'Vendas']);
        const pedidosSheet = sheetToRowsFlexible(wb, 'Base Ordens Carteira', ['Base Ordens de Carteira', 'Ordens Carteira']);
        const rupturaSheet = sheetToRowsFlexible(wb, 'Base Ruptura', ['Ruptura', 'Base ruptura']);

        const vendasRows  = vendasSheet.rows;
        const pedidosRows = pedidosSheet.rows;
        const rupturaRows = rupturaSheet.rows;
        const periodoRelatorio = inferPeriodoRelatorio(filePath, vendasRows, pedidosRows);

        if (vendasRows.length === 0 && pedidosRows.length === 0 && rupturaRows.length === 0) {
            const disponiveis = Object.keys(wb?.Sheets || {}).join(', ');
            throw new Error(
                `Nenhuma linha encontrada nas abas esperadas. Abas encontradas: [${disponiveis}]. ` +
                `Esperadas: Base Ruptura, Base Vendas, Base Ordens Carteira.`
            );
        }

        console.log('[import/vendas] Abas lidas:', {
            ruptura: rupturaSheet.sheetName,
            vendas: vendasSheet.sheetName,
            pedidos: pedidosSheet.sheetName,
            linhas: { ruptura: rupturaRows.length, vendas: vendasRows.length, pedidos: pedidosRows.length },
            periodo: `${periodoRelatorio.mes}/${periodoRelatorio.ano}`,
        });

        // ── 1a. Base Ruptura — PRIMEIRO (popula clientes) ─────────────────────
        if (rupturaRows.length > 0) {
            // importarClientesDaBase retorna erros ao invés de swallowá-los.
            const clienteResult = await importarClientesDaBase(rupturaRows, vendedoresMap);
            contadores.clientes += clienteResult.clientesInseridos;
            if (clienteResult.erros.length > 0) {
                contadores.erros += clienteResult.erros.length;
                errosLog.push(...clienteResult.erros);
            }

            const RUPTURA_COLS = [
                'customer_number', 'vendedor_id', 'status_ruptura',
                'mes_referencia', 'mes_numero', 'ano', 'importacao_id',
            ];
            const RUPTURA_ON_DUP =
                'vendedor_id=VALUES(vendedor_id),' +
                'status_ruptura=VALUES(status_ruptura),' +
                'importacao_id=VALUES(importacao_id),' +
                'updated_at=NOW()';

            for (let i = 0; i < rupturaRows.length; i += IMPORT_CHUNK_SIZE) {
                const chunk = rupturaRows.slice(i, i + IMPORT_CHUNK_SIZE);
                const params: unknown[] = [];
                let rowCount = 0;
                let skipped = 0;

                for (const row of chunk) {
                    const customerNumber = normNum(row['Customer Number']);
                    if (!customerNumber) { skipped++; continue; }

                    const vendedorId = resolveVendedorId(vendedoresMap, norm(row['Description 2']), null, norm(row['Código']));
                    if (!vendedorId) {
                        console.warn(`[import/ruptura] Vendedor não encontrado — Description2="${row['Description 2']}" Código="${row['Código']}" customer=${customerNumber}`);
                    }
                    params.push(
                        customerNumber, vendedorId,
                        norm(row['Nova Rup']) || 'Ruptura',
                        periodoRelatorio.mesReferencia,
                        periodoRelatorio.mes, periodoRelatorio.ano,
                        logId,
                    );
                    rowCount++;
                }

                if (skipped > 0) {
                    console.warn(`[import/ruptura] chunk ${i}: ${skipped} linha(s) sem Customer Number ignorada(s)`);
                }
                if (rowCount === 0) continue;

                try {
                    await query(bulkSql('ruptura', RUPTURA_COLS, rowCount, RUPTURA_ON_DUP), params);
                    contadores.ruptura += rowCount;
                    console.log(`[import/ruptura] chunk ${i}: ${rowCount} registro(s) inserido(s)`);
                } catch (e: any) {
                    contadores.erros += rowCount;
                    errosLog.push(`Ruptura chunk ${i}: ${e.message}`);
                    console.error(`[import/ruptura] Erro no chunk ${i}:`, e.message);
                }
            }
        }

        // ── 1b. Base Vendas ──────────────────────────────────────────────────
        if (vendasRows.length > 0) {
            const PRODUTO_COLS = [
                'cod_item', 'descricao', 'categoria', 'subcategoria',
                'segmento_sku', 'categoria_total_sku',
            ];
            const PRODUTO_ON_DUP =
                'descricao=VALUES(descricao),' +
                'categoria=COALESCE(VALUES(categoria),categoria),' +
                'subcategoria=COALESCE(VALUES(subcategoria),subcategoria),' +
                'segmento_sku=COALESCE(VALUES(segmento_sku),segmento_sku),' +
                'categoria_total_sku=COALESCE(VALUES(categoria_total_sku),categoria_total_sku),' +
                'updated_at=NOW()';

            const CLI_VENDAS_COLS = [
                'customer_number', 'customer_name', 'cnpj', 'city',
                'canal_cliente', 'hierarquia', 'segmentacao_cliente', 'filial', 'vendedor_id',
            ];
            const CLI_VENDAS_ON_DUP = 'customer_name=VALUES(customer_name),updated_at=NOW()';

            const VENDA_COLS = [
                'customer_number', 'customer_name', 'vendedor_id', 'vendedor_alias',
                'numero_nf', 'data_faturamento', 'mes_descricao', 'mes_numero', 'ano',
                'cod_item', 'descricao_produto', 'categoria', 'subcategoria',
                'segmento_sku', 'categoria_total_sku',
                'soma_caixas', 'soma_pallets', 'soma_litros', 'valor_nf', 'valor_vbc',
                'status_venda', 'canal_cliente', 'hierarquia', 'segmentacao_cliente', 'filial',
                'city', 'cnpj', 'fonte_arquivo', 'importacao_id',
            ];
            const VENDA_ON_DUP =
                'status_venda=VALUES(status_venda),' +
                'soma_caixas=VALUES(soma_caixas),' +
                'soma_pallets=VALUES(soma_pallets),' +
                'soma_litros=VALUES(soma_litros),' +
                'valor_nf=VALUES(valor_nf),' +
                'valor_vbc=VALUES(valor_vbc)';

            // Deduplica produtos em toda a base antes dos chunks — evita o mesmo produto
            // ser UPSERTado repetidamente em cada chunk que o contenha.
            const produtosMap = new Map<string, unknown[]>();
            for (const row of vendasRows) {
                const codItem = norm(row['COD_ITEM']);
                if (codItem && !produtosMap.has(codItem)) {
                    produtosMap.set(codItem, [
                        codItem,
                        norm(row['Descrição Produto']),
                        norm(row['CATEGORIA']),
                        norm(row['SUBCATEGORIA']),
                        norm(row['Segmento SKU']),
                        norm(row['Categoria TOTAL SKU']),
                    ]);
                }
            }

            if (produtosMap.size > 0) {
                const produtosArr = [...produtosMap.values()];
                for (let i = 0; i < produtosArr.length; i += IMPORT_CHUNK_SIZE) {
                    const prodChunk = produtosArr.slice(i, i + IMPORT_CHUNK_SIZE);
                    try {
                        await query(
                            bulkSql('produtos', PRODUTO_COLS, prodChunk.length, PRODUTO_ON_DUP),
                            prodChunk.flat(),
                        );
                    } catch (e: any) {
                        errosLog.push(`Produtos chunk ${i}: ${e.message}`);
                        console.error(`[import/produtos] Erro no chunk ${i}:`, e.message);
                    }
                }
                console.log(`[import/vendas] ${produtosMap.size} produto(s) único(s) processado(s)`);
            }

            for (let i = 0; i < vendasRows.length; i += IMPORT_CHUNK_SIZE) {
                const chunk = vendasRows.slice(i, i + IMPORT_CHUNK_SIZE);

                const cliParams: unknown[] = [];
                const vendaParams: unknown[] = [];
                let chunkVendas = 0, chunkAmostras = 0, chunkDevolucoes = 0, chunkOutros = 0;
                let skipped = 0;

                for (const row of chunk) {
                    const customerNumber = normNum(row['Customer Number']);
                    if (!customerNumber) {
                        skipped++;
                        continue;
                    }

                    const statusVenda = normStatusVenda(row['Status']);
                    const dataFat = normDate(row['Data Faturamento']);
                    const { mes, ano } = getMesAno(dataFat);
                    const mesDesc = norm(row['Mês Descrição']);
                    const vendedorId = resolveVendedorId(
                        vendedoresMap,
                        norm(row['Description 2']),
                        norm(row['Vendedor.Description']),
                        null,
                    );
                    if (!vendedorId) {
                        console.warn(`[import/vendas] Vendedor não encontrado — Description2="${row['Description 2']}" customer=${customerNumber}`);
                    }

                    const codItem = norm(row['COD_ITEM']);

                    cliParams.push(
                        customerNumber,
                        norm(row['Customer Name']),
                        norm(row['CNPJ']),
                        norm(row['City']),
                        norm(row['Canal Cliente']),
                        norm(row['Hierarquia.Description']),
                        norm(row['SEGMENTAÇÃO CLIENTE']),
                        norm(row['Filial']),
                        vendedorId,
                    );

                    vendaParams.push(
                        customerNumber,
                        norm(row['Customer Name']),
                        vendedorId,
                        norm(row['Vendedor.Description']),
                        normNum(row['Número NF']),
                        dataFat,
                        mesDesc,
                        parseMesDescricao(mesDesc) || mes,
                        ano,
                        codItem,
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
                        logId,
                    );

                    if (statusVenda === 'VENDA')               chunkVendas++;
                    else if (statusVenda === 'AMOSTRA GRATIS') chunkAmostras++;
                    else if (statusVenda === 'DEVOLUCAO')      chunkDevolucoes++;
                    else                                       chunkOutros++;
                }

                const rowCount = chunkVendas + chunkAmostras + chunkDevolucoes + chunkOutros;
                if (skipped > 0) {
                    console.warn(`[import/vendas] chunk ${i}: ${skipped} linha(s) sem Customer Number ignorada(s)`);
                }
                if (rowCount === 0) continue;

                try {
                    await withTransaction(async (client) => {
                        await client.query(
                            bulkSql('clientes', CLI_VENDAS_COLS, rowCount, CLI_VENDAS_ON_DUP),
                            cliParams,
                        );
                        await client.query(
                            bulkSql('vendas', VENDA_COLS, rowCount, VENDA_ON_DUP),
                            vendaParams,
                        );
                    });
                    contadores.vendas     += chunkVendas;
                    contadores.amostras   += chunkAmostras;
                    contadores.devolucoes += chunkDevolucoes;
                    contadores.outros     += chunkOutros;
                    console.log(`[import/vendas] chunk ${i}: ${rowCount} registro(s) (V=${chunkVendas} A=${chunkAmostras} D=${chunkDevolucoes} O=${chunkOutros})`);
                } catch (e: any) {
                    contadores.erros += rowCount;
                    errosLog.push(`Vendas chunk ${i}: ${e.message}`);
                    console.error(`[import/vendas] Erro no chunk ${i}:`, e.message);
                }
            }
        }

        // ── 1c. Base Ordens Carteira ─────────────────────────────────────────
        if (pedidosRows.length > 0) {
            const PEDIDO_COLS = [
                'customer_number', 'customer_name', 'order_number', 'order_date',
                'vendedor_id', 'vendedor_alias', 'territory_number',
                'cod_item', 'descricao_produto', 'categoria', 'subcategoria',
                'soma_litros', 'quantity_shipped', 'extended_amount', 'soma_pallets',
                'segmento_sku', 'categoria_total_sku', 'mes_descricao', 'mes_numero', 'ano',
                'hierarquia', 'canal_cliente', 'filial', 'status', 'importacao_id',
            ];
            const PEDIDO_ON_DUP = [
                'customer_name=VALUES(customer_name)',
                'order_date=VALUES(order_date)',
                'vendedor_id=VALUES(vendedor_id)',
                'vendedor_alias=VALUES(vendedor_alias)',
                'territory_number=VALUES(territory_number)',
                'descricao_produto=VALUES(descricao_produto)',
                'categoria=VALUES(categoria)',
                'subcategoria=VALUES(subcategoria)',
                'soma_litros=VALUES(soma_litros)',
                'quantity_shipped=VALUES(quantity_shipped)',
                'extended_amount=VALUES(extended_amount)',
                'soma_pallets=VALUES(soma_pallets)',
                'segmento_sku=VALUES(segmento_sku)',
                'categoria_total_sku=VALUES(categoria_total_sku)',
                'mes_descricao=VALUES(mes_descricao)',
                'mes_numero=VALUES(mes_numero)',
                'ano=VALUES(ano)',
                'hierarquia=VALUES(hierarquia)',
                'canal_cliente=VALUES(canal_cliente)',
                'filial=VALUES(filial)',
                'status=VALUES(status)',
                'importacao_id=VALUES(importacao_id)',
            ].join(',');

            for (let i = 0; i < pedidosRows.length; i += IMPORT_CHUNK_SIZE) {
                const chunk = pedidosRows.slice(i, i + IMPORT_CHUNK_SIZE);
                const params: unknown[] = [];

                for (const row of chunk) {
                    const orderDate = normDate(row['Order Date']);
                    const mesDesc = norm(col(row, 'Mês', 'Mes'));
                    const vendedorId = resolveVendedorId(
                        vendedoresMap,
                        norm(row['Description 2']),
                        norm(row['Vendedor.Description']),
                        null,
                    );
                    if (!vendedorId) {
                        console.warn(`[import/pedidos] Vendedor não encontrado — Description2="${row['Description 2']}"`);
                    }
                    // Extrai ano diretamente da string ISO para evitar dependência de fuso horário.
                    const ano = orderDate
                        ? parseInt(orderDate.substring(0, 4), 10)
                        : new Date().getUTCFullYear();
                    params.push(
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
                        ano,
                        norm(row['Hierarquia']),
                        norm(row['Canal Cliente']),
                        norm(row['Filial']),
                        norm(row['Status']),
                        logId,
                    );
                }

                try {
                    await query(bulkSql('pedidos_carteira', PEDIDO_COLS, chunk.length, PEDIDO_ON_DUP), params);
                    contadores.pedidos += chunk.length;
                    console.log(`[import/pedidos] chunk ${i}: ${chunk.length} registro(s) inserido(s)`);
                } catch (e: any) {
                    contadores.erros += chunk.length;
                    errosLog.push(`Pedidos chunk ${i}: ${e.message}`);
                    console.error(`[import/pedidos] Erro no chunk ${i}:`, e.message);
                }
            }
        }

        await finalizarLog(logId, 'concluido', contadores, errosLog);
        console.log('[import/vendas] Importação concluída:', contadores);
        return { sucesso: true, logId, contadores };

    } catch (err: any) {
        // Garante que o erro original não seja perdido mesmo se finalizarLog falhar.
        try {
            await finalizarLog(logId, 'erro', contadores, [err.message]);
        } catch (logErr: any) {
            console.error('[import] Falha ao finalizar log de erro:', logErr.message);
        }
        throw err;
    }
}

async function importarRelatorioVendas(filePath: string, usuarioId: string) {
    const logId = await criarLog(filePath, 'froneri_vendas', usuarioId);
    const resultado = await processarRelatorioVendas(filePath, usuarioId, logId);
    return { ...resultado, logId };
}

async function iniciarImportacaoRelatorioVendas(filePath: string, usuarioId: string) {
    const logId = await criarLog(filePath, 'froneri_vendas', usuarioId);
    const promise = processarRelatorioVendas(filePath, usuarioId, logId);
    return { logId, promise };
}

// ═══════════════════════════════════════════════════════════════════════════════
// HELPER: Upsert clientes a partir da Base Ruptura (base completa de cadastro)
// ═══════════════════════════════════════════════════════════════════════════════
async function importarClientesDaBase(
    rows: Record<string, unknown>[],
    vendedoresMap: VendedoresMap,
): Promise<{ clientesInseridos: number; erros: string[] }> {
    const COLS = [
        'customer_number', 'customer_name', 'cnpj', 'logradouro', 'bairro',
        'postal_code', 'city', 'region', 'filial', 'canal_cliente', 'hierarquia',
        'hierarquia_code', 'segmentacao_cliente', 'categoria_code24', 'payment_terms',
        'credit_limit', 'telefone', 'gln_number', 'additional_tax_id', 'status',
        'nova_rup', 'tem_contrato', 'qtd_conservadora', 'codigo_hierarquia',
        'descricao1', 'codigo_setor', 'territory_number', 'territory_description',
        'vendedor_id', 'ruptura_garoto',
    ];
    const ON_DUP =
        'customer_name=VALUES(customer_name),' +
        'cnpj=COALESCE(VALUES(cnpj),cnpj),' +
        'logradouro=COALESCE(VALUES(logradouro),logradouro),' +
        'bairro=COALESCE(VALUES(bairro),bairro),' +
        'postal_code=COALESCE(VALUES(postal_code),postal_code),' +
        'city=COALESCE(VALUES(city),city),' +
        'region=COALESCE(VALUES(region),region),' +
        'filial=COALESCE(VALUES(filial),filial),' +
        'canal_cliente=COALESCE(VALUES(canal_cliente),canal_cliente),' +
        'hierarquia=COALESCE(VALUES(hierarquia),hierarquia),' +
        'hierarquia_code=COALESCE(VALUES(hierarquia_code),hierarquia_code),' +
        'segmentacao_cliente=COALESCE(VALUES(segmentacao_cliente),segmentacao_cliente),' +
        'categoria_code24=COALESCE(VALUES(categoria_code24),categoria_code24),' +
        'payment_terms=COALESCE(VALUES(payment_terms),payment_terms),' +
        'credit_limit=COALESCE(VALUES(credit_limit),credit_limit),' +
        'telefone=COALESCE(VALUES(telefone),telefone),' +
        'gln_number=COALESCE(VALUES(gln_number),gln_number),' +
        'additional_tax_id=COALESCE(VALUES(additional_tax_id),additional_tax_id),' +
        'status=VALUES(status),' +
        'nova_rup=COALESCE(VALUES(nova_rup),nova_rup),' +
        'tem_contrato=VALUES(tem_contrato),' +
        'qtd_conservadora=COALESCE(VALUES(qtd_conservadora),qtd_conservadora),' +
        'codigo_hierarquia=COALESCE(VALUES(codigo_hierarquia),codigo_hierarquia),' +
        'descricao1=COALESCE(VALUES(descricao1),descricao1),' +
        'codigo_setor=COALESCE(VALUES(codigo_setor),codigo_setor),' +
        'territory_number=COALESCE(VALUES(territory_number),territory_number),' +
        'territory_description=COALESCE(VALUES(territory_description),territory_description),' +
        'vendedor_id=COALESCE(VALUES(vendedor_id),vendedor_id),' +
        'ruptura_garoto=COALESCE(VALUES(ruptura_garoto),ruptura_garoto),' +
        'updated_at=NOW()';

    let clientesInseridos = 0;
    const erros: string[] = [];

    for (let i = 0; i < rows.length; i += IMPORT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + IMPORT_CHUNK_SIZE);
        const params: unknown[] = [];
        let rowCount = 0;

        for (const row of chunk) {
            const customerNumber = normNum(row['Customer Number'] || row['Sold'] || row['SOLD']);
            if (!customerNumber) {
                console.warn(`[import/clientes] Linha sem Customer Number ignorada (chunk ${i})`);
                continue;
            }

            const description2 = norm(row['Description 2']);
            const codigoSetor  = norm(row['Código'] || row['Codigo']);
            const vendedorDesc = norm(row['Description'] || row['Vendedor']);
            const vendedorId   = resolveVendedorId(vendedoresMap, description2, vendedorDesc, codigoSetor);
            if (!vendedorId) {
                console.warn(`[import/clientes] Vendedor não encontrado — customer=${customerNumber} Description2="${description2}" Código="${codigoSetor}"`);
            }
            const paymentTerms = norm(col(row, 'Payment Terms', 'Descrição'));

            params.push(
                customerNumber,
                norm(col(row, 'Customer Name', 'Razão Social')),
                norm(row['CNPJ']),
                norm(col(row, 'Address Line 2', 'Endereço')),
                norm(col(row, 'Address Line 4', 'Bairro')),
                norm(row['Postal Code']),
                norm(col(row, 'City', 'Cidade')),
                norm(row['Região']),               // null se não informado — sem default 'Minas Gerais'
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
                vendedorDesc,
                vendedorId,
                norm(row['Ruptura Garoto']),
            );
            rowCount++;
        }

        if (rowCount === 0) continue;
        try {
            await query(bulkSql('clientes', COLS, rowCount, ON_DUP), params);
            clientesInseridos += rowCount;
            console.log(`[import/clientes] chunk ${i}: ${rowCount} cliente(s) upsertado(s)`);
        } catch (e: any) {
            erros.push(`Clientes chunk ${i}: ${e.message}`);
            console.error(`[import/clientes] Erro no chunk ${i}:`, e.message);
        }
    }

    return { clientesInseridos, erros };
}

// ─── Log helpers ─────────────────────────────────────────────────────────────
async function criarLog(filePath: string, tipoArquivo: string, usuarioId: string): Promise<string> {
    const logId = randomUUID();
    await query(`
        INSERT INTO importacoes_log (id, arquivo_nome, tipo_arquivo, status, usuario_id)
        VALUES ($1, $2, $3, 'processando', $4)
    `, [logId, path.basename(filePath), tipoArquivo, usuarioId]);
    return logId;
}

async function finalizarLog(
    logId: string,
    status: string,
    contadores: Record<string, number>,
    erros: string[],
): Promise<void> {
    const truncated = erros.length > 100;
    const logEntries = truncated
        ? [...erros.slice(0, 100), `... e mais ${erros.length - 100} erro(s) não exibido(s)`]
        : erros;
    const logText = logEntries.length > 0 ? logEntries.join('\n') : null;
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
        logId,
    ]);
}

export {
    importarRelatorioVendas,
    iniciarImportacaoRelatorioVendas,
    loadVendedoresMap,
};
