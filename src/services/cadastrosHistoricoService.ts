// ─── Histórico das solicitações de cadastro ──────────────────────────────────
// `cadastros` guarda o ESTADO ATUAL: cada UPDATE sobrescreve o anterior, então
// a tabela sozinha nunca responde "quem mudou o quê, e quando". Este serviço
// grava os EVENTOS em `cadastros_historico` — uma linha por campo alterado,
// agrupadas por `evento_id` para o front montar um card por ação na timeline.
//
// Regra de ouro: gravar o evento SEMPRE na mesma transação da mudança que o
// gerou. Por isso todas as funções de escrita recebem o executor de fora
// (o `client` de withTransaction) em vez de chamarem `query` direto — histórico
// que existe sem a alteração, ou alteração sem histórico, é pior que nenhum.
import { randomUUID } from 'crypto';

/** Quem executa a query: o `client` de withTransaction ou o `query` do módulo. */
export interface Executor {
    query: (sql: string, params?: any[]) => Promise<any>;
}

export type TipoEvento = 'criacao' | 'status' | 'edicao' | 'conclusao';

/** Uma alteração de campo, já normalizada para exibição. */
export interface Mudanca {
    campo: string;
    de: string | null;
    para: string | null;
}

/**
 * Autor do evento, copiado do JWT (payload: { id, nome, role, ... }).
 * Campos frouxos de propósito: o payload é tipado como índice aberto em
 * types/express, e falta de autor nunca pode impedir a gravação do evento.
 */
export interface Autor {
    id?: string | number | null;
    nome?: unknown;
    role?: unknown;
}

// ─── Status terminais ────────────────────────────────────────────────────────
// Encerram a solicitação e carimbam `data_resolucao` (exposta como
// `finalizado_em`), que por sua vez move a competência do registro (ver
// `data_referencia` em CADASTROS_APP, no cadastrosRoutes). `recusado` entra
// aqui de propósito: uma recusa em 10/11 também deixou de ser trabalho de
// outubro. Os demais status (pendente, em_analise, em_andamento, reanalise,
// reativacao) são "em andamento" e limpam o carimbo se a solicitação voltar.
const STATUS_TERMINAIS = ['concluido', 'aprovado', 'recusado'];

function ehStatusTerminal(status: unknown): boolean {
    return STATUS_TERMINAIS.includes(String(status ?? ''));
}

// ─── Campos auditados ────────────────────────────────────────────────────────
// Só o que está aqui vira linha na timeline, com este rótulo. Campos de
// controle (id, vendedor_id, created_at, updated_at) ficam de fora: mudam por
// efeito colateral e só poluiriam a leitura do vendedor.
const CAMPOS_AUDITADOS: Record<string, string> = {
    status: 'Status',
    observacao: 'Observação',
    cliente_id: 'Cliente criado',
    finalizado_em: 'Data de competência',
    fotos: 'Fotos (quantidade)',
    cadastro_froneri_wmc: 'Cadastro Froneri/WMC',
    cnpj: 'CNPJ',
    razao_social: 'Razão social',
    canal_cliente: 'Canal do cliente',
    segmento: 'Segmento',
    cidade: 'Cidade',
    email: 'E-mail',
    telefone: 'Telefone',
    dia_atendimento: 'Dia de atendimento',
    prospector: 'Prospector',
    vendedor_territorio: 'Vendedor - Território',
    modelo_freezer: 'Modelo do freezer',
    voltagem_freezer: 'Voltagem do freezer',
    horario_recebimento_freezer: 'Horário de recebimento do freezer',
};

/** Campos comparados no PUT de edição, na ordem em que aparecem no formulário. */
const CAMPOS_EDICAO = [
    'cadastro_froneri_wmc', 'cnpj', 'razao_social', 'canal_cliente', 'segmento',
    'cidade', 'email', 'telefone', 'dia_atendimento', 'prospector',
    'vendedor_territorio', 'modelo_freezer', 'voltagem_freezer',
    'horario_recebimento_freezer',
];

function rotuloDoCampo(campo: string | null): string | null {
    if (!campo) return null;
    return CAMPOS_AUDITADOS[campo] ?? campo;
}

// Tudo vira texto legível antes de comparar E de gravar. Isso resolve dois
// problemas de uma vez: o TINYINT(1) que volta como 0/1 do MySQL não "muda"
// quando o form manda false, e o front recebe a timeline pronta para exibir,
// sem precisar reinterpretar tipo por tipo.
function normalizarValor(campo: string, valor: unknown): string | null {
    if (valor === undefined || valor === null || valor === '') return null;
    if (campo === 'cadastro_froneri_wmc') {
        return ['1', 'true', 'sim', 's'].includes(String(valor).toLowerCase()) ? 'Sim' : 'Não';
    }
    if (valor instanceof Date) return valor.toISOString();
    return String(valor).trim() || null;
}

