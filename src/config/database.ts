import mysql from 'mysql2/promise';

const SLOW_QUERY_MS = parseInt(process.env.DB_SLOW_QUERY_MS || '1500', 10);

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'erp_froneri',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    connectTimeout: 30000,
});

function normalizeSql(sql: string): string {
    return sql
        .replace(/\$\d+/g, '?')
        .replace(/\bILIKE\b/g, 'LIKE')
        .replace(/::int\b/g, '')
        .replace(/unaccent\(([^)]+)\)/g, '$1');
}

function toResult(rows: any, meta: any) {
    if (Array.isArray(rows)) {
        return {
            rows,
            rowCount: rows.length,
            insertId: null,
            affectedRows: 0,
            fields: meta,
        };
    }

    return {
        rows: [],
        rowCount: rows?.affectedRows ?? 0,
        insertId: rows?.insertId ?? null,
        affectedRows: rows?.affectedRows ?? 0,
        fields: meta,
    };
}

// Wrapper para queries com log e formato compatível com o uso atual do projeto.
async function query(text: any, params: any[] = []): Promise<any> {
    const start = Date.now();
    const sql = normalizeSql(String(text));
    try {
        const [rows, fields] = await pool.query(sql, params);
        const duration = Date.now() - start;
        if (duration > SLOW_QUERY_MS) {
            console.warn(`[DB] Query lenta (${duration}ms):`, sql.substring(0, 80));
        }
        return toResult(rows, fields);
    } catch (err: any) {
        console.error('[DB] Erro na query:', err.message, '\nSQL:', sql.substring(0, 200));
        throw err;
    }
}

// Transação helper compatível com callback atual.
async function withTransaction(callback: (client: any) => Promise<any>): Promise<any> {
    const conn = await pool.getConnection();
    const client = {
        query: async (text: any, params: any[] = []) => {
            const sql = normalizeSql(String(text));
            const [rows, fields] = await conn.query(sql, params);
            return toResult(rows, fields);
        },
    };

    try {
        await conn.beginTransaction();
        const result = await callback(client);
        await conn.commit();
        return result;
    } catch (err) {
        await conn.rollback();
        throw err;
    } finally {
        conn.release();
    }
}

async function testConnection() {
    try {
        const res = await query('SELECT NOW() AS now, VERSION() AS version');
        console.log('[DB] Conectado ao MySQL:', res.rows[0].now);
        return true;
    } catch (err: any) {
        console.error('[DB] Falha na conexão:', err.message);
        return false;
    }
}

type DdlQuery = { name: string; sql: string };

