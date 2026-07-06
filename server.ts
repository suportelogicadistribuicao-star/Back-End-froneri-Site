import 'dotenv/config';
import app from './src/app';
import { ensureClientesHistoricoTable } from './src/config/database';

const PORT = parseInt(
    process.env.PORT_DIST_SERVER || '21062'
);

async function start() {
    await ensureClientesHistoricoTable();
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