/**
 * Compara dois estados e devolve só o que realmente mudou. Salvar o formulário
 * sem alterar nada precisa resultar em zero eventos — timeline cheia de "editou
 * (nada)" é ruído que faz o vendedor parar de olhar.
 */
function diffCampos(
    antes: Record<string, any>,
    depois: Record<string, any>,
    campos: string[] = CAMPOS_EDICAO,
): Mudanca[] {
    const mudancas: Mudanca[] = [];
    for (const campo of campos) {
        const de = normalizarValor(campo, antes?.[campo]);
        const para = normalizarValor(campo, depois?.[campo]);
        if (de !== para) mudancas.push({ campo, de, para });
    }
    return mudancas;
}

/**
 * Grava um evento. As N mudanças compartilham o mesmo `evento_id` — é o que
 * permite ao front agrupar "mudou telefone e cidade" num card só.
 * Evento sem mudanças (ex.: `criacao`) grava uma linha com `campo` NULL, para
 * que a ação exista na timeline mesmo sem diff.
 */
async function registrarEvento(
    executor: Executor,
    dados: {
        cadastroId: string;
        tipo: TipoEvento;
        autor?: Autor | null;
        mudancas?: Mudanca[];
    },
): Promise<void> {
    const { cadastroId, tipo, autor, mudancas = [] } = dados;
    const eventoId = randomUUID();

    const linhas: Array<{ campo: string | null; de: string | null; para: string | null }> =
        mudancas.length ? mudancas.map((m) => ({ campo: m.campo, de: m.de, para: m.para }))
                        : [{ campo: null, de: null, para: null }];

    const params: any[] = [];
    const values = linhas.map((linha) => {
        params.push(
            randomUUID(), cadastroId, eventoId, tipo, linha.campo, linha.de, linha.para,
            autor?.id != null ? String(autor.id) : null,
            autor?.nome ? String(autor.nome) : null,
            autor?.role ? String(autor.role) : null,
        );
        const base = params.length - 10;
        return `(${Array.from({ length: 10 }, (_, i) => `$${base + i + 1}`).join(', ')})`;
    }).join(', ');

    await executor.query(`
        INSERT INTO cadastros_historico (
            id, cadastro_id, evento_id, tipo, campo, valor_anterior, valor_novo,
            usuario_id, usuario_nome, usuario_role
        ) VALUES ${values}
    `, params);
}

/** Um card da timeline: uma ação, com todas as alterações que ela causou. */
export interface EventoHistorico {
    evento_id: string;
    tipo: TipoEvento;
    data: any;
    usuario: { id: string | null; nome: string | null; role: string | null };
    alteracoes: Array<{ campo: string | null; rotulo: string | null; de: string | null; para: string | null }>;
}

/**
 * Timeline completa de uma solicitação, do mais recente para o mais antigo.
 * O agrupamento é feito aqui (e não no SQL) porque o MySQL devolveria as
 * alterações concatenadas num texto — mais barato montar o array em JS do que
 * o front ter que desfazer um GROUP_CONCAT.
 */
async function listarHistorico(executor: Executor, cadastroId: string): Promise<EventoHistorico[]> {
    const res = await executor.query(`
        SELECT evento_id, tipo, campo, valor_anterior, valor_novo,
               usuario_id, usuario_nome, usuario_role, criado_em
        FROM cadastros_historico
        WHERE cadastro_id = $1
        ORDER BY criado_em DESC, evento_id, id
    `, [cadastroId]);

    const eventos = new Map<string, EventoHistorico>();
    for (const row of res.rows) {
        let evento = eventos.get(row.evento_id);
        if (!evento) {
            evento = {
                evento_id: row.evento_id,
                tipo: row.tipo,
                data: row.criado_em,
                usuario: {
                    id: row.usuario_id ?? null,
                    nome: row.usuario_nome ?? null,
                    role: row.usuario_role ?? null,
                },
                alteracoes: [],
            };
            eventos.set(row.evento_id, evento);
        }
        // Linha com campo NULL é o marcador do evento sem diff — não vira alteração.
        if (row.campo) {
            evento.alteracoes.push({
                campo: row.campo,
                rotulo: rotuloDoCampo(row.campo),
                de: row.valor_anterior ?? null,
                para: row.valor_novo ?? null,
            });
        }
    }

    return [...eventos.values()];
}

export {
    STATUS_TERMINAIS,
    CAMPOS_AUDITADOS,
    CAMPOS_EDICAO,
    ehStatusTerminal,
    normalizarValor,
    diffCampos,
    registrarEvento,
    listarHistorico,
    rotuloDoCampo,
};
