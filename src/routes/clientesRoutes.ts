import { Router } from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';
import { hasSnapshotForPeriodo } from '../services/clientesHistoricoService';

const router = Router();

function pickClienteFields(body: any): Record<string, any> {
    const allowed = [
        'customer_number',
        'customer_name',
        'city',
        'canal_cliente',
        'segmentacao_cliente',
        'status',
        'nova_rup',
        'observacao',
        'vendedor_id',
    ];

    const data: Record<string, any> = {};
    for (const key of allowed) {
        if (body[key] !== undefined) data[key] = body[key];
    }

    // Compatibilidade com payload do front-end.
    if (body.status_compra !== undefined && data.nova_rup === undefined) {
        data.nova_rup = body.status_compra;
    }

    return data;
}

async function existsClienteForScope(customerNumber: number, filtroVendedor?: number | string): Promise<boolean> {
    const scoped = await query(
        `SELECT 1
         FROM clientes c
         WHERE c.customer_number = $1
           ${filtroVendedor ? 'AND c.vendedor_id = $2' : ''}
         LIMIT 1`,
        filtroVendedor ? [customerNumber, filtroVendedor] : [customerNumber]
    );
    return scoped.rows.length > 0;
}

// POST /api/clientes
router.post('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const payload = pickClienteFields(req.body || {});
        if (!payload.customer_name?.toString().trim()) {
            return res.status(400).json({ erro: 'customer_name é obrigatório.' });
        }

        if (!payload.status) payload.status = 'C';
        if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;

        const fields = Object.keys(payload);
        const values = Object.values(payload);
        const placeholders = fields.map((_, i) => `$${i + 1}`);

        const createdInsert = await query(
            `INSERT INTO clientes (${fields.join(', ')})
             VALUES (${placeholders.join(', ')})`,
            values
        );

        const createdId = payload.customer_number ?? createdInsert.insertId;
        const created = await query('SELECT * FROM clientes WHERE customer_number = $1', [createdId]);

        res.status(201).json(created.rows[0]);
    } catch (err) {
        console.error('[clientes/create]', err);
        res.status(500).json({ erro: 'Erro ao criar cliente.' });
    }
});

