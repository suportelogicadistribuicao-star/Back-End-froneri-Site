"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const app_1 = __importDefault(require("./src/app"));
const database_1 = require("./src/config/database");
const PORT = parseInt(process.env.PORT || '8080');
async function start() {
    const dbOk = await (0, database_1.testConnection)();
    if (!dbOk) {
        console.error('[FATAL] Não foi possível conectar ao banco de dados. Encerrando.');
        process.exit(1);
    }
    await (0, database_1.ensurePerformanceIndexes)();
    app_1.default.listen(PORT, '0.0.0.0', () => {
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
