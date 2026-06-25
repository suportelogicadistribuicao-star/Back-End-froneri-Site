import 'dotenv/config';
import app from './src/app';
import { ensurePerformanceIndexes, testConnection } from './src/config/database';

// KingHost expõe a porta como PORT_<NOME_DO_SCRIPT> (ex: PORT_SERVER se o script é server.js)
// Consulte o painel Node.JS da KingHost ou ~/.bash_node para confirmar o nome exato
const PORT = parseInt(
    process.env.PORT_SERVER ||   // KingHost: ajuste se o script tiver outro nome no painel
    process.env.PORT       ||   // fallback genérico
    '8080'
);

async function start() {
    const dbOk = await testConnection();
    if (!dbOk) {
        console.error('[FATAL] Não foi possível conectar ao banco de dados. Encerrando.');
        process.exit(1);
    }

    await ensurePerformanceIndexes();

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

