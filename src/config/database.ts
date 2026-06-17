import { Pool } from 'pg';

const pool = new Pool({
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME     || 'erp_froneri',
    user:     process.env.DB_USER     || 'erp_froneri_user',
    password: process.env.DB_PASSWORD,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
    console.error('[DB] Erro inesperado no pool:', err.message);
});

// Wrapper para queries com log de erro
async function query(text: any, params: any[] = []): Promise<any> {
    const start = Date.now();
    try {
        const result = await pool.query(text, params);
        const duration = Date.now() - start;
        if (duration > 1000) {
            console.warn(`[DB] Query lenta (${duration}ms):`, text.substring(0, 80));
        }
        return result;
    } catch (err) {
        console.error('[DB] Erro na query:', err.message, '\nSQL:', text.substring(0, 200));
        throw err;
    }
}

// Transação helper
async function withTransaction(callback: (client: any) => Promise<any>): Promise<any> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await callback(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function testConnection() {
    try {
        const res = await query('SELECT NOW() AS now, version() AS version');
        console.log('[DB] Conectado ao PostgreSQL:', res.rows[0].now);
        return true;
    } catch (err) {
        console.error('[DB] Falha na conexão:', err.message);
        return false;
    }
}

export { pool, query, withTransaction, testConnection };

