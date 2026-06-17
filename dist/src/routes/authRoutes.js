"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// ─── Auth Routes ─────────────────────────────────────────────────────────────
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const database_1 = require("../config/database");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
const JWT_SECRET = process.env.JWT_SECRET;
const ROLES_PERMITIDAS = ['admin', 'gerente', 'vendedor'];
function extrairTokenDoHeader(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer '))
        return null;
    return authHeader.split(' ')[1];
}
// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) {
            return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
        }
        const result = await (0, database_1.query)(`SELECT u.*, v.id AS vendedor_id, v.nome AS vendedor_nome, v.setor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.email = $1 AND u.ativo = TRUE`, [email.toLowerCase().trim()]);
        if (result.rows.length === 0) {
            return res.status(401).json({ erro: 'Credenciais inválidas.' });
        }
        const usuario = result.rows[0];
        const senhaOk = await bcryptjs_1.default.compare(senha, usuario.senha_hash);
        if (!senhaOk) {
            return res.status(401).json({ erro: 'Credenciais inválidas.' });
        }
        // Atualizar último login
        await (0, database_1.query)('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [usuario.id]);
        const token = jsonwebtoken_1.default.sign({
            id: usuario.id,
            email: usuario.email,
            role: usuario.role,
            nome: usuario.nome,
            vendedor_id: usuario.vendedor_id || null,
            setor: usuario.setor || null
        }, JWT_SECRET, { expiresIn: (process.env.JWT_EXPIRES_IN || '8h') });
        res.json({
            token,
            usuario: {
                id: usuario.id,
                nome: usuario.nome,
                email: usuario.email,
                role: usuario.role,
                vendedor_id: usuario.vendedor_id,
                vendedorNome: usuario.vendedor_nome,
                setor: usuario.setor
            }
        });
    }
    catch (err) {
        console.error('[auth/login]', err);
        res.status(500).json({ erro: 'Erro ao fazer login.' });
    }
});
// POST /api/auth/register
// Regra:
// - Se ainda nao existe usuario, permite bootstrap sem token e forca role=admin.
// - Depois do primeiro usuario, apenas admin pode cadastrar novos usuarios.
router.post('/register', async (req, res) => {
    try {
        const { nome, email, senha, role } = req.body;
        if (!nome || !email || !senha) {
            return res.status(400).json({ erro: 'Nome, email e senha são obrigatórios.' });
        }
        if (String(senha).length < 8) {
            return res.status(400).json({ erro: 'A senha deve ter ao menos 8 caracteres.' });
        }
        const emailNormalizado = String(email).toLowerCase().trim();
        const nomeNormalizado = String(nome).trim();
        const totalRes = await (0, database_1.query)('SELECT COUNT(*)::int AS total FROM usuarios');
        const primeiroCadastro = (totalRes.rows[0]?.total || 0) === 0;
        if (!primeiroCadastro) {
            const token = extrairTokenDoHeader(req);
            if (!token) {
                return res.status(401).json({ erro: 'Token de autenticação não fornecido.' });
            }
            let payload;
            try {
                payload = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            }
            catch (_err) {
                return res.status(401).json({ erro: 'Token inválido.' });
            }
            if (payload.role !== 'admin') {
                return res.status(403).json({ erro: 'Apenas admin pode cadastrar usuários.' });
            }
        }
        const existente = await (0, database_1.query)('SELECT id FROM usuarios WHERE email = $1 LIMIT 1', [emailNormalizado]);
        if (existente.rows.length > 0) {
            return res.status(409).json({ erro: 'Email já cadastrado.' });
        }
        let roleFinal = String(role || 'vendedor').toLowerCase().trim();
        if (primeiroCadastro) {
            roleFinal = 'admin';
        }
        else if (!ROLES_PERMITIDAS.includes(roleFinal)) {
            return res.status(400).json({ erro: 'Role inválida. Use: admin, gerente ou vendedor.' });
        }
        const senhaHash = await bcryptjs_1.default.hash(String(senha), 12);
        const criado = await (0, database_1.query)(`INSERT INTO usuarios (nome, email, senha_hash, role, ativo)
             VALUES ($1, $2, $3, $4, TRUE)
             RETURNING id, nome, email, role, ativo`, [nomeNormalizado, emailNormalizado, senhaHash, roleFinal]);
        return res.status(201).json({
            mensagem: 'Usuário criado com sucesso.',
            usuario: criado.rows[0]
        });
    }
    catch (err) {
        console.error('[auth/register]', err);
        return res.status(500).json({ erro: 'Erro ao registrar usuário.' });
    }
});
// POST /api/auth/register-vendedor
// Admin cria o acesso de um vendedor ja cadastrado e vincula em vendedores.usuario_id.
router.post('/register-vendedor', auth_1.authMiddleware, (0, auth_1.requireRole)('admin'), async (req, res) => {
    try {
        const { vendedorId, email, senha, nome } = req.body;
        if (!vendedorId || !email || !senha) {
            return res.status(400).json({ erro: 'vendedorId, email e senha são obrigatórios.' });
        }
        if (String(senha).length < 8) {
            return res.status(400).json({ erro: 'A senha deve ter ao menos 8 caracteres.' });
        }
        const vendedorRes = await (0, database_1.query)('SELECT id, nome, usuario_id, ativo FROM vendedores WHERE id = $1', [vendedorId]);
        if (vendedorRes.rows.length === 0) {
            return res.status(404).json({ erro: 'Vendedor não encontrado.' });
        }
        const vendedor = vendedorRes.rows[0];
        if (!vendedor.ativo) {
            return res.status(400).json({ erro: 'Vendedor inativo. Ative o cadastro antes de criar acesso.' });
        }
        if (vendedor.usuario_id) {
            return res.status(409).json({ erro: 'Este vendedor já possui usuário vinculado.' });
        }
        const emailNormalizado = String(email).toLowerCase().trim();
        const nomeFinal = String(nome || vendedor.nome || '').trim();
        if (!nomeFinal) {
            return res.status(400).json({ erro: 'Nome do usuário inválido.' });
        }
        const emailEmUso = await (0, database_1.query)('SELECT id FROM usuarios WHERE email = $1 LIMIT 1', [emailNormalizado]);
        if (emailEmUso.rows.length > 0) {
            return res.status(409).json({ erro: 'Email já cadastrado.' });
        }
        const senhaHash = await bcryptjs_1.default.hash(String(senha), 12);
        const resultado = await (0, database_1.withTransaction)(async (client) => {
            const usuarioCriado = await client.query(`INSERT INTO usuarios (nome, email, senha_hash, role, ativo)
                 VALUES ($1, $2, $3, 'vendedor', TRUE)
                 RETURNING id, nome, email, role, ativo`, [nomeFinal, emailNormalizado, senhaHash]);
            const usuarioId = usuarioCriado.rows[0].id;
            const vinculacao = await client.query('UPDATE vendedores SET usuario_id = $1 WHERE id = $2 AND usuario_id IS NULL', [usuarioId, vendedor.id]);
            if (vinculacao.rowCount !== 1) {
                throw new Error('Não foi possível vincular o usuário ao vendedor.');
            }
            return {
                usuario: usuarioCriado.rows[0],
                vendedor: { id: vendedor.id, nome: vendedor.nome }
            };
        });
        return res.status(201).json({
            mensagem: 'Acesso do vendedor criado e vinculado com sucesso.',
            ...resultado
        });
    }
    catch (err) {
        console.error('[auth/register-vendedor]', err);
        return res.status(500).json({ erro: 'Erro ao criar acesso do vendedor.' });
    }
});
// GET /api/auth/me
router.get('/me', auth_1.authMiddleware, async (req, res) => {
    try {
        const result = await (0, database_1.query)(`SELECT u.id, u.nome, u.email, u.role, u.ultimo_login,
                    v.id AS vendedor_id, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.id = $1`, [req.usuario.id]);
        if (result.rows.length === 0)
            return res.status(404).json({ erro: 'Usuário não encontrado.' });
        res.json(result.rows[0]);
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar dados do usuário.' });
    }
});
// PUT /api/auth/senha
async function alterarSenhaHandler(req, res) {
    try {
        const { senhaAtual, novaSenha } = req.body;
        if (!senhaAtual || !novaSenha || novaSenha.length < 8) {
            return res.status(400).json({ erro: 'Nova senha deve ter ao menos 8 caracteres.' });
        }
        const result = await (0, database_1.query)('SELECT senha_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
        const ok = await bcryptjs_1.default.compare(senhaAtual, result.rows[0].senha_hash);
        if (!ok)
            return res.status(401).json({ erro: 'Senha atual incorreta.' });
        const hash = await bcryptjs_1.default.hash(novaSenha, 12);
        await (0, database_1.query)('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.usuario.id]);
        res.json({ mensagem: 'Senha alterada com sucesso.' });
    }
    catch (err) {
        res.status(500).json({ erro: 'Erro ao alterar senha.' });
    }
}
router.put('/senha', auth_1.authMiddleware, alterarSenhaHandler);
// PATCH /api/auth/trocar-senha
router.patch('/trocar-senha', auth_1.authMiddleware, alterarSenhaHandler);
// PATCH /api/auth/reset-senha-vendedor
// Admin redefine a senha do usuario vinculado a um vendedor.
router.patch('/reset-senha-vendedor', auth_1.authMiddleware, (0, auth_1.requireRole)('admin'), async (req, res) => {
    try {
        const { vendedorId, novaSenha } = req.body;
        if (!vendedorId || !novaSenha) {
            return res.status(400).json({ erro: 'vendedorId e novaSenha são obrigatórios.' });
        }
        if (String(novaSenha).length < 8) {
            return res.status(400).json({ erro: 'A nova senha deve ter ao menos 8 caracteres.' });
        }
        const vendedorRes = await (0, database_1.query)(`SELECT v.id, v.nome, v.usuario_id, u.email
             FROM vendedores v
             LEFT JOIN usuarios u ON u.id = v.usuario_id
             WHERE v.id = $1`, [vendedorId]);
        if (vendedorRes.rows.length === 0) {
            return res.status(404).json({ erro: 'Vendedor não encontrado.' });
        }
        const vendedor = vendedorRes.rows[0];
        if (!vendedor.usuario_id) {
            return res.status(400).json({ erro: 'Vendedor sem usuário vinculado.' });
        }
        const hash = await bcryptjs_1.default.hash(String(novaSenha), 12);
        await (0, database_1.query)('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, vendedor.usuario_id]);
        return res.json({
            mensagem: 'Senha do vendedor redefinida com sucesso.',
            vendedor: {
                id: vendedor.id,
                nome: vendedor.nome,
                email: vendedor.email
            }
        });
    }
    catch (err) {
        console.error('[auth/reset-senha-vendedor]', err);
        return res.status(500).json({ erro: 'Erro ao redefinir senha do vendedor.' });
    }
});
exports.default = router;
