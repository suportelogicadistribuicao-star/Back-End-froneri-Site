require('dotenv').config();
const app = require('./src/app');
const { testConnection } = require('./src/config/database');

const PORT = parseInt(process.env.PORT || '3001');

async function start() {
    const dbOk = await testConnection();
    if (!dbOk) {
        console.error('[FATAL] Não foi possível conectar ao banco de dados. Encerrando.');
        process.exit(1);
    }

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`[SERVER] ERP Froneri rodando na porta ${PORT}`);
        console.log(`[SERVER] Ambiente: ${process.env.NODE_ENV || 'development'}`);
        console.log(`[SERVER] Health: http://localhost:${PORT}/api/health`);
    });
}

process.on('unhandledRejection', (reason) => {
    console.error('[FATAL] UnhandledRejection:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[FATAL] UncaughtException:', err);
    process.exit(1);
});

start();
