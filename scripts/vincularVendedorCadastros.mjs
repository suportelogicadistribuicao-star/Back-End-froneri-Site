// Preenche `cadastros.vendedor_id` nas solicitações que chegaram sem vínculo.
//
// Por que existe: a carga histórica de cadastros entrou direto no banco, só com
// o nome em `vendedor_territorio`. Toda a tela de cadastros filtra o vendedor
// logado por `vendedor_id` (listagem, estatísticas, histórico, exclusão), então
// sem o vínculo o vendedor não enxergava nenhuma solicitação.
//
// Mesma regra de `vendedorPorNome` em src/routes/cadastrosRoutes.ts: todos os
// tokens do nome em `vendedores` precisam estar no território, e o casamento
// tem que ser ÚNICO. Território sem vendedor correspondente ("ADM", ex-vendedor)
// continua NULL — só a gestão vê, como antes.
//
// Só mexe em linha com vendedor_id NULL; rodar de novo não altera nada.
// Com --aplicar, grava antes os ids alterados em scripts/backups/ para permitir
// desfazer (UPDATE cadastros SET vendedor_id = NULL WHERE id IN (...)).
//
//   node scripts/vincularVendedorCadastros.mjs            → simulação
//   node scripts/vincularVendedorCadastros.mjs --aplicar  → grava
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APLICAR = process.argv.includes('--aplicar');
const CONECTIVOS_NOME = new Set(['de', 'da', 'do', 'das', 'dos', 'e']);

function tokensDoNome(valor) {
    return String(valor ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((t) => t && !CONECTIVOS_NOME.has(t));
}

function resolverVendedor(territorio, vendedores) {
    const alvo = new Set(tokensDoNome(territorio));
    if (alvo.size === 0) return null;
    const candidatos = vendedores.filter((v) => {
        const tokens = tokensDoNome(v.nome);
        return tokens.length > 0 && tokens.every((t) => alvo.has(t));
    });
    return candidatos.length === 1 ? candidatos[0] : null;
}

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    try {
        const [vendedores] = await conn.query('SELECT id, nome FROM vendedores WHERE ativo = TRUE');
        const [linhas] = await conn.query(
            // Desde a recriação da tabela pela planilha (06/10/2026) o nome do
            // território está em `nome_vendedor`.
            'SELECT id, nome_vendedor AS vendedor_territorio FROM cadastros WHERE vendedor_id IS NULL',
        );

        const alteracoes = [];
        const resumo = new Map();
        for (const linha of linhas) {
            const vendedor = resolverVendedor(linha.vendedor_territorio, vendedores);
            const chave = linha.vendedor_territorio ?? '(vazio)';
            const item = resumo.get(chave) ?? { territorio: chave, solicitacoes: 0, vincular_a: vendedor?.nome ?? '— fica sem vínculo' };
            item.solicitacoes += 1;
            resumo.set(chave, item);
            if (vendedor) alteracoes.push({ id: linha.id, vendedor_id: vendedor.id, vendedor_nome: vendedor.nome });
        }

        console.table([...resumo.values()].sort((a, b) => a.territorio.localeCompare(b.territorio, 'pt-BR')));
        console.log(`\nA vincular: ${alteracoes.length} · sem vendedor correspondente: ${linhas.length - alteracoes.length}`);

        if (!APLICAR) {
            console.log('Simulação — nada gravado. Rode com --aplicar para gravar.');
            return;
        }
        if (alteracoes.length === 0) {
            console.log('Nada a gravar.');
            return;
        }

        const pasta = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), 'backups');
        fs.mkdirSync(pasta, { recursive: true });
        const arquivo = path.join(pasta, `cadastros_vendedor_id_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(arquivo, JSON.stringify({ antes: 'vendedor_id NULL', alteracoes }, null, 2));
        console.log(`Ids alterados salvos em ${arquivo}`);

        await conn.beginTransaction();
        let atualizadas = 0;
        for (const a of alteracoes) {
            const [res] = await conn.query(
                'UPDATE cadastros SET vendedor_id = ? WHERE id = ? AND vendedor_id IS NULL',
                [a.vendedor_id, a.id],
            );
            atualizadas += res.affectedRows;
        }
        await conn.commit();
        console.log(`Gravado: ${atualizadas} solicitações vinculadas.`);
    } catch (err) {
        await conn.rollback().catch(() => {});
        throw err;
    } finally {
        await conn.end();
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
