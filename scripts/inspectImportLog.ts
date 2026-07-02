import 'dotenv/config';
import mysql from 'mysql2/promise';

async function main() {
    const conn = await mysql.createConnection({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
    });

    const [columns] = await conn.query('DESCRIBE importacoes_log');
    console.log('--- DESCRIBE importacoes_log ---');
    console.log(columns);

    const [rows] = await conn.query(
        'SELECT id, arquivo_nome, status, created_at FROM importacoes_log ORDER BY created_at DESC LIMIT 5'
    );
    console.log('--- Últimos 5 registros (created_at DESC) ---');
    console.log(rows);

    const [rowsById] = await conn.query(
        'SELECT id, arquivo_nome, status, created_at FROM importacoes_log ORDER BY id DESC LIMIT 5'
    );
    console.log('--- Últimos 5 registros (id DESC, como a rota /historico faz hoje) ---');
    console.log(rowsById);

    await conn.end();
}

main().catch((err) => {
    console.error('Erro:', err);
    process.exit(1);
});
