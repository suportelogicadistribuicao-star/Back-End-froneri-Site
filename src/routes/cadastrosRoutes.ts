// ─── Cadastros: solicitações de abertura de novos clientes ───────────────────
// Contrato definido pelo front (src/api/cadastros/*.ts + iCadastros.tsx):
//   GET    /api/cadastros            → lista (vendedor vê só as dele)
//   POST   /api/cadastros            → cria (multipart, fotos opcionais)
//   PUT    /api/cadastros/:id        → edição completa (admin/gerente, multipart)
//   PUT    /api/cadastros/:id/status → muda status (admin/gerente, JSON);
//                                      'concluido' cria o cliente em `clientes`
//                                      SEM SOLD — quem emite o SOLD é a Froneri,
//                                      e a importação o preenche depois
//   DELETE /api/cadastros/:id        → exclui (vendedor: só a própria, pendente/em_analise)
//   GET    /api/cadastros/:id/historico → timeline de alterações da solicitação
//                                      (vendedor: só as dele; gestão: todas)
//   GET    /api/cadastros/estatisticas → contadores por status: consolidado,
//                                      quebra por mês e quebra por vendedor.
//                                      Filtros: data_inicio, data_fim (AAAA-MM-DD,
//                                      inclusivos) e vendedor_id (só gestão —
//                                      vendedor fica preso ao próprio escopo)
//
// DOIS PAPÉIS: a solicitação pode ser aberta pelo próprio vendedor ou por um
// prospector, que escolhe no formulário o vendedor do território.
//   • `vendedor_id`   → vendedor do TERRITÓRIO. Dono do cliente criado na
//                       conclusão e chave do filtro por vendedor.
//   • `criado_por_*`  → quem ABRIU. Vira `criadores[]` nas estatísticas (o
//                       crédito da prospecção) e `criado_por_terceiro` na
//                       listagem, para a tela mostrar o nome de quem criou
//                       quando for gente diferente do vendedor vinculado.
// Quando o vendedor abre para si mesmo, os dois papéis são a mesma pessoa.
//
// COMPETÊNCIA: toda escrita que muda status/observação/dados grava um evento em
// `cadastros_historico` (ver cadastrosHistoricoService), e entrar em status
// terminal carimba `finalizado_em`. Os filtros por data usam `data_referencia`
// = COALESCE(finalizado_em, created_at): solicitação aberta em 29/10 e
// finalizada em 10/11 conta em outubro enquanto está em aberto e passa a contar
// em novembro depois de fechada — em vez de ficar presa no mês de abertura.
//
// As fotos ficam no Backblaze B2 (chaves gravadas no JSON `fotos`); a API
// devolve URLs assinadas de leitura, prontas para abrir no navegador.
import { Router } from 'express';
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { query, withTransaction } from '../config/database';
import { authMiddleware, requireRole, ownDataOnly } from '../middleware/auth';
import { uploadFotos, FOTOS_MAX_ARQUIVOS, FOTO_MAX_SIZE_MB } from '../config/multer';
import { s3Client, B2_BUCKET, getPresignedGetUrl } from '../config/b2';
import {
    ehStatusTerminal,
    diffCampos,
    normalizarValor,
    registrarEvento,
    listarHistorico,
    type Mudanca,
} from '../services/cadastrosHistoricoService';

const router = Router();

// `em_andamento`, `reanalise` e `reativacao` já existiam na base (vieram da
// carga inicial) mas estavam fora desta lista — o que os deixava de fora das
// estatísticas e fazia a soma por status não fechar com o total.
const STATUS_VALIDOS = [
    'pendente', 'em_analise', 'em_andamento', 'reanalise', 'reativacao',
    'aprovado', 'recusado', 'concluido',
];

// Colunas SUM(...) do agregado, geradas da lista acima para as duas queries
// (consolidado e por mês) nunca saírem de sincronia com ela.
const COLUNAS_STATUS = STATUS_VALIDOS
    .map((s) => `SUM(c.status = '${s}') AS ${s}`)
    .join(',\n                    ');

/** Mesma lista, do lado de fora do LEFT JOIN: vendedor sem cadastro vira 0. */
const COLUNAS_COALESCE = STATUS_VALIDOS
    .map((s) => `COALESCE(s.${s}, 0) AS ${s}`)
    .join(',\n                    ');
const CANAIS_VALIDOS = ['ATC', 'C&C', 'PQS', 'SMR', 'VAREJO'];
const VOLTAGENS_VALIDAS = ['110V', '220V'];

function validarDataFiltro(valor: unknown, nome: string): string | null {
    if (valor === undefined || valor === '') return null;
    const data = String(valor);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) {
        throw new Error(`Parâmetro ${nome} inválido. Use o formato AAAA-MM-DD.`);
    }
    const [ano, mes, dia] = data.split('-').map(Number);
    const dataValida = new Date(Date.UTC(ano, mes - 1, dia));
    if (dataValida.getUTCFullYear() !== ano || dataValida.getUTCMonth() !== mes - 1 || dataValida.getUTCDate() !== dia) {
        throw new Error(`Parâmetro ${nome} inválido. Use uma data existente.`);
    }
    return data;
}

// ─── Base de data dos filtros por período ────────────────────────────────────
// `referencia` (padrão) resolve o caso do cadastro aberto em 29/10 e finalizado
// em 10/11: enquanto está em aberto ele conta no mês de abertura; ao fechar,
// migra para o mês do fechamento. `abertura` e `conclusao` existem para quem
// precisa da visão crua — "quantas solicitações entraram" × "quantas fecharam".
// A coluna vem SEMPRE desta whitelist, nunca da string do usuário.
const COLUNAS_BASE_DATA: Record<string, string> = {
    referencia: 'c.data_referencia',
    abertura:   'c.created_at',
    conclusao:  'c.finalizado_em',
};
const COLUNA_CONCLUSAO = COLUNAS_BASE_DATA.conclusao;

