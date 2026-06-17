// ─── Auth Routes ─────────────────────────────────────────────────────────────
const router    = require('express').Router();
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const { query } = require('../config/database');
const { authMiddleware } = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) {
            return res.status(400).json({ erro: 'Email e senha são obrigatórios.' });
        }

        const result = await query(
            `SELECT u.*, v.id AS vendedor_id, v.nome AS vendedor_nome, v.setor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.email = $1 AND u.ativo = TRUE`,
            [email.toLowerCase().trim()]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({ erro: 'Credenciais inválidas.' });
        }

        const usuario = result.rows[0];
        const senhaOk = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaOk) {
            return res.status(401).json({ erro: 'Credenciais inválidas.' });
        }

        // Atualizar último login
        await query('UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1', [usuario.id]);

        const token = jwt.sign(
            {
                id:          usuario.id,
                email:       usuario.email,
                role:        usuario.role,
                nome:        usuario.nome,
                vendedor_id: usuario.vendedor_id || null,
                setor:       usuario.setor || null
            },
            process.env.JWT_SECRET,
            { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
        );

        res.json({
            token,
            usuario: {
                id:           usuario.id,
                nome:         usuario.nome,
                email:        usuario.email,
                role:         usuario.role,
                vendedor_id:  usuario.vendedor_id,
                vendedorNome: usuario.vendedor_nome,
                setor:        usuario.setor
            }
        });
    } catch (err) {
        console.error('[auth/login]', err);
        res.status(500).json({ erro: 'Erro ao fazer login.' });
    }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req, res) => {
    try {
        const result = await query(
            `SELECT u.id, u.nome, u.email, u.role, u.ultimo_login,
                    v.id AS vendedor_id, v.nome AS vendedor_nome, v.setor, v.codigo_vendedor
             FROM usuarios u
             LEFT JOIN vendedores v ON v.usuario_id = u.id
             WHERE u.id = $1`,
            [req.usuario.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ erro: 'Usuário não encontrado.' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao buscar dados do usuário.' });
    }
});

// PUT /api/auth/senha
router.put('/senha', authMiddleware, async (req, res) => {
    try {
        const { senhaAtual, novaSenha } = req.body;
        if (!senhaAtual || !novaSenha || novaSenha.length < 8) {
            return res.status(400).json({ erro: 'Nova senha deve ter ao menos 8 caracteres.' });
        }

        const result = await query('SELECT senha_hash FROM usuarios WHERE id = $1', [req.usuario.id]);
        const ok = await bcrypt.compare(senhaAtual, result.rows[0].senha_hash);
        if (!ok) return res.status(401).json({ erro: 'Senha atual incorreta.' });

        const hash = await bcrypt.hash(novaSenha, 12);
        await query('UPDATE usuarios SET senha_hash = $1 WHERE id = $2', [hash, req.usuario.id]);
        res.json({ mensagem: 'Senha alterada com sucesso.' });
    } catch (err) {
        res.status(500).json({ erro: 'Erro ao alterar senha.' });
    }
});

module.exports = router;
