// ─── rupturaRoutes.js ─────────────────────────────────────────────────────────
import express from 'express';
import { query } from '../config/database';
import { authMiddleware, ownDataOnly } from '../middleware/auth';

const rupturaRouter = express.Router();

rupturaRouter.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const { mes, ano, vendedor_id, page = 1, limit = 50 } = req.query;
        const fvId = req.filtroVendedor || vendedor_id;

        const where = [];
        const params: any[] = [];
        let p = 1;

        if (mes) {
            where.push(`r.mes_numero = $${p++}`);
            params.push(Number(mes));
        }
        if (ano) {
            where.push(`r.ano = $${p++}`);
            params.push(Number(ano));
        }
        if (fvId) {
            where.push(`r.vendedor_id = $${p++}`);
            params.push(fvId);
        }

        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const offset = (Number(page) - 1) * Number(limit);

        const rows = await query(`
            SELECT
                r.id, r.customer_number, r.status_ruptura, r.justificativa,
                r.pedido_em_carteira, r.observacao_ruptura,
                r.observacao_cancelamento, r.data_solicitacao_cancelamento,
                r.mes_numero, r.ano,
                c.customer_name, c.city, c.canal_cliente, c.segmentacao_cliente,
                c.telefone, c.nova_rup, c.cnpj,
                v.nome AS vendedor_nome, v.setor
            FROM ruptura r
            JOIN clientes c ON c.customer_number = r.customer_number
            LEFT JOIN vendedores v ON v.id = r.vendedor_id
            ${whereSql}
            ORDER BY c.segmentacao_cliente, c.customer_name
            LIMIT $${p++} OFFSET $${p++}
        `, [...params, Number(limit), offset]);

        const total = await query(
            `SELECT COUNT(*) FROM ruptura r ${whereSql}`,
            params
        );

        res.json({ total: Number(total.rows[0].count), pagina: Number(page), dados: rows.rows });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar ruptura.' });
    }
});

rupturaRouter.put('/:id', authMiddleware, async (req, res) => {
    try {
        const {
            justificativa, observacao_ruptura, observacao_cancelamento,
            pedido_em_carteira, data_solicitacao_cancelamento, status_ruptura,
        } = req.body;
        await query(`
            UPDATE ruptura SET
                justificativa                 = COALESCE($1, justificativa),
                observacao_ruptura            = COALESCE($2, observacao_ruptura),
                observacao_cancelamento       = COALESCE($3, observacao_cancelamento),
                pedido_em_carteira            = COALESCE($4, pedido_em_carteira),
                data_solicitacao_cancelamento = COALESCE($5, data_solicitacao_cancelamento),
                status_ruptura                = COALESCE($6, status_ruptura),
                updated_at                    = NOW()
            WHERE id = $7
        `, [
            justificativa, observacao_ruptura, observacao_cancelamento,
            pedido_em_carteira, data_solicitacao_cancelamento, status_ruptura,
            req.params.id,
        ]);
        res.json({ mensagem: 'Ruptura atualizada.' });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao atualizar ruptura.' });
    }
});

// ─── roteirizacaoRoutes.js ────────────────────────────────────────────────────
const rotRouter = express.Router();

rotRouter.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const { vendedor_id, dia_semana } = req.query;
        const fvId = req.filtroVendedor || vendedor_id;
        const params = [];
        const where = ['rot.ativa = TRUE'];
        let p = 1;

        if (fvId)      { where.push(`rot.vendedor_id = $${p++}`);   params.push(fvId); }
        if (dia_semana){ where.push(`rot.dia_semana = $${p++}`);    params.push(dia_semana); }

        const rows = await query(`
            SELECT
                rot.id, rot.customer_number, rot.dia_semana, rot.frequencia, rot.sequencia,
                rot.visitas_semana, rot.bairro, rot.cidade,
                c.customer_name, c.cnpj, c.canal_cliente, c.segmentacao_cliente,
                c.telefone, c.nova_rup, c.logradouro,
                v.nome AS vendedor_nome, v.setor, v.codigo_vendedor
            FROM roteirizacao rot
            JOIN clientes c ON c.customer_number = rot.customer_number
            LEFT JOIN vendedores v ON v.id = rot.vendedor_id
            WHERE ${where.join(' AND ')}
            ORDER BY rot.dia_semana, rot.sequencia, c.customer_name
        `, params);

        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar roteirização.' });
    }
});