function resolverBaseData(valor: unknown): string {
    const chave = String(valor ?? '').trim().toLowerCase() || 'referencia';
    const coluna = COLUNAS_BASE_DATA[chave];
    if (!coluna) {
        throw new Error(`Parâmetro base_data inválido. Use: ${Object.keys(COLUNAS_BASE_DATA).join(', ')}.`);
    }
    return coluna;
}

function montarFiltroData(
    inicio: string | null,
    fim: string | null,
    coluna: string,
    parametros: unknown[],
): string {
    const filtros: string[] = [];
    // Na visão por conclusão, quem ainda não fechou está fora do recorte por
    // definição — e sem este corte MONTH(NULL) viraria um grupo fantasma no
    // `por_mes` das estatísticas.
    if (coluna === COLUNA_CONCLUSAO) filtros.push(`${coluna} IS NOT NULL`);
    if (inicio) {
        parametros.push(inicio);
        filtros.push(`${coluna} >= $${parametros.length}`);
    }
    if (fim) {
        parametros.push(fim);
        filtros.push(`${coluna} < DATE_ADD($${parametros.length}, INTERVAL 1 DAY)`);
    }
    return filtros.length ? ` AND ${filtros.join(' AND ')}` : '';
}

// Campos de texto obrigatórios do formulário (iguais no POST e no PUT de edição).
const CAMPOS_OBRIGATORIOS = [
    'cnpj', 'razao_social', 'canal_cliente', 'segmento', 'cidade', 'email',
    'telefone', 'dia_atendimento', 'prospector', 'vendedor_territorio',
    'modelo_freezer', 'horario_recebimento_freezer',
];

// ─── Resolução do vendedor da solicitação ────────────────────────────────────
// Concluir cria um cliente definitivo, e cliente sem vendedor nasce órfão:
// invisível para o próprio vendedor (todas as telas filtram por vendedor_id) e
// sem territory_number. Solicitação aberta por admin/gerente não tem
// vendedor_id — vem só o nome escolhido em "Vendedor - Território".
const CONECTIVOS_NOME = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function tokensDoNome(valor: unknown): string[] {
    return String(valor ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t && !CONECTIVOS_NOME.has(t));
}

// Duas grafias do MESMO nome? Um lado pode ser subconjunto do outro
// ("Nicolas Passafaro" ⊂ "Nicolas De Souza Passafaro"), então basta o menor
// estar contido no maior. Usado para decidir se quem abriu é gente diferente
// do vendedor vinculado, quando não há id dos dois lados para comparar.
function mesmoNome(a: unknown, b: unknown): boolean {
    const setA = new Set(tokensDoNome(a));
    const setB = new Set(tokensDoNome(b));
    if (!setA.size || !setB.size) return false;
    const [menor, maior] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
    return [...menor].every((t) => maior.has(t));
}

// A lista fixa do formulário não bate 1:1 com `vendedores.nome` ("Nicolas De
// Souza Passafaro" no form × "Nicolas Passafaro" no cadastro). Comparar por
// tokens — sem acento, caixa ou conectivo — cobre a diferença; exigir match
// ÚNICO evita escolher o vendedor errado entre sobrenomes repetidos
// (ex.: "Alexandre Passafaro" também existe).
async function vendedorPorNome(nome: unknown): Promise<string | null> {
    const alvo = new Set(tokensDoNome(nome));
    if (alvo.size === 0) return null;

    const res = await query('SELECT id, nome FROM vendedores WHERE ativo = TRUE');
    const candidatos = res.rows.filter((v: any) => {
        const tokens = tokensDoNome(v.nome);
        return tokens.length > 0 && tokens.every((t) => alvo.has(t));
    });
    return candidatos.length === 1 ? candidatos[0].id : null;
}

// Ordem: vendedor informado pela gestão no corpo do PUT → nome do "Vendedor -
// Território" do formulário → vínculo da própria solicitação. Sem nenhum deles
// a conclusão é recusada, em vez de gravar um cliente órfão.
//
// O TERRITÓRIO vem antes do vínculo de propósito. O cliente pertence a quem vai
// ATENDER, não a quem prospectou — e, para as solicitações abertas antes desta
// regra existir, `vendedor_id` guarda justamente quem abriu. Resolver o
// território pelo nome a cada conclusão conserta essas linhas antigas sem
// precisar migrar dado nenhum.
async function resolverVendedor(existente: any, body: any): Promise<{ id?: string; erro?: string }> {
    const informado = body?.vendedor_id ?? body?.codigo_vendedor;
    if (informado !== undefined && informado !== null && String(informado).trim() !== '') {
        const chave = String(informado).trim();
        // Coluna vem de whitelist — nunca da entrada do usuário.
        const coluna = /^\d+$/.test(chave) ? 'codigo_vendedor' : 'id';
        const res = await query(`SELECT id FROM vendedores WHERE ${coluna} = $1 LIMIT 1`, [chave]);
        if (!res.rows[0]) return { erro: `Vendedor não encontrado: ${chave}.` };
        return { id: res.rows[0].id };
    }

    const porNome = await vendedorPorNome(existente.vendedor_territorio);
    if (porNome) return { id: porNome };

    // Último recurso: o vínculo já gravado na solicitação. Em linha antiga isso
    // é quem abriu — melhor um cliente na carteira do prospector do que um
    // cliente órfão, invisível para todo mundo.
    if (existente.vendedor_id) return { id: existente.vendedor_id };

    const territorio = existente.vendedor_territorio ? ` ("${existente.vendedor_territorio}")` : '';
    return {
        erro: `Solicitação sem vendedor vinculado, e o nome em "Vendedor - Território"${territorio}`
            + ' não identifica um único vendedor ativo. Informe vendedor_id ou codigo_vendedor'
            + ' no corpo da requisição para concluir.',
    };
}