async function ensurePerformanceIndexes() {
    const ddlList: DdlQuery[] = [
        {
            name: 'idx_vendas_periodo_vendedor',
            sql: `CREATE INDEX idx_vendas_periodo_vendedor ON vendas (ano, mes_numero, vendedor_id)`,
        },
        {
            name: 'idx_vendas_periodo_canal_segmentacao',
            sql: `CREATE INDEX idx_vendas_periodo_canal_segmentacao ON vendas (ano, mes_numero, canal_cliente, segmentacao_cliente)`,
        },
        {
            name: 'idx_vendas_customer_number',
            sql: `CREATE INDEX idx_vendas_customer_number ON vendas (customer_number)`,
        },
        {
            name: 'idx_ruptura_periodo_vendedor',
            sql: `CREATE INDEX idx_ruptura_periodo_vendedor ON ruptura (ano, mes_numero, vendedor_id)`,
        },
        {
            name: 'idx_ruptura_customer_number',
            sql: `CREATE INDEX idx_ruptura_customer_number ON ruptura (customer_number)`,
        },
        {
            name: 'idx_pedidos_periodo_vendedor',
            sql: `CREATE INDEX idx_pedidos_periodo_vendedor ON pedidos_carteira (ano, mes_numero, vendedor_id)`,
        },
        {
            name: 'idx_pedidos_customer_number',
            sql: `CREATE INDEX idx_pedidos_customer_number ON pedidos_carteira (customer_number)`,
        },
        {
            name: 'idx_clientes_vendedor_status',
            sql: `CREATE INDEX idx_clientes_vendedor_status ON clientes (vendedor_id, status, customer_number)`,
        },
        {
            name: 'idx_clientes_cnpj',
            sql: `CREATE INDEX idx_clientes_cnpj ON clientes (cnpj)`,
        },
        {
            name: 'idx_vendedores_usuario_ativo',
            sql: `CREATE INDEX idx_vendedores_usuario_ativo ON vendedores (usuario_id, ativo)`,
        },
        {
            name: 'idx_usuarios_email_ativo',
            sql: `CREATE INDEX idx_usuarios_email_ativo ON usuarios (email, ativo)`,
        },
        {
            name: 'idx_roteirizacao_vendedor_ativa_dia_seq',
            sql: `CREATE INDEX idx_roteirizacao_vendedor_ativa_dia_seq ON roteirizacao (vendedor_id, ativa, dia_semana, sequencia)`,
        },
        {
            name: 'idx_roteirizacao_ativa_dia_seq_customer',
            sql: `CREATE INDEX idx_roteirizacao_ativa_dia_seq_customer ON roteirizacao (ativa, dia_semana, sequencia, customer_number, vendedor_id)`,
        },
        {
            name: 'idx_roteirizacao_customer_ativa',
            sql: `CREATE INDEX idx_roteirizacao_customer_ativa ON roteirizacao (customer_number, ativa)`,
        },
        {
            name: 'idx_importacoes_created_at',
            sql: `CREATE INDEX idx_importacoes_created_at ON importacoes_log (created_at)`,
        },
    ];

    for (const ddl of ddlList) {
        try {
            await pool.query(ddl.sql);
            console.log(`[DB] Índice criado: ${ddl.name}`);
        } catch (err: any) {
            if (err?.code === 'ER_DUP_KEYNAME' || err?.errno === 1061) {
                continue;
            }
            console.warn(`[DB] Falha ao criar índice ${ddl.name}:`, err?.message || err);
        }
    }
}

// `clientes_historico_mensal` não tem migração própria no repositório — a tabela
// era criada manualmente em produção. IF NOT EXISTS torna isso idempotente: em
// bases onde ela já existe é um no-op; em bases novas garante que o import
// (importService.ts) sempre encontre a tabela com a chave única que seu
// ON DUPLICATE KEY UPDATE espera, em vez de falhar a transação inteira.
async function ensureClientesHistoricoTable() {
    const sql = `
        CREATE TABLE IF NOT EXISTS clientes_historico_mensal (
            id                    INT AUTO_INCREMENT PRIMARY KEY,
            customer_number       INT NOT NULL,
            mes_referencia        VARCHAR(20)  NULL,
            mes_numero            TINYINT      NOT NULL,
            ano                   SMALLINT     NOT NULL,
            customer_name         VARCHAR(255) NULL,
            cnpj                  VARCHAR(30)  NULL,
            city                  VARCHAR(120) NULL,
            status                CHAR(2)      NOT NULL DEFAULT 'C',
            nova_rup              VARCHAR(60)  NULL,
            tem_contrato          TINYINT(1)   NOT NULL DEFAULT 0,
            qtd_conservadora      INT          NOT NULL DEFAULT 0,
            segmentacao_cliente   VARCHAR(60)  NULL,
            canal_cliente         VARCHAR(60)  NULL,
            hierarquia            VARCHAR(120) NULL,
            filial                VARCHAR(60)  NULL,
            territory_number      INT          NULL,
            vendedor_id           INT          NULL,
            importacao_id         CHAR(36)     NULL,
            created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY uq_cliente_historico_periodo (customer_number, mes_numero, ano),
            KEY idx_cliente_historico_periodo (mes_numero, ano)
        )
    `;
    try {
        await pool.query(sql);
        console.log('[DB] Tabela clientes_historico_mensal verificada/criada.');
    } catch (err: any) {
        console.error('[DB] Falha ao garantir tabela clientes_historico_mensal:', err?.message || err);
    }
}

export { pool, query, withTransaction, testConnection, ensurePerformanceIndexes, ensureClientesHistoricoTable };

