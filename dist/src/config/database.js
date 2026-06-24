"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.pool = void 0;
exports.query = query;
exports.withTransaction = withTransaction;
exports.testConnection = testConnection;
const promise_1 = __importDefault(require("mysql2/promise"));
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
        if (duration > 1000) {
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
