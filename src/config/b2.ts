import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const B2_ENDPOINT = process.env.B2_ENDPOINT || '';
const B2_REGION = process.env.B2_REGION || '';
const B2_KEY_ID = process.env.B2_KEY_ID || '';
const B2_APPLICATION_KEY = process.env.B2_APPLICATION_KEY || '';

export const B2_BUCKET = process.env.B2_BUCKET_NAME || 'froneri-imports';
export const PRESIGN_EXPIRES_SECONDS = parseInt(process.env.B2_PRESIGN_EXPIRES_SECONDS || '300', 10);

// Um .env que ficou com os placeholders do README (B2_ENDPOINT=https://s3.<sua-regiao>...)
// passa em qualquer teste de "a variável está preenchida?", mas quebra bem depois,
// dentro do SDK, com um ERR_INVALID_URL que não cita nenhum arquivo nosso. Por isso
// validamos FORMATO, e não presença.
const temPlaceholder = (valor: string) => /[<>]/.test(valor);

function endpointValido(url: string): boolean {
    try {
        const u = new URL(url);
        return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
    } catch {
        return false;
    }
}

function diagnosticarConfig(): string[] {
    const problemas: string[] = [];
    const obrigatorias: Array<[string, string]> = [
        ['B2_ENDPOINT', B2_ENDPOINT],
        ['B2_REGION', B2_REGION],
        ['B2_KEY_ID', B2_KEY_ID],
        ['B2_APPLICATION_KEY', B2_APPLICATION_KEY],
        ['B2_BUCKET_NAME', B2_BUCKET],
    ];
    for (const [nome, valor] of obrigatorias) {
        if (!valor) problemas.push(`${nome} está vazia`);
        else if (temPlaceholder(valor)) problemas.push(`${nome} ainda tem o placeholder do exemplo: ${valor}`);
    }
    if (B2_ENDPOINT && !temPlaceholder(B2_ENDPOINT) && !endpointValido(B2_ENDPOINT)) {
        problemas.push(`B2_ENDPOINT não é uma URL válida: ${B2_ENDPOINT}`);
    }
    return problemas;
}

const problemasConfig = diagnosticarConfig();

/** Storage utilizável? Se false, nenhuma operação de foto/import vai funcionar. */
export const B2_CONFIGURADO = problemasConfig.length === 0;

if (!B2_CONFIGURADO) {
    console.warn(
        '[B2] Storage DESATIVADO — as fotos dos cadastros e os imports não vão funcionar.\n' +
        problemasConfig.map((p) => `      • ${p}`).join('\n') +
        '\n      Corrija no .env (veja .env.example) e reinicie o servidor.'
    );
}

const s3Client = new S3Client({
    region: B2_REGION,
    // Endpoint inválido passa batido na construção e só explode no send(), longe
    // daqui. Omitir mantém o cliente construível e deixa o erro sair das funções
    // abaixo, com mensagem nossa.
    endpoint: B2_CONFIGURADO ? B2_ENDPOINT : undefined,
    credentials: {
        accessKeyId: B2_KEY_ID,
        secretAccessKey: B2_APPLICATION_KEY,
    },
});

function exigirConfig(): void {
    if (!B2_CONFIGURADO) {
        throw new Error(`Backblaze B2 não configurado: ${problemasConfig.join('; ')}`);
    }
}

// Sem ContentType no comando assinado: o PUT do cliente não precisa mandar
// o header exato, evitando erro de assinatura por divergência de Content-Type.
async function getPresignedPutUrl(key: string): Promise<string> {
    exigirConfig();
    const command = new PutObjectCommand({ Bucket: B2_BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: PRESIGN_EXPIRES_SECONDS });
}

// URLs de LEITURA das fotos dos cadastros: o front coloca a URL direto em
// <img>/nova aba, sem header Authorization, então a validade precisa cobrir
// a sessão inteira do usuário (padrão 24h; máximo aceito pelo SigV4: 7 dias).
// As URLs são regeradas a cada GET /api/cadastros, então expirar não é fatal.
export const FOTOS_URL_EXPIRES_SECONDS = parseInt(process.env.B2_FOTOS_URL_EXPIRES_SECONDS || '86400', 10);

async function getPresignedGetUrl(key: string): Promise<string> {
    exigirConfig();
    const command = new GetObjectCommand({ Bucket: B2_BUCKET, Key: key });
    return getSignedUrl(s3Client, command, { expiresIn: FOTOS_URL_EXPIRES_SECONDS });
}

export { s3Client, getPresignedPutUrl, getPresignedGetUrl };
