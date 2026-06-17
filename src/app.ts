import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import { testConnection } from './config/database';

import authRoutes from './routes/authRoutes';
import clientesRoutes from './routes/clientesRoutes';
import vendasRoutes from './routes/vendasRoutes';
import dashboardRoutes from './routes/dashboardRoutes';
import importRoutes from './routes/importRoutes';
import vendedoresRoutes from './routes/vendedoresRoutes';
import rupturaRoutes from './routes/rupturaRoutes';
import roteirizacaoRoutes from './routes/roteirizacaoRoutes';
import cadastrosRoutes from './routes/cadastrosRoutes';
import ticketsRoutes from './routes/ticketsRoutes';
import devedoresRoutes from './routes/devedoresRoutes';

const app = express();

// ── Segurança ──────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Rate limiting global
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,  // 15 minutos
    max: 500,
    message: { erro: 'Muitas requisições. Tente novamente em 15 minutos.' }
}));

// Rate limiting mais restrito para auth
app.use('/api/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    message: { erro: 'Muitas tentativas de login.' }
}));

// ── Body parsers ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// ── Rotas API ───────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/clientes',      clientesRoutes);
app.use('/api/vendas',        vendasRoutes);
app.use('/api/vendedores',    vendedoresRoutes);
app.use('/api/ruptura',       rupturaRoutes);
app.use('/api/roteirizacao',  roteirizacaoRoutes);
app.use('/api/cadastros',     cadastrosRoutes);
app.use('/api/tickets',       ticketsRoutes);
app.use('/api/devedores',     devedoresRoutes);
app.use('/api/import',        importRoutes);

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
    const dbOk = await testConnection().catch(() => false);
    const status = dbOk ? 200 : 503;
    res.status(status).json({
        status: dbOk ? 'ok' : 'degraded',
        banco:  dbOk ? 'conectado' : 'desconectado',
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
        erro:    err.message || 'Erro interno do servidor',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
    });
});

export default app;