function validarCampos(body: Record<string, any>): { erro?: string; dados?: Record<string, any> } {
    const dados: Record<string, any> = {};

    for (const campo of CAMPOS_OBRIGATORIOS) {
        const valor = typeof body[campo] === 'string' ? body[campo].trim() : body[campo];
        if (valor === undefined || valor === null || valor === '') {
            return { erro: `Campo obrigatório não informado: ${campo}.` };
        }
        dados[campo] = String(valor);
    }

    if (body.cadastro_froneri_wmc === undefined || body.cadastro_froneri_wmc === null || body.cadastro_froneri_wmc === '') {
        return { erro: 'Campo obrigatório não informado: cadastro_froneri_wmc.' };
    }
    dados.cadastro_froneri_wmc = ['true', '1', 'sim', 's'].includes(String(body.cadastro_froneri_wmc).toLowerCase()) ? 1 : 0;

    if (dados.cnpj.replace(/\D/g, '').length !== 14) {
        return { erro: 'CNPJ inválido: informe os 14 dígitos.' };
    }
    if (!CANAIS_VALIDOS.includes(dados.canal_cliente)) {
        return { erro: `Canal do cliente inválido. Use: ${CANAIS_VALIDOS.join(', ')}.` };
    }

    const voltagem = typeof body.voltagem_freezer === 'string' ? body.voltagem_freezer.trim().toUpperCase() : '';
    if (voltagem && !VOLTAGENS_VALIDAS.includes(voltagem)) {
        return { erro: 'Voltagem do freezer inválida. Use 110V ou 220V.' };
    }
    dados.voltagem_freezer = voltagem || null;

    return { dados };
}

// mysql2 pode devolver a coluna JSON já parseada (array) ou como string.
function chavesDasFotos(valor: any): string[] {
    if (Array.isArray(valor)) return valor.filter((v) => typeof v === 'string');
    if (typeof valor === 'string' && valor.trim()) {
        try {
            const parsed = JSON.parse(valor);
            return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
        } catch {
            return [];
        }
    }
    return [];
}

function limparTemporarios(files: Express.Multer.File[]): void {
    for (const file of files) {
        fs.unlink(file.path, () => {});
    }
}

async function apagarFotosDoB2(chaves: string[]): Promise<void> {
    await Promise.all(chaves.map((chave) =>
        s3Client.send(new DeleteObjectCommand({ Bucket: B2_BUCKET, Key: chave }))
            .catch((err) => console.error('[cadastros] Falha ao remover foto do B2:', chave, err.message))
    ));
}

async function subirFotosParaB2(files: Express.Multer.File[], cadastroId: string): Promise<string[]> {
    const chaves: string[] = [];
    try {
        for (const file of files) {
            const chave = `cadastros/${cadastroId}/${file.filename}`;
            await s3Client.send(new PutObjectCommand({
                Bucket: B2_BUCKET,
                Key: chave,
                Body: fs.createReadStream(file.path),
                ContentType: file.mimetype,
                ContentLength: file.size,
            }));
            chaves.push(chave);
        }
        return chaves;
    } catch (err) {
        await apagarFotosDoB2(chaves);
        throw err;
    }
}

function paraIso(valor: any): string | null {
    if (valor instanceof Date) return valor.toISOString();
    return valor ?? null;
}

// Quem abriu é gente diferente do vendedor vinculado? A comparação é feita aqui,
// e não no front, para a tela não ter que reimplementar o casamento de nomes.
// Prefere id (exato); só cai no nome quando quem abriu não tem vínculo em
// `vendedores` — caso de solicitação aberta por admin/gerente. Na dúvida
// devolve false: alarme falso na tela é pior que a informação ausente.
function criadoPorTerceiro(row: any): boolean {
    const criadorId = row.criado_por_id ?? null;
    const vendedorId = row.vendedor_id ?? null;
    if (criadorId && vendedorId) return String(criadorId) !== String(vendedorId);

    const criadorNome = row.criado_por_nome ?? row.vendedor_nome ?? null;
    const vendedorNome = row.vendedor_nome_atual ?? row.vendedor_territorio ?? null;
    if (!criadorNome || !vendedorNome) return false;
    return !mesmoNome(criadorNome, vendedorNome);
}