// GET /api/clientes  — lista com filtros e paginação
// Com mes/ano informados e já existindo snapshot para o período, lê de
// clientes_historico_mensal (estado do cliente NAQUELE mês) em vez do estado
// atual — evita que cancelamentos/alterações posteriores contaminem
// retroativamente a análise de um mês passado. Sem mes/ano, ou sem snapshot
// ainda gravado para o período pedido, cai no comportamento de sempre
// (estado atual em `clientes` — usado pela tela de cadastro de clientes).
router.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const {
            page = 1, limit = 50,
            busca, canal, segmentacao, nova_rup,
            cidade, vendedor_id, status, com_ruptura,
            mes, ano,
        } = req.query;

        const offset = (Number(page) - 1) * Number(limit);

        const periodoInformado = mes !== undefined && mes !== '' && ano !== undefined && ano !== '';
        const mesNum = periodoInformado ? Number(mes) : null;
        const anoNum = periodoInformado ? Number(ano) : null;
        const usarHistorico = periodoInformado && await hasSnapshotForPeriodo(mesNum as number, anoNum as number);
        const tabela = usarHistorico ? 'clientes_historico_mensal' : 'clientes';

        const where: string[] = [];
        const params: any[] = [];
        let p = 1;

        if (usarHistorico) {
            where.push(`c.mes_numero = $${p++} AND c.ano = $${p++}`);
            params.push(mesNum, anoNum);
        }

        // Quando status não é informado, lista todos (ativos e inativos).
        if (status !== undefined && status !== null && String(status).trim() !== '') {
            where.push(`c.status = $${p++}`);
            params.push(status);
        }

        // Filtro automático por vendedor para role vendedor
        const fvId = req.filtroVendedor || vendedor_id;
        if (fvId) { where.push(`c.vendedor_id = $${p++}`); params.push(fvId); }

        if (busca) {
            const buscaParam = `%${busca}%`;
            where.push(`(
                unaccent(c.customer_name) ILIKE unaccent($${p}) OR
                c.cnpj ILIKE $${p} OR
                c.city ILIKE $${p} OR
                c.customer_number::text ILIKE $${p++}
            )`);
            params.push(buscaParam);
        }
        if (canal)       { where.push(`c.canal_cliente = $${p++}`);       params.push(canal);       }
        if (segmentacao) { where.push(`c.segmentacao_cliente = $${p++}`); params.push(segmentacao); }
        if (nova_rup)    { where.push(`c.nova_rup = $${p++}`);            params.push(nova_rup);    }
        if (cidade)      { where.push(`c.city ILIKE $${p++}`);            params.push(`%${cidade}%`); }

        if (com_ruptura === 'true') {
            const now = new Date();
            const mesRup = mesNum ?? now.getMonth() + 1;
            const anoRup = anoNum ?? now.getFullYear();
            params.push(mesRup, anoRup);
            where.push(`EXISTS (
                SELECT 1 FROM ruptura r
                WHERE r.customer_number = c.customer_number
                  AND r.mes_numero = $${p++} AND r.ano = $${p++}
            )`);
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limitIdx = p;
        const offsetIdx = p + 1;

        // telefone/payment_terms/credit_limit/endereço não existem no snapshot
        // mensal (não fazem parte do "estado que regride" — só cadastro estático).
        const camposSemHistorico = usarHistorico
            ? 'NULL AS telefone, NULL AS payment_terms, NULL AS credit_limit, NULL AS logradouro, NULL AS bairro, NULL AS postal_code, NULL AS codigo_setor'
            : 'c.telefone, c.payment_terms, c.credit_limit, c.logradouro, c.bairro, c.postal_code, c.codigo_setor';

        const [total, rows] = await Promise.all([
            query(`SELECT COUNT(*) AS count FROM ${tabela} c ${whereClause}`, params),
            query(`
                SELECT
                    c.customer_number, c.customer_name, c.cnpj, c.city,
                    c.canal_cliente, c.segmentacao_cliente, c.nova_rup, c.status,
                    c.tem_contrato, c.qtd_conservadora, c.hierarquia,
                    ${camposSemHistorico},
                    v.nome AS vendedor_nome, v.setor AS vendedor_setor,
                    rot.dia_semana, rot.frequencia, rot.sequencia,
                    CASE
                        WHEN c.nova_rup = 'C/ Compra'    THEN 'ATIVO'
                        WHEN c.nova_rup = 'Cliente Novo' THEN 'NOVO'
                        WHEN c.nova_rup LIKE '% Mês%'    THEN 'RISCO'
                        WHEN c.nova_rup LIKE '%6 Meses%' THEN 'CRÍTICO'
                        ELSE 'INDEFINIDO'
                    END AS status_compra
                FROM ${tabela} c
                LEFT JOIN vendedores v   ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                ${whereClause}
                ORDER BY c.customer_name
                LIMIT $${limitIdx} OFFSET $${offsetIdx}
            `, [...params, Number(limit), offset]),
        ]);

        res.json({
            total:   Number(total.rows[0].count),
            pagina:  Number(page),
            limite:  Number(limit),
            dados:   rows.rows,
            ...(periodoInformado ? { periodo: { mes: mesNum, ano: anoNum, fonte: usarHistorico ? 'historico' : 'atual' } } : {}),
        });
    } catch (err) {
        console.error('[clientes/list]', err);
        res.status(500).json({ erro: 'Erro ao listar clientes.' });
    }
});

// GET /api/clientes/exportar/csv
router.get('/exportar/csv', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const fvId = req.filtroVendedor;
        const rows = await query(`
            SELECT
                c.customer_number AS "SOLD",
                c.customer_name AS "Razão Social",
                c.cnpj AS "CNPJ",
                c.city AS "Cidade",
                c.canal_cliente AS "Canal",
                c.segmentacao_cliente AS "Segmentação",
                c.nova_rup AS "Status Compra",
                c.telefone AS "Telefone",
                v.nome AS "Vendedor",
                v.setor AS "Setor",
                rot.dia_semana AS "Dia Visita",
                rot.frequencia AS "Frequência"
            FROM clientes c
            LEFT JOIN vendedores v ON v.id = c.vendedor_id
            LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
            WHERE c.status = 'C'
            ${fvId ? 'AND c.vendedor_id = $1' : ''}
            ORDER BY v.nome, c.customer_name
        `, fvId ? [fvId] : []);

        if (rows.rows.length === 0) return res.status(404).json({ erro: 'Nenhum dado.' });

        const cols = Object.keys(rows.rows[0]);
        const csvLines = [
            cols.join(';'),
            ...rows.rows.map(r =>
                cols.map(c => `"${(r[c] ?? '').toString().replace(/"/g, '""')}"`).join(';')
            )
        ];

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="clientes.csv"');
        res.send('\uFEFF' + csvLines.join('\r\n'));
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao exportar.' });
    }
});

