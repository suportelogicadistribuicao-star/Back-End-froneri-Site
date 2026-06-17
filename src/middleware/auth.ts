import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET as string;

function authMiddleware(req, res, next) {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Token de autenticação não fornecido.' });
    }

    const token = header.split(' ')[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET) as any;
        req.usuario = payload;  // { id, email, role, vendedor_id }
        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ erro: 'Token expirado. Faça login novamente.' });
        }
        return res.status(401).json({ erro: 'Token inválido.' });
    }
}

// Verificar role mínimo
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.usuario) return res.status(401).json({ erro: 'Não autenticado.' });
        if (!roles.includes(req.usuario.role)) {
            return res.status(403).json({ erro: 'Acesso negado. Permissão insuficiente.' });
        }
        next();
    };
}

// Vendedor só vê os próprios dados (a menos que seja admin/gerente)
function ownDataOnly(req, res, next) {
    if (['admin', 'gerente'].includes(req.usuario?.role)) return next();
    if (req.usuario?.vendedor_id) {
        req.filtroVendedor = req.usuario.vendedor_id;
    }
    next();
}

export { authMiddleware, requireRole, ownDataOnly };