// Linha do banco (com JOIN em vendedores) → objeto no formato que o front espera.
async function montarCadastro(row: any): Promise<Record<string, any>> {
    const chaves = chavesDasFotos(row.fotos);
    const fotos = await Promise.all(chaves.map((chave) => getPresignedGetUrl(chave)));
    return {
        id: row.id,
        cadastro_froneri_wmc: ['1', 'true', 'sim', 's'].includes(String(row.cadastro_froneri_wmc).toLowerCase()),
        cnpj: row.cnpj,
        razao_social: row.razao_social,
        canal_cliente: row.canal_cliente ?? null,
        segmento: row.segmento ?? null,
        cidade: row.cidade ?? null,
        email: row.email ?? null,
        telefone: row.telefone ?? null,
        dia_atendimento: row.dia_atendimento ?? null,
        prospector: row.prospector ?? null,
        vendedor_territorio: row.vendedor_territorio ?? null,
        modelo_freezer: row.modelo_freezer ?? null,
        voltagem_freezer: row.voltagem_freezer ?? null,
        horario_recebimento_freezer: row.horario_recebimento_freezer ?? null,
        fotos,
        status: row.status,
        observacao: row.observacao ?? null,
        // SOLD só existe depois que a planilha da Froneri traz o número — até lá
        // a solicitação está concluída com cliente_id preenchido e sold nulo.
        cliente_id: row.cliente_id ?? null,
        customer_number: row.customer_number ?? null,
        codigo_vendedor: row.codigo_vendedor != null ? String(row.codigo_vendedor) : null,
        // Vendedor do TERRITÓRIO — quem vai atender. O JOIN traz o nome atual;
        // sem vínculo, vale o nome escolhido no formulário. `vendedor_nome` é o
        // último recurso e, em linha antiga, guarda quem abriu.
        vendedor_id: row.vendedor_id ?? null,
        vendedor_nome: row.vendedor_nome_atual ?? row.vendedor_territorio ?? row.vendedor_nome ?? null,
        // Quem ABRIU (o prospector). `criado_por_terceiro` entrega a comparação
        // pronta: o front só precisa mostrar o nome de quem criou quando for
        // gente diferente do vendedor vinculado.
        criado_por_id: row.criado_por_id ?? null,
        criado_por_nome: row.criado_por_nome ?? row.vendedor_nome ?? null,
        criado_por_terceiro: criadoPorTerceiro(row),
        criado_em: paraIso(row.created_at),
        atualizado_em: paraIso(row.updated_at),
        // NULL enquanto a solicitação está em andamento.
        finalizado_em: paraIso(row.finalizado_em),
        // Mês em que a solicitação conta nos relatórios (coluna gerada no banco).
        data_referencia: paraIso(row.data_referencia),
    };
}

// O JOIN é no vendedor do TERRITÓRIO e traz o nome ATUAL dele — o formulário
// guarda o nome escolhido na abertura, que envelhece se a pessoa for renomeada.
// Quem abriu não precisa de JOIN: `criado_por_nome` já é o snapshot do momento.
const SELECT_CADASTRO = `
    SELECT c.*, v.codigo_vendedor, v.nome AS vendedor_nome_atual
    FROM cadastros c
    LEFT JOIN vendedores v ON v.id = c.vendedor_id
`;

async function buscarCadastro(id: string): Promise<any | null> {
    const res = await query(`${SELECT_CADASTRO} WHERE c.id = $1 LIMIT 1`, [id]);
    return res.rows[0] || null;
}

// Traduz erros do multer (tamanho/quantidade/tipo) para 400 com mensagem legível,
// em vez de deixá-los cair no handler global como 500.
function uploadFotosMiddleware(req, res, next) {
    uploadFotos.array('fotos', FOTOS_MAX_ARQUIVOS)(req, res, (err) => {
        if (!err) return next();
        let mensagem = err.message || 'Falha no upload das fotos.';
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                mensagem = `Cada arquivo deve ter no máximo ${FOTO_MAX_SIZE_MB} MB.`;
            } else if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
                mensagem = `Envie no máximo ${FOTOS_MAX_ARQUIVOS} arquivos.`;
            }
        }
        return res.status(400).json({ erro: mensagem });
    });
}