// GET /api/clientes/:customerNumber  — detalhe completo
router.get('/:id', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);

        const [cliente, vendas, ruptura, pedidos, historicoCadastral] = await Promise.all([
            query(`
                SELECT c.*, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor,
                       rot.dia_semana, rot.frequencia, rot.sequencia, rot.visitas_semana
                FROM clientes c
                LEFT JOIN vendedores v ON v.id = c.vendedor_id
                LEFT JOIN roteirizacao rot ON rot.customer_number = c.customer_number AND rot.ativa = TRUE
                WHERE c.customer_number = $1
            `, [id]),

            query(`
                SELECT mes_descricao, mes_numero, ano,
                       SUM(valor_nf) AS valor, SUM(soma_caixas) AS caixas,
                       SUM(soma_litros) AS litros, COUNT(*) AS itens
                FROM vendas WHERE customer_number = $1
                GROUP BY mes_descricao, mes_numero, ano
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [id]),

            query(`
                SELECT * FROM ruptura
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 6
            `, [id]),

            query(`
                SELECT * FROM pedidos_carteira
                WHERE customer_number = $1
                ORDER BY order_date DESC
                LIMIT 20
            `, [id]),

            // Snapshot mensal do cadastro — como o cliente estava em cada mês
            // (status, nova_rup, tem_contrato etc.), diferente do estado atual
            // acima (cliente.rows[0]), que só reflete a última importação.
            query(`
                SELECT mes_referencia, mes_numero, ano, status, nova_rup, tem_contrato,
                       qtd_conservadora, segmentacao_cliente, canal_cliente, hierarquia,
                       filial, vendedor_id
                FROM clientes_historico_mensal
                WHERE customer_number = $1
                ORDER BY ano DESC, mes_numero DESC
                LIMIT 12
            `, [id]),
        ]);

        if (cliente.rows.length === 0) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        res.json({
            ...cliente.rows[0],
            historico_vendas:     vendas.rows,
            historico_ruptura:    ruptura.rows,
            historico_cadastral:  historicoCadastral.rows,
            pedidos_carteira:     pedidos.rows,
        });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar cliente.' });
    }
});

// PUT /api/clientes/:id/observacao  — atualizar observações manualmente
router.put('/:id/observacao', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ erro: 'ID inválido.' });

        const allowed = await existsClienteForScope(id, req.filtroVendedor);
        if (!allowed) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        const { observacao } = req.body;
        await query(
            'UPDATE clientes SET observacao = $1, updated_at = NOW() WHERE customer_number = $2',
            [observacao ?? null, id]
        );
        res.json({ mensagem: 'Observação salva.' });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao salvar observação.' });
    }
});

// PUT /api/clientes/:id
router.put('/:id', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ erro: 'ID inválido.' });

        const allowed = await existsClienteForScope(id, req.filtroVendedor);
        if (!allowed) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        const payload = pickClienteFields(req.body || {});
        delete payload.customer_number;
        if (req.filtroVendedor) payload.vendedor_id = req.filtroVendedor;

        const fields = Object.keys(payload);
        if (fields.length === 0) {
            return res.status(400).json({ erro: 'Nenhum campo válido para atualizar.' });
        }

        const setClause = fields.map((field, i) => `${field} = $${i + 1}`).join(', ');
        const values = [...fields.map((field) => payload[field]), id];

        await query(
            `UPDATE clientes
             SET ${setClause}, updated_at = NOW()
             WHERE customer_number = $${values.length}`,
            values
        );

        const updated = await query('SELECT * FROM clientes WHERE customer_number = $1', [id]);

        res.json(updated.rows[0]);
    } catch (err) {
        console.error('[clientes/update]', err);
        res.status(500).json({ erro: 'Erro ao atualizar cliente.' });
    }
});

// DELETE /api/clientes/:id
router.delete('/:id', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const id = Number(req.params.id);
        if (!Number.isFinite(id)) return res.status(400).json({ erro: 'ID inválido.' });

        const allowed = await existsClienteForScope(id, req.filtroVendedor);
        if (!allowed) {
            return res.status(404).json({ erro: 'Cliente não encontrado.' });
        }

        // Exclusão lógica para preservar histórico e relacionamentos.
        await query(
            'UPDATE clientes SET status = $1, updated_at = NOW() WHERE customer_number = $2',
            ['I', id]
        );

        res.status(204).send();
    } catch (err) {
        console.error('[clientes/delete]', err);
        res.status(500).json({ erro: 'Erro ao remover cliente.' });
    }
});

export default router;


