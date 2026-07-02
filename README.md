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
DB_SLOW_QUERY_MS=1500

JWT_SECRET=troque_este_segredo
JWT_EXPIRES_IN=8h

CORS_ORIGIN=*
UPLOAD_DIR=./uploads
UPLOAD_MAX_SIZE_MB=50
UPLOAD_STALE_MINUTES=60

# Backblaze B2 (upload de relatórios via URL pré-assinada)
B2_ENDPOINT=https://s3.us-west-004.backblazeb2.com
B2_REGION=us-west-004
B2_KEY_ID=sua_key_id_b2
B2_APPLICATION_KEY=sua_application_key_b2
B2_BUCKET_NAME=froneri-imports
B2_PRESIGN_EXPIRES_SECONDS=300
```

## Upload de relatórios (Backblaze B2)

Em produção na KingHost, o proxy da hospedagem bloqueia uploads `multipart/form-data` antes que cheguem ao processo Node (nada aparece no log do PM2 mesmo com a requisição correta). Para contornar isso, o upload é feito em duas etapas contra um bucket privado do Backblaze B2 (API S3-compatible), e o backend só faz chamadas de saída (nunca recebe upload direto):

1. `POST /api/import/upload-url` — body `{ "nomeArquivo": "Relatorio.xlsb" }`. Retorna `{ uploadUrl, key, expiresIn }`.
2. O cliente faz `PUT` do arquivo direto para `uploadUrl` (sem header de `Authorization` — a URL assinada já é a credencial).
3. `POST /api/import/confirmar?sync=true|false` — body `{ "key": "..." }`. O backend baixa o arquivo do B2 (GET) e roda a importação normalmente.

A rota antiga `POST /api/import` (multipart, campo `arquivo`) continua disponível apenas para uso local/dev.

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

## Publicacao na KingHost (Node.js)

Configuracao sugerida ao criar a aplicacao no painel:

- Versao do Node.js: `18` ou `20` (LTS)
- Diretorio: pasta onde os arquivos foram enviados (ex.: `app`)
- Arquivo de inicializacao: `dist/server.js`

Consulte `DEPLOY_KINGHOST.md` para o passo a passo completo e checklist de seguranca.

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

{
  "name": "erp-froneri-backend",
  "version": "1.0.0",
  "description": "Backend ERP Froneri - Broker Lógica",
  "main": "server.js",
  "scripts": {
    "build": "node build.mjs",
    "start": "node server.js",
    "dev": "nodemon --watch . --ext ts --exec ts-node --files ./server.ts",
    "migrate": "node dist/src/scripts/migrate.js",
    "seed": "node dist/src/scripts/seed.js"
  },
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.19.2",
    "express-rate-limit": "^7.4.0",
    "express-validator": "^7.2.0",
    "helmet": "^7.1.0",
    "jsonwebtoken": "^9.0.2",
    "multer": "^1.4.5-lts.1",
    "mysql2": "^3.22.5",
    "read-excel-file": "^5.8.4",
    "xlsx": "^0.18.5"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/jsonwebtoken": "^9.0.10",
    "@types/multer": "^2.0.0",
    "@types/node": "^24.0.4",
    "esbuild": "^0.28.1",
    "nodemon": "^3.1.4",
    "ts-node": "^10.9.2",
    "typescript": "^5.9.2"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