// ── GET /api/cadastros/estatisticas ─────────────────────────────────────────
// Gestão recebe o consolidado e uma linha por vendedor. Vendedor recebe o
// mesmo contrato, mas apenas a própria linha, aplicado pelo JWT.
// Filtros: data_inicio e data_fim no formato AAAA-MM-DD, inclusivos.
router.get('/estatisticas', authMiddleware, ownDataOnly, async (req, res) => {
    let dataInicio: string | null;
    let dataFim: string | null;
    let colunaData: string;
    try {
        dataInicio = validarDataFiltro(req.query.data_inicio, 'data_inicio');
        dataFim = validarDataFiltro(req.query.data_fim, 'data_fim');
        colunaData = resolverBaseData(req.query.base_data);
        if (dataInicio && dataFim && dataInicio > dataFim) {
            return res.status(400).json({ erro: 'data_inicio não pode ser maior que data_fim.' });
        }
    } catch (err: any) {
        return res.status(400).json({ erro: err.message });
    }

    try {
        const filtroVendedor = req.filtroVendedor;

        // Dois escopos diferentes, de propósito:
        //   filtroTotais     → `por_status` e `por_mes`. Vendedor: preso ao JWT.
        //                      Gestão: pode escolher um vendedor pelo query param
        //                      `vendedor_id` (o uuid devolvido em `vendedores[]`).
        //   filtroVendedor   → `vendedores[]`. Só o do JWT. Se o `vendedor_id`
        //                      escolhido também cortasse esta lista, o seletor do
        //                      front ficaria com uma opção só e não teria como
        //                      voltar para outro vendedor.
        // Vendedor logado nunca escapa do próprio escopo: `ownDataOnly` já
        // preencheu req.filtroVendedor, e ele vence o query param.
        const vendedorEscolhido = String(req.query.vendedor_id ?? '').trim();
        const filtroTotais = filtroVendedor || vendedorEscolhido || null;

        const totaisParams: unknown[] = [];
        let totaisWhere = 'WHERE 1 = 1';
        if (filtroTotais) {
            totaisParams.push(filtroTotais);
            totaisWhere += ` AND c.vendedor_id = $${totaisParams.length}`;
        }
        totaisWhere += montarFiltroData(dataInicio, dataFim, colunaData, totaisParams);

        const vendedoresParams: unknown[] = [];
        let vendedoresWhere = 'WHERE 1 = 1';
        if (filtroVendedor) {
            vendedoresParams.push(filtroVendedor);
            vendedoresWhere += ` AND c.vendedor_id = $${vendedoresParams.length}`;
        }
        vendedoresWhere += montarFiltroData(dataInicio, dataFim, colunaData, vendedoresParams);

        // normalizeSql() troca todo $n por ? na ordem do texto, então este
        // filtro — que fica DEPOIS da subquery — precisa do próprio parâmetro.
        // Reaproveitar o $1 do WHERE interno deixava um ? sem valor e o MySQL
        // rejeitava a query inteira (todo request de vendedor virava 500).
        let vendedoresFiltroId = '';
        if (filtroVendedor) {
            vendedoresParams.push(filtroVendedor);
            vendedoresFiltroId = ` AND v.id = $${vendedoresParams.length}`;
        }

        const [totaisRes, mesesRes, criadoresRes, vendedoresRes] = await Promise.all([
            query(`
                SELECT
                    COUNT(*) AS total,
                    ${COLUNAS_STATUS}
                FROM cadastros c
                ${totaisWhere}
            `, totaisParams),
            // Mesma janela e mesmo escopo do consolidado — só quebrado por mês.
            // Reaproveita totaisWhere/totaisParams de propósito: normalizeSql()
            // troca $n por ? na ordem do TEXTO, então repetir o mesmo WHERE com
            // o mesmo array mantém os placeholders alinhados.
            // Devolve só os meses com solicitação; o front completa o ano.
            // O mês sai da MESMA base de data do recorte (`base_data`), senão a
            // quebra mensal contradiria o total: solicitação finalizada em
            // novembro apareceria em outubro dentro de uma janela de novembro.
            query(`
                SELECT
                    MONTH(${colunaData}) AS mes,
                    COUNT(*) AS total,
                    ${COLUNAS_STATUS}
                FROM cadastros c
                ${totaisWhere}
                GROUP BY MONTH(${colunaData})
                ORDER BY mes
            `, totaisParams),
            // Contabilização por QUEM ABRIU. `vendedores[]`, logo abaixo, conta
            // por território (a carteira); esta conta o crédito da prospecção —
            // cadastro aberto pelo próprio vendedor conta para ele, aberto por
            // um prospector conta para o prospector.
            //
            // Combinada com o filtro `vendedor_id` (que é território), responde
            // exatamente "quem abriu cadastros para este vendedor".
            //
            // Sem JOIN em `vendedores`: `criado_por_nome` é o nome no momento da
            // abertura, e quem abriu pode não ter vínculo em vendedores (gestão).
            // O COALESCE cobre as linhas anteriores à separação dos dois papéis,
            // em que o nome de quem abriu ficava em `vendedor_nome`.
            query(`
                SELECT
                    c.criado_por_id,
                    COALESCE(c.criado_por_nome, c.vendedor_nome) AS criado_por_nome,
                    COUNT(*) AS total,
                    ${COLUNAS_STATUS}
                FROM cadastros c
                ${totaisWhere}
                GROUP BY c.criado_por_id, COALESCE(c.criado_por_nome, c.vendedor_nome)
                ORDER BY criado_por_nome
            `, totaisParams),
            query(`
                SELECT
                    v.id AS vendedor_id,
                    v.codigo_vendedor,
                    v.nome AS vendedor_nome,
                    COALESCE(s.total, 0) AS total,
                    ${COLUNAS_COALESCE}
                FROM vendedores v
                LEFT JOIN (
                    SELECT
                        c.vendedor_id,
                        COUNT(*) AS total,
                        ${COLUNAS_STATUS}
                    FROM cadastros c
                    ${vendedoresWhere}
                    GROUP BY c.vendedor_id
                ) s ON s.vendedor_id = v.id
                WHERE v.ativo = TRUE
                ${vendedoresFiltroId}
                ORDER BY v.nome
            `, vendedoresParams),
        ]);

        const camposStatus = ['total', ...STATUS_VALIDOS];
        const normalizar = (linha: any): Record<string, number> =>
            Object.fromEntries(camposStatus.map((campo) => [campo, Number(linha?.[campo] ?? 0)]));

        res.json({
            periodo: {
                data_inicio: dataInicio,
                data_fim: dataFim,
                // Ecoa a base usada para o front rotular o gráfico ("por
                // competência" × "por abertura") sem ter que adivinhar.
                base_data: Object.keys(COLUNAS_BASE_DATA).find((k) => COLUNAS_BASE_DATA[k] === colunaData),
            },
            vendedor_id: filtroTotais,
            por_status: normalizar(totaisRes.rows[0]),
            por_mes: mesesRes.rows.map((linha: any) => ({
                mes: Number(linha.mes),
                ...normalizar(linha),
            })),
            // Crédito da prospecção: quem abriu cada solicitação.
            criadores: criadoresRes.rows.map((linha: any) => ({
                criado_por_id: linha.criado_por_id ?? null,
                criado_por_nome: linha.criado_por_nome ?? null,
                ...normalizar(linha),
            })),
            // Carteira: por vendedor do território.
            vendedores: vendedoresRes.rows.map((linha: any) => ({
                vendedor_id: linha.vendedor_id,
                codigo_vendedor: linha.codigo_vendedor != null ? String(linha.codigo_vendedor) : null,
                vendedor_nome: linha.vendedor_nome,
                ...normalizar(linha),
            })),
        });
    } catch (err) {
        console.error('[cadastros/estatisticas]', err);
        res.status(500).json({ erro: 'Erro ao carregar estatísticas de cadastros.' });
    }
});

