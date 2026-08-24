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
//   GET    /api/cadastros/estatisticas → contadores por status: consolidado,
//                                      quebra por mês e quebra por vendedor.
//                                      Filtros: data_inicio, data_fim (AAAA-MM-DD,
//                                      inclusivos) e vendedor_id (só gestão —
//                                      vendedor fica preso ao próprio escopo)
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

function montarFiltroData(
    inicio: string | null,
    fim: string | null,
    coluna: string,
    parametros: unknown[],
): string {
    const filtros: string[] = [];
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

// Ordem: vínculo da própria solicitação → vendedor informado pela gestão no
// corpo do PUT → nome do "Vendedor - Território" do formulário. Sem nenhum
// deles a conclusão é recusada, em vez de gravar um cliente órfão.
async function resolverVendedor(existente: any, body: any): Promise<{ id?: string; erro?: string }> {
    if (existente.vendedor_id) return { id: existente.vendedor_id };

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
        vendedor_nome: row.vendedor_nome_atual ?? row.vendedor_nome ?? null,
        criado_em: paraIso(row.created_at),
        atualizado_em: paraIso(row.updated_at),
    };
}

// vendedor_nome da própria tabela é fallback para solicitações abertas por
// admin/gerente (sem vínculo em vendedores); o JOIN traz o nome atual.
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
    try {
        dataInicio = validarDataFiltro(req.query.data_inicio, 'data_inicio');
        dataFim = validarDataFiltro(req.query.data_fim, 'data_fim');
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
        totaisWhere += montarFiltroData(dataInicio, dataFim, 'c.created_at', totaisParams);

        const vendedoresParams: unknown[] = [];
        let vendedoresWhere = 'WHERE 1 = 1';
        if (filtroVendedor) {
            vendedoresParams.push(filtroVendedor);
            vendedoresWhere += ` AND c.vendedor_id = $${vendedoresParams.length}`;
        }
        vendedoresWhere += montarFiltroData(dataInicio, dataFim, 'c.created_at', vendedoresParams);

        // normalizeSql() troca todo $n por ? na ordem do texto, então este
        // filtro — que fica DEPOIS da subquery — precisa do próprio parâmetro.
        // Reaproveitar o $1 do WHERE interno deixava um ? sem valor e o MySQL
        // rejeitava a query inteira (todo request de vendedor virava 500).
        let vendedoresFiltroId = '';
        if (filtroVendedor) {
            vendedoresParams.push(filtroVendedor);
            vendedoresFiltroId = ` AND v.id = $${vendedoresParams.length}`;
        }

        const [totaisRes, mesesRes, vendedoresRes] = await Promise.all([
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
            query(`
                SELECT
                    MONTH(c.created_at) AS mes,
                    COUNT(*) AS total,
                    ${COLUNAS_STATUS}
                FROM cadastros c
                ${totaisWhere}
                GROUP BY MONTH(c.created_at)
                ORDER BY mes
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
            periodo: { data_inicio: dataInicio, data_fim: dataFim },
            vendedor_id: filtroTotais,
            por_status: normalizar(totaisRes.rows[0]),
            por_mes: mesesRes.rows.map((linha: any) => ({
                mes: Number(linha.mes),
                ...normalizar(linha),
            })),
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

        const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
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

        const id = randomUUID();
        const chaves = files.length ? await subirFotosParaB2(files, id) : [];

        try {
            await query(`
                INSERT INTO cadastros (
                    id, cadastro_froneri_wmc, cnpj, razao_social, canal_cliente, segmento,
                    cidade, email, telefone, dia_atendimento, prospector, vendedor_territorio,
                    modelo_freezer, voltagem_freezer, horario_recebimento_freezer, fotos,
                    status, vendedor_id, vendedor_nome
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
            `, [
                id, dados.cadastro_froneri_wmc, dados.cnpj, dados.razao_social, dados.canal_cliente, dados.segmento,
                dados.cidade, dados.email, dados.telefone, dados.dia_atendimento, dados.prospector, dados.vendedor_territorio,
                dados.modelo_freezer, dados.voltagem_freezer, dados.horario_recebimento_freezer, JSON.stringify(chaves),
                'pendente', req.usuario?.vendedor_id || null, req.usuario?.nome ? String(req.usuario.nome) : null,
            ]);
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

        try {
            // status e observacao ficam de fora de propósito — são da rota /status.
            await query(`
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

        // O front só manda observacao quando preenchida — ausente mantém a atual.
        const novaObservacao = observacao !== undefined
            ? (String(observacao).trim() || null)
            : existente.observacao;

        if (String(status) === 'concluido' && !existente.cliente_id) {
            // Efeito colateral crítico: cria o cliente definitivo vinculado ao
            // vendedor da solicitação. cliente_id já preenchido = cliente criado
            // numa conclusão anterior, não duplica.
            const vendedor = await resolverVendedor(existente, req.body || {});
            if (vendedor.erro) return res.status(400).json({ erro: vendedor.erro });
            const vendedorId = vendedor.id as string;

            // Sem customer_number: o SOLD é emitido pela Froneri e chega pela
            // planilha. Até lá o cliente vive só em `clientes`, identificado pelo
            // uuid. Nada de ruptura/snapshot mensal aqui — as duas tabelas são
            // chaveadas por customer_number, e a importação as preenche sozinha
            // assim que o SOLD chega (ver adotarClientesSemSold no importService).
            //
            // CNPJ vai só com dígitos, no mesmo formato que a importação grava —
            // é por ele que o cliente pendente é casado com a linha da planilha.
            const clienteId = randomUUID();
            const cnpjDigitos = String(existente.cnpj ?? '').replace(/\D/g, '') || null;

            await withTransaction(async (client) => {
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

                await client.query(`
                    UPDATE cadastros
                    SET status = $1, observacao = $2, cliente_id = $3, vendedor_id = $4
                    WHERE id = $5
                `, ['concluido', novaObservacao, clienteId, vendedorId, existente.id]);
            });
        } else {
            await query(
                'UPDATE cadastros SET status = $1, observacao = $2 WHERE id = $3',
                [String(status), novaObservacao, existente.id]
            );
        }

        const row = await buscarCadastro(existente.id);
        res.json(await montarCadastro(row));
    } catch (err) {
        console.error('[cadastros/status]', err);
        res.status(500).json({ erro: 'Erro ao atualizar status da solicitação.' });
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
