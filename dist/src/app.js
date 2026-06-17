"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const database_1 = require("./config/database");
const authRoutes_1 = __importDefault(require("./routes/authRoutes"));
const clientesRoutes_1 = __importDefault(require("./routes/clientesRoutes"));
const vendasRoutes_1 = __importDefault(require("./routes/vendasRoutes"));
const dashboardRoutes_1 = __importDefault(require("./routes/dashboardRoutes"));
const importRoutes_1 = __importDefault(require("./routes/importRoutes"));
const vendedoresRoutes_1 = __importDefault(require("./routes/vendedoresRoutes"));
const rupturaRoutes_1 = __importDefault(require("./routes/rupturaRoutes"));
const roteirizacaoRoutes_1 = __importDefault(require("./routes/roteirizacaoRoutes"));
const cadastrosRoutes_1 = __importDefault(require("./routes/cadastrosRoutes"));
const ticketsRoutes_1 = __importDefault(require("./routes/ticketsRoutes"));
const devedoresRoutes_1 = __importDefault(require("./routes/devedoresRoutes"));
const app = (0, express_1.default)();
// ── Segurança ──────────────────────────────────────────────────────────────
app.use((0, helmet_1.default)());
app.use((0, cors_1.default)({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));
// Rate limiting global
app.use((0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 500,
    message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' }
}));
// Rate limiting mais restrito para auth
app.use('/api/auth', (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { erro: 'Muitas tentativas de login.' }
}));
// ── Body parsers ────────────────────────────────────────────────────────────
app.use(express_1.default.json({ limit: '5mb' }));
app.use(express_1.default.urlencoded({ extended: true, limit: '5mb' }));
// ── Rotas API ───────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes_1.default);
app.use('/api/dashboard', dashboardRoutes_1.default);
app.use('/api/clientes', clientesRoutes_1.default);
app.use('/api/vendas', vendasRoutes_1.default);
app.use('/api/vendedores', vendedoresRoutes_1.default);
app.use('/api/ruptura', rupturaRoutes_1.default);
app.use('/api/roteirizacao', roteirizacaoRoutes_1.default);
app.use('/api/cadastros', cadastrosRoutes_1.default);
app.use('/api/tickets', ticketsRoutes_1.default);
app.use('/api/devedores', devedoresRoutes_1.default);
app.use('/api/import', importRoutes_1.default);
// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const dbOk = await (0, database_1.testConnection)().catch(() => false);
    const status = dbOk ? 200 : 503;
    res.status(status).json({
        status: dbOk ? 'ok' : 'degraded',
        banco: dbOk ? 'conectado' : 'desconectado',
        versao: '1.0.0',
        timestamp: new Date().toISOString()
    });
});
// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ erro: `Rota não encontrada: ${req.method} ${req.path}` });
});
// ── Tratamento global de erros ────────────────────────────────────────────────
app.use((err, req, res, _next) => {
    console.error('[API Error]', err.message, err.stack);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        erro: err.message || 'Erro interno do servidor',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});
exports.default = app;