// ── GET /api/cadastros ───────────────────────────────────────────────────────
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    let dataInicio: string | null;
    let dataFim: string | null;
    let colunaData: string;
    try {
        dataInicio = validarDataFiltro(req.query.data_inicio, 'data_inicio');
        dataFim = validarDataFiltro(req.query.data_fim, 'data_fim');
        colunaData = resolverBaseData(req.query.base_data);
        if (dataInicio && dataFim && dataInicio > dataFim) {
            return res.status(400).json({ erro: 'data_inicio não pode ser maior que data_fim.' });
        }
    } catch (err: any) {
        return res.status(400).json({ erro: err.message });
    }

    try {
        const { status, vendedor_id, page = 1, limit = 1000 } = req.query;

        const where: string[] = [];
        const params: any[] = [];
        let p = 1;

        if (req.filtroVendedor) {
            where.push(`c.vendedor_id = $${p++}`);
            params.push(req.filtroVendedor);
        } else if (vendedor_id !== undefined && vendedor_id !== '') {
            // Aceita tanto o uuid de vendedores.id quanto o codigo_vendedor numérico.
            if (/^\d+$/.test(String(vendedor_id))) {
                where.push(`v.codigo_vendedor = $${p++}`);
                params.push(Number(vendedor_id));
            } else {
                where.push(`c.vendedor_id = $${p++}`);
                params.push(String(vendedor_id));
            }
        }
        if (status) {
            if (!STATUS_VALIDOS.includes(String(status))) {
                return res.status(400).json({ erro: `Status inválido. Use: ${STATUS_VALIDOS.join(', ')}.` });
            }
            where.push(`c.status = $${p++}`);
            params.push(String(status));
        }

        // Filtro por período. Vai depois dos demais porque montarFiltroData numera
        // os placeholders a partir de params.length — e normalizeSql() troca $n por
        // ? na ordem do TEXTO, então a ordem de montagem tem que bater com a do SQL.
        const filtroData = montarFiltroData(dataInicio, dataFim, colunaData, params);
        p = params.length + 1;

        const wStr = (where.length ? 'WHERE ' + where.join(' AND ') : 'WHERE 1 = 1') + filtroData;
        // O front hoje chama sem parâmetros e pagina localmente — o padrão alto
        // garante que a lista venha inteira.
        const pageNum  = Math.max(Number(page) || 1, 1);
        const limitNum = Math.min(Math.max(Number(limit) || 1000, 1), 2000);
        const offset   = (pageNum - 1) * limitNum;

        const rows = await query(`
            ${SELECT_CADASTRO}
            ${wStr}
            ORDER BY c.created_at DESC
            LIMIT $${p++} OFFSET $${p++}
        `, [...params, limitNum, offset]);

        res.json(await Promise.all(rows.rows.map(montarCadastro)));
    } catch (err) {
        console.error('[cadastros/get]', err);
        res.status(500).json({ erro: 'Erro ao listar solicitações de cadastro.' });
    }
});

// ── POST /api/cadastros ──────────────────────────────────────────────────────
router.post('/', authMiddleware, ownDataOnly, uploadFotosMiddleware, async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    try {
        const { erro, dados } = validarCampos(req.body || {});
        if (erro) return res.status(400).json({ erro });

        // ── Os dois papéis ───────────────────────────────────────────────────
        // `vendedor_id` é o vendedor do TERRITÓRIO — quem vai ATENDER o cliente
        // e por quem a solicitação aparece no filtro. Quem abriu (o prospector)
        // vai para `criado_por_*`. Quando o próprio vendedor abre para si, o
        // território que ele escolhe é ele mesmo e os dois coincidem.
        const territorioId = await vendedorPorNome(dados.vendedor_territorio);
        if (!territorioId) {
            // Cair no vendedor de quem abriu é o mal menor: sem vínculo nenhum a
            // solicitação ficaria invisível em toda tela que filtra por vendedor.
            // O log deixa o caso rastreável — normalmente é nome fora de `vendedores`.
            console.warn(
                '[cadastros/post] Território não resolvido:',
                dados.vendedor_territorio,
                '— vinculando ao vendedor de quem abriu.'
            );
        }
        const vendedorId = territorioId || req.usuario?.vendedor_id || null;

        const id = randomUUID();
        const chaves = files.length ? await subirFotosParaB2(files, id) : [];

        try {
            // Transação para a solicitação e o primeiro evento da timeline
            // nascerem juntos: cadastro sem evento de criação abriria com
            // histórico furado logo de saída.
            await withTransaction(async (client) => {
                await client.query(`
                    INSERT INTO cadastros (
                        id, cadastro_froneri_wmc, cnpj, razao_social, canal_cliente, segmento,
                        cidade, email, telefone, dia_atendimento, prospector, vendedor_territorio,
                        modelo_freezer, voltagem_freezer, horario_recebimento_freezer, fotos,
                        status, vendedor_id, criado_por_id, criado_por_nome
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
                `, [
                    id, dados.cadastro_froneri_wmc, dados.cnpj, dados.razao_social, dados.canal_cliente, dados.segmento,
                    dados.cidade, dados.email, dados.telefone, dados.dia_atendimento, dados.prospector, dados.vendedor_territorio,
                    dados.modelo_freezer, dados.voltagem_freezer, dados.horario_recebimento_freezer, JSON.stringify(chaves),
                    'pendente', vendedorId,
                    req.usuario?.vendedor_id || null,
                    req.usuario?.nome ? String(req.usuario.nome) : null,
                ]);

                await registrarEvento(client, {
                    cadastroId: id,
                    tipo: 'criacao',
                    autor: req.usuario,
                });
            });
        } catch (err) {
            await apagarFotosDoB2(chaves);
            throw err;
        }

        const row = await buscarCadastro(id);
        res.status(201).json(await montarCadastro(row));
    } catch (err) {
        console.error('[cadastros/post]', err);
        res.status(500).json({ erro: 'Erro ao criar solicitação de cadastro.' });
    } finally {
        limparTemporarios(files);
    }
});

