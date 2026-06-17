import 'express-serve-static-core';

declare module 'express-serve-static-core' {
  interface Request {
    usuario?: {
      id?: number | string;
      email?: string;
      role?: string;
      vendedor_id?: number | string | null;
      setor?: string | null;
      [key: string]: unknown;
    };
    filtroVendedor?: number | string;
  }
}

export {};
