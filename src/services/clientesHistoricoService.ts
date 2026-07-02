import { query } from '../config/database';

// Diz se já existe algum snapshot mensal gravado para o período — usado pelas
// rotas para decidir entre ler de `clientes_historico_mensal` (histórico real
// daquele mês) ou cair no fallback de `clientes` (estado atual), quando o mês
// pedido ainda não tem nenhuma importação registrada nesse formato.
async function hasSnapshotForPeriodo(mes: number, ano: number): Promise<boolean> {
    const r = await query(
        'SELECT 1 FROM clientes_historico_mensal WHERE mes_numero = $1 AND ano = $2 LIMIT 1',
        [mes, ano]
    );
    return r.rows.length > 0;
}

export { hasSnapshotForPeriodo };