// ── PUT /api/cadastros/:id (edição completa — só gestão) ────────────────────
router.put('/:id', authMiddleware, requireRole('admin', 'gerente'), uploadFotosMiddleware, async (req, res) => {
    const files = (req.files as Express.Multer.File[]) || [];
    try {
        const existente = await buscarCadastro(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Solicitação de cadastro não encontrada.' });

        const { erro, dados } = validarCampos(req.body || {});
        if (erro) return res.status(400).json({ erro });

        // Política de fotos: novas são ADICIONADAS às existentes; sem arquivos
        // no body, as fotos já salvas ficam como estão.
        const chavesAtuais = chavesDasFotos(existente.fotos);
        if (chavesAtuais.length + files.length > FOTOS_MAX_ARQUIVOS) {
            return res.status(400).json({
                erro: `A solicitação já tem ${chavesAtuais.length} arquivo(s); o máximo é ${FOTOS_MAX_ARQUIVOS}. Exclua e recrie para trocar as fotos.`,
            });
        }
        const chavesNovas = files.length ? await subirFotosParaB2(files, existente.id) : [];
        const chaves = [...chavesAtuais, ...chavesNovas];

        // Diff ANTES do UPDATE — depois dele o estado anterior já não existe.
        // Só o que realmente mudou entra na timeline: salvar o formulário sem
        // alterar nada não pode gerar um card vazio.
        const mudancas: Mudanca[] = diffCampos(existente, dados);
        if (chaves.length !== chavesAtuais.length) {
            mudancas.push({
                campo: 'fotos',
                de: String(chavesAtuais.length),
                para: String(chaves.length),
            });
        }

        try {
            await withTransaction(async (client) => {
                // status e observacao ficam de fora de propósito — são da rota /status.
                await client.query(`
                    UPDATE cadastros SET
                        cadastro_froneri_wmc = $1, cnpj = $2, razao_social = $3, canal_cliente = $4,
                        segmento = $5, cidade = $6, email = $7, telefone = $8, dia_atendimento = $9,
                        prospector = $10, vendedor_territorio = $11, modelo_freezer = $12,
                        voltagem_freezer = $13, horario_recebimento_freezer = $14, fotos = $15
                    WHERE id = $16
                `, [
                    dados.cadastro_froneri_wmc, dados.cnpj, dados.razao_social, dados.canal_cliente,
                    dados.segmento, dados.cidade, dados.email, dados.telefone, dados.dia_atendimento,
                    dados.prospector, dados.vendedor_territorio, dados.modelo_freezer,
                    dados.voltagem_freezer, dados.horario_recebimento_freezer, JSON.stringify(chaves),
                    existente.id,
                ]);

                if (mudancas.length) {
                    await registrarEvento(client, {
                        cadastroId: existente.id,
                        tipo: 'edicao',
                        autor: req.usuario,
                        mudancas,
                    });
                }
            });
        } catch (err) {
            await apagarFotosDoB2(chavesNovas);
            throw err;
        }

        const row = await buscarCadastro(existente.id);
        res.json(await montarCadastro(row));
    } catch (err) {
        console.error('[cadastros/put]', err);
        res.status(500).json({ erro: 'Erro ao atualizar solicitação de cadastro.' });
    } finally {
        limparTemporarios(files);
    }
});

// ── PUT /api/cadastros/:id/status (só gestão) ────────────────────────────────
router.put('/:id/status', authMiddleware, requireRole('admin', 'gerente'), async (req, res) => {
    try {
        const { status, observacao } = req.body || {};
        if (!status || !STATUS_VALIDOS.includes(String(status))) {
            return res.status(400).json({ erro: `Status inválido. Use: ${STATUS_VALIDOS.join(', ')}.` });
        }

        const existente = await buscarCadastro(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Solicitação de cadastro não encontrada.' });

        const novoStatus = String(status);

        // O front só manda observacao quando preenchida — ausente mantém a atual.
        const novaObservacao = observacao !== undefined
            ? (String(observacao).trim() || null)
            : existente.observacao;

        // ── Competência ──────────────────────────────────────────────────────
        // `finalizado_em` é carimbado na entrada em status terminal e limpo na
        // volta para "em andamento". Terminal → terminal (ex.: aprovado em
        // outubro, concluído em novembro) NÃO recarimba: quem encerrou o
        // trabalho foi a primeira decisão, e mês fechado não pode mudar sozinho
        // quando alguém mexe num registro antigo.
        const eraTerminal = ehStatusTerminal(existente.status);
        const viraTerminal = ehStatusTerminal(novoStatus);
        const carimbarFinal = !eraTerminal && viraTerminal;
        const limparFinal = eraTerminal && !viraTerminal;

        // Conclusão tem efeito colateral crítico: cria o cliente definitivo
        // vinculado ao vendedor da solicitação. cliente_id já preenchido =
        // cliente criado numa conclusão anterior, não duplica.
        const concluir = novoStatus === 'concluido' && !existente.cliente_id;

        // Resolvido FORA da transação, de propósito: é leitura, e um vendedor
        // indefinido tem que virar 400 antes de qualquer escrita.
        let vendedorId: string | null = null;
        if (concluir) {
            const vendedor = await resolverVendedor(existente, req.body || {});
            if (vendedor.erro) return res.status(400).json({ erro: vendedor.erro });
            vendedorId = vendedor.id as string;
        }

        const clienteId = concluir ? randomUUID() : null;

        await withTransaction(async (client) => {
            if (concluir) {
                // Sem customer_number: o SOLD é emitido pela Froneri e chega pela
                // planilha. Até lá o cliente vive só em `clientes`, identificado pelo
                // uuid. Nada de ruptura/snapshot mensal aqui — as duas tabelas são
                // chaveadas por customer_number, e a importação as preenche sozinha
                // assim que o SOLD chega (ver adotarClientesSemSold no importService).
                //
                // CNPJ vai só com dígitos, no mesmo formato que a importação grava —
                // é por ele que o cliente pendente é casado com a linha da planilha.
                const cnpjDigitos = String(existente.cnpj ?? '').replace(/\D/g, '') || null;

                const vRes = await client.query(
                    'SELECT territory_number FROM vendedores WHERE id = $1',
                    [vendedorId]
                );
                const territoryNumber = vRes.rows[0]?.territory_number ?? null;

                await client.query(`
                    INSERT INTO clientes (
                        id, customer_name, cnpj, city, canal_cliente,
                        telefone, status, nova_rup, vendedor_id, territory_number, observacao
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                `, [
                    clienteId, existente.razao_social, cnpjDigitos,
                    existente.cidade, existente.canal_cliente, existente.telefone,
                    'C', 'Cliente Novo', vendedorId, territoryNumber,
                    `Criado a partir da solicitação de cadastro ${existente.id}`,
                ]);
            }

            // SET montado dinamicamente. normalizeSql() troca $n por ? na ordem
            // do TEXTO, então cada fragmento é empurrado para `params` na mesma
            // ordem em que entra no SQL — NOW()/NULL não consomem parâmetro.
            const sets = ['status = $1', 'observacao = $2'];
            const params: any[] = [novoStatus, novaObservacao];
            if (carimbarFinal) sets.push('finalizado_em = NOW()');
            else if (limparFinal) sets.push('finalizado_em = NULL');
            if (concluir) {
                params.push(clienteId);
                sets.push(`cliente_id = $${params.length}`);
                params.push(vendedorId);
                sets.push(`vendedor_id = $${params.length}`);
            }
            params.push(existente.id);

            await client.query(
                `UPDATE cadastros SET ${sets.join(', ')} WHERE id = $${params.length}`,
                params
            );

            // ── Timeline ─────────────────────────────────────────────────────
            // finalizado_em é relido do banco (e não montado em JS) para o valor
            // gravado no histórico ser exatamente o NOW() do servidor MySQL —
            // sem risco de fuso do processo Node divergir do fuso do banco.
            const apos = await client.query(
                'SELECT finalizado_em FROM cadastros WHERE id = $1',
                [existente.id]
            );

            const mudancas: Mudanca[] = [];
            const registrar = (campo: string, de: unknown, para: unknown) => {
                const antes = normalizarValor(campo, de);
                const depois = normalizarValor(campo, para);
                if (antes !== depois) mudancas.push({ campo, de: antes, para: depois });
            };

            registrar('status', existente.status, novoStatus);
            registrar('observacao', existente.observacao, novaObservacao);
            registrar('finalizado_em', existente.finalizado_em, apos.rows[0]?.finalizado_em);
            if (concluir) registrar('cliente_id', null, clienteId);

            if (mudancas.length) {
                await registrarEvento(client, {
                    cadastroId: existente.id,
                    tipo: concluir ? 'conclusao' : 'status',
                    autor: req.usuario,
                    mudancas,
                });
            }
        });

        const row = await buscarCadastro(existente.id);
        res.json(await montarCadastro(row));
    } catch (err) {
        console.error('[cadastros/status]', err);
        res.status(500).json({ erro: 'Erro ao atualizar status da solicitação.' });
    }
});

// ── GET /api/cadastros/:id/historico ─────────────────────────────────────────
// Timeline de alterações da solicitação, do evento mais recente para o mais
// antigo. Vendedor enxerga as próprias — é o caso de uso principal: acompanhar
// o cadastro que ele abriu conforme a gestão mexe. Gestão e supervisor veem
// todas, pelo mesmo ownDataOnly que já governa a listagem.
router.get('/:id/historico', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const existente = await buscarCadastro(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Solicitação de cadastro não encontrada.' });

        // 404 (e não 403) para solicitação de outro vendedor: um 403 confirmaria
        // que aquele id existe. Fora do escopo, ela simplesmente não existe.
        if (req.filtroVendedor && String(existente.vendedor_id) !== String(req.filtroVendedor)) {
            return res.status(404).json({ erro: 'Solicitação de cadastro não encontrada.' });
        }

        const eventos = await listarHistorico({ query }, existente.id);
        res.json(eventos.map((evento) => ({ ...evento, data: paraIso(evento.data) })));
    } catch (err) {
        console.error('[cadastros/historico]', err);
        res.status(500).json({ erro: 'Erro ao carregar o histórico da solicitação.' });
    }
});

// ── DELETE /api/cadastros/:id ────────────────────────────────────────────────
router.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const existente = await buscarCadastro(req.params.id);
        if (!existente) return res.status(404).json({ erro: 'Solicitação de cadastro não encontrada.' });

        const ehGestor = ['admin', 'gerente'].includes(String(req.usuario?.role || ''));
        if (!ehGestor) {
            if (!req.usuario?.vendedor_id || String(existente.vendedor_id) !== String(req.usuario.vendedor_id)) {
                return res.status(403).json({ erro: 'Você só pode excluir as próprias solicitações.' });
            }
            if (!['pendente', 'em_analise'].includes(existente.status)) {
                return res.status(403).json({ erro: 'Solicitação já analisada — apenas a gestão pode excluí-la.' });
            }
        }

        await query('DELETE FROM cadastros WHERE id = $1', [existente.id]);
        // Depois do DELETE no banco: se a remoção no B2 falhar, sobra só um
        // arquivo órfão no storage — nunca uma solicitação sem fotos.
        await apagarFotosDoB2(chavesDasFotos(existente.fotos));

        res.status(204).send();
    } catch (err) {
        console.error('[cadastros/delete]', err);
        res.status(500).json({ erro: 'Erro ao excluir solicitação de cadastro.' });
    }
});

export default router;
