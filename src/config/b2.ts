import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const B2_REGION = process.env.B2_REGION || '';
const B2_KEY_ID = process.env.B2_KEY_ID || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || '';

export const B2_BUCKET = process.env.B2_BUCKET_NAME || 'froneri-imports';
export const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.B2_PRESIGN_EXPIRES_SECONDS || '300', 10);

if (!B2_ENDPOINT || !B2_REGION || !B2_KEY_ID || !B2_APPLICATION_KEY) {
    console.warn('[B2] Configuração incompleta: verifique B2_ENDPOINT, B2_REGION, B2_KEY_ID e B2_APPLICATION_KEY no .env');
}

const s3Client = new S3Client({
    region: B2_REGION,
    endpoint: B2_ENDPOINT,
    credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY,
    },
});

// Sem ContentType no comando assinado: o PUT do cliente não precisa mandar
// o header exato, evitando erro de assinatura por divergência de Content-Type.
async function getPresignedPutUrl(key: string): Promise<string> {
    const command = new PutObjectCommand({ Bucket: B2_BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: PRESIGN_EXPIRES_SECONDS });
}

// URLs de LEITURA das fotos dos cadastros: o front coloca a URL direto em
// <img>/nova aba, sem header Authorization, então a validade precisa cobrir
// a sessão inteira do usuário (padrão 24h; máximo aceito pelo SigV4: 7 dias).
// As URLs são regeradas a cada GET /api/cadastros, então expirar não é fatal.
export const FOTOS_URL_EXPIRES_SECONDS = parseInt(process.env.B2_FOTOS_URL_EXPIRES_SECONDS || '86400', 10);

async function getPresignedGetUrl(key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: B2_BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: FOTOS_URL_EXPIRES_SECONDS });
}

export { s3Client, getPresignedPutUrl, getPresignedGetUrl };
