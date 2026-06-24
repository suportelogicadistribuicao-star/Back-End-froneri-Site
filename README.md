# Back-End-froneri-Site

Backend ERP Froneri em Node.js + TypeScript.

## Requisitos

- Node.js 18+
- npm
- MySQL 8+

## Instalação

```bash
npm install
```

## Variáveis de ambiente

Crie um arquivo `.env` na raiz com os campos abaixo:

```env
PORT=8080
NODE_ENV=development

DB_HOST=localhost
DB_PORT=3306
DB_NAME=erp_froneri
DB_USER=root
DB_PASSWORD=sua_senha
DB_SSL=false

JWT_SECRET=troque_este_segredo
JWT_EXPIRES_IN=8h

CORS_ORIGIN=*
UPLOAD_DIR=./uploads
UPLOAD_MAX_SIZE_MB=50
```

## Scripts

- `npm run dev`: inicia em desenvolvimento com `ts-node` + `nodemon`.
- `npm run build`: compila TypeScript para `dist/`.
- `npm start`: executa a versão compilada em `dist/server.js`.
- `npm run migrate`: executa migrações compiladas (quando existirem em `dist/src/scripts`).
- `npm run seed`: executa seed compilado (quando existir em `dist/src/scripts`).

## Fluxo recomendado

### Desenvolvimento

```bash
npm run dev
```

### Produção

```bash
npm run build
npm start
```

## Estrutura principal

```text
server.ts
src/
	app.ts
	config/
		database.ts
		multer.ts
	middleware/
		auth.ts
	routes/
	services/
	types/
```

## Saúde da API

Endpoint de health check:

`GET /api/health`

Retorna status da API e conectividade com o banco.