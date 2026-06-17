"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.authMiddleware = authMiddleware;
exports.requireRole = requireRole;
exports.ownDataOnly = ownDataOnly;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET;
function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token de autenticação não fornecido.' });
    }
    const token = header.split(' ')[1];
    try {
        const payload = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        req.usuario = payload; // { id, email, role, vendedor_id }
        next();
    }
    catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ erro: 'Token expirado. Faça login novamente.' });
        }
        return res.status(401).json({ erro: 'Token inválido.' });
    }
}
// Verificar role mínimo
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.usuario)
            return res.status(401).json({ erro: 'Não autenticado.' });
        if (!roles.includes(req.usuario.role)) {
            return res.status(403).json({ erro: 'Acesso negado. Permissão insuficiente.' });
        }
        next();
    };
}
// Vendedor só vê os próprios dados (a menos que seja admin/gerente)
function ownDataOnly(req, res, next) {
    if (['admin', 'gerente'].includes(req.usuario?.role))
        return next();
    if (req.usuario?.vendedor_id) {
        req.filtroVendedor = req.usuario.vendedor_id;
    }
    next();
}
