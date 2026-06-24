"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.withTransaction = withTransaction;
exports.testConnection = testConnection;
exports.ensurePerformanceIndexes = ensurePerformanceIndexes;
const promise_1 = __importDefault(require("mysql2/promise"));
const SLOW_QUERY_MS = parseInt(process.env.DB_SLOW_QUERY_MS || '1500', 10);
const pool = promise_1.default.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    database: process.env.DB_NAME || 'erp_froneri',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: 20,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
});
exports.pool = pool;
function normalizeSql(sql) {
    return sql
        .replace(/\$\d+/g, '?')
        .replace(/\bILIKE\b/g, 'LIKE')
        .replace(/::int\b/g, '')
        .replace(/unaccent\(([^)]+)\)/g, '$1');
}
function toResult(rows, meta) {
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
async function query(text, params = []) {
    const start = Date.now();
    const sql = normalizeSql(String(text));
    try {
        const [rows, fields] = await pool.query(sql, params);
        const duration = Date.now() - start;
        if (duration > SLOW_QUERY_MS) {
            console.warn(`[DB] Query lenta (${duration}ms):`, sql.substring(0, 80));
        }
        return toResult(rows, fields);
    }
    catch (err) {
        console.error('[DB] Erro na query:', err.message, '\nSQL:', sql.substring(0, 200));
        throw err;
    }
}
// Transação helper compatível com callback atual.
async function withTransaction(callback) {
    const conn = await pool.getConnection();
    const client = {
        query: async (text, params = []) => {
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
    }
    catch (err) {
        await conn.rollback();
        throw err;
    }
    finally {
        conn.release();
    }
}
async function testConnection() {
    try {
        const res = await query('SELECT NOW() AS now, VERSION() AS version');
        console.log('[DB] Conectado ao MySQL:', res.rows[0].now);
        return true;
    }
    catch (err) {
        console.error('[DB] Falha na conexão:', err.message);
        return false;
    }
}
async function ensurePerformanceIndexes() {
    const ddlList = [
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
        }
        catch (err) {
            if (err?.code === 'ER_DUP_KEYNAME' || err?.errno === 1061) {
                continue;
            }
            console.warn(`[DB] Falha ao criar índice ${ddl.name}:`, err?.message || err);
        }
    }
}