// Rota para exportar roteiro do vendedor (para enviar por WhatsApp/email)
rotRouter.get('/exportar/:vendedorId', authMiddleware, async (req, res) => {
    try {
        const { dia } = req.query;
        const params = [req.params.vendedorId];
        const extra = dia ? `AND rot.dia_semana = $2` : '';
        if (dia) params.push(String(dia));

        const rows = await query(`
            SELECT
                rot.sequencia, rot.dia_semana, rot.frequencia,
                c.customer_number AS sold, c.customer_name AS razao_social,
                c.logradouro AS endereco, c.bairro AS bairro, c.city AS cidade,
                c.telefone, c.canal_cliente, c.segmentacao_cliente, c.nova_rup,
                c.qtd_conservadora AS conservadoras,
                rot.visitas_semana AS visitas
            FROM roteirizacao rot
            JOIN clientes c ON c.customer_number = rot.customer_number
            WHERE rot.vendedor_id = $1 AND rot.ativa = TRUE ${extra}
            ORDER BY rot.dia_semana, rot.sequencia
        `, params);

        const csv = [
            'SEQ;DIA;SOLD;RAZÃO SOCIAL;ENDEREÇO;BAIRRO;CIDADE;TELEFONE;CANAL;SEGM;STATUS COMPRA;CONSERVADORAS',
            ...rows.rows.map(r =>
                `${r.sequencia};${r.dia_semana};${r.sold};"${r.razao_social}";` +
                `"${r.endereco || ''}";${r.bairro || ''};${r.cidade || ''};` +
                `${r.telefone || ''};${r.canal_cliente};${r.segmentacao_cliente};` +
                `${r.nova_rup};${r.conservadoras}`
            )
        ].join('\r\n');

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="roteiro_${req.params.vendedorId}.csv"`);
        res.send('\uFEFF' + csv);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao exportar roteiro.' });
    }
});

rotRouter.post('/', authMiddleware, async (req, res) => {
    try {
        const { customer_number, codigo_vendedor, dia_semana, frequencia } = req.body;

        if (!customer_number || !codigo_vendedor || !dia_semana || !frequencia) {
            return res.status(400).json({ erro: 'Campos obrigatórios: customer_number, codigo_vendedor, dia_semana, frequencia.' });
        }

        const vendedor = await query(
            'SELECT id FROM vendedores WHERE codigo_vendedor = $1',
            [codigo_vendedor]
        );
        if (vendedor.rows.length === 0) {
            return res.status(404).json({ erro: 'Vendedor não encontrado.' });
        }
        const vendedor_id = vendedor.rows[0].id;

        // Desativa roteirização ativa anterior do mesmo cliente
        await query(
            'UPDATE roteirizacao SET ativa = FALSE WHERE customer_number = $1 AND ativa = TRUE',
            [customer_number]
        );

        const result = await query(`
            INSERT INTO roteirizacao (customer_number, vendedor_id, dia_semana, frequencia, ativa)
            VALUES ($1, $2, $3, $4, TRUE)
            RETURNING id
        `, [customer_number, vendedor_id, dia_semana, frequencia]);

        res.status(201).json({ mensagem: 'Roteirização criada.', id: result.rows[0].id });
    } catch (err) {
        console.error('[roteirizacao/post]', err);
        res.status(500).json({ erro: 'Erro ao criar roteirização.' });
    }
});

rotRouter.put('/:id', authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const { customer_number, codigo_vendedor, dia_semana, frequencia } = req.body;

        let vendedor_id: number | undefined;
        if (codigo_vendedor) {
            const vendedor = await query(
                'SELECT id FROM vendedores WHERE codigo_vendedor = $1',
                [codigo_vendedor]
            );
            if (vendedor.rows.length === 0) {
                return res.status(404).json({ erro: 'Vendedor não encontrado.' });
            }
            vendedor_id = vendedor.rows[0].id;
        }

        await query(`
            UPDATE roteirizacao SET
                customer_number = COALESCE($1, customer_number),
                vendedor_id     = COALESCE($2, vendedor_id),
                dia_semana      = COALESCE($3, dia_semana),
                frequencia      = COALESCE($4, frequencia)
            WHERE id = $5
        `, [customer_number ?? null, vendedor_id ?? null, dia_semana ?? null, frequencia ?? null, id]);

        res.json({ mensagem: 'Roteirização atualizada.' });
    } catch (err) {
        console.error('[roteirizacao/put]', err);
        res.status(500).json({ erro: 'Erro ao atualizar roteirização.' });
    }
});

rotRouter.delete('/:id', authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        await query('UPDATE roteirizacao SET ativa = FALSE WHERE id = $1', [id]);
        res.json({ mensagem: 'Roteirização removida.' });
    } catch (err) {
        console.error('[roteirizacao/delete]', err);
        res.status(500).json({ erro: 'Erro ao remover roteirização.' });
    }
});

// ─── cadastrosRoutes.js ───────────────────────────────────────────────────────
const cadRouter = express.Router();

cadRouter.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const { status, vendedor_id, page = 1, limit = 50 } = req.query;
        const fvId = req.filtroVendedor || vendedor_id;
        const where = [];
        const params = [];
        let p = 1;

        if (fvId)  { where.push(`c.vendedor_id = $${p++}`); params.push(fvId); }
        if (status){ where.push(`c.status = $${p++}`);      params.push(status); }

        const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';
        const offset = (Number(page) - 1) * Number(limit);

        const rows = await query(`
            SELECT c.*, v.nome AS vendedor_nome
            FROM cadastros c
            LEFT JOIN vendedores v ON v.id = c.vendedor_id
            ${wStr}
            ORDER BY c.created_at DESC
            LIMIT $${p++} OFFSET $${p++}
        `, [...params, Number(limit), offset]);

        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar cadastros.' });
    }
});

// ─── ticketsRoutes.js ─────────────────────────────────────────────────────────
const tickRouter = express.Router();

tickRouter.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const { status, vendedor_id } = req.query;
        const fvId = req.filtroVendedor || vendedor_id;
        const where = [];
        const params = [];
        let p = 1;

        if (fvId)  { where.push(`t.vendedor_id = $${p++}`); params.push(fvId); }
        if (status){ where.push(`t.status = $${p++}`);      params.push(status); }

        const wStr = where.length ? 'WHERE ' + where.join(' AND ') : '';

        const rows = await query(`
            SELECT t.*, v.nome AS vendedor_nome
            FROM tickets t LEFT JOIN vendedores v ON v.id = t.vendedor_id
            ${wStr}
            ORDER BY t.criado_em DESC LIMIT 200
        `, params);

        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar tickets.' });
    }
});

// ─── devedoresRoutes.js ───────────────────────────────────────────────────────
const devRouter = express.Router();

devRouter.get('/', authMiddleware, ownDataOnly, async (req, res) => {
    try {
        const fvId = req.filtroVendedor;
        const rows = await query(`
            SELECT d.*,
                   c.customer_name, c.city
            FROM devedores d
            LEFT JOIN clientes c ON c.cnpj = d.documento_cliente
            ${fvId ? 'WHERE c.vendedor_id = $1' : ''}
            ORDER BY d.dias_em_atraso DESC
            LIMIT 500
        `, fvId ? [fvId] : []);
        res.json(rows.rows);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao listar devedores.' });
    }
});

export { rupturaRouter, rotRouter, cadRouter, tickRouter, devRouter };


