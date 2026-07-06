var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var app_exports = {};
__export(app_exports, {
  default: () => app_default
});
module.exports = __toCommonJS(app_exports);
var import_config = require("dotenv/config");
var import_express = __toESM(require("express"));
var import_cors = __toESM(require("cors"));
var import_helmet = __toESM(require("helmet"));
var import_express_rate_limit = __toESM(require("express-rate-limit"));
var import_database = require("./config/database");
var import_authRoutes = __toESM(require("./routes/authRoutes"));
var import_clientesRoutes = __toESM(require("./routes/clientesRoutes"));
var import_vendasRoutes = __toESM(require("./routes/vendasRoutes"));
var import_dashboardRoutes = __toESM(require("./routes/dashboardRoutes"));
var import_importRoutes = __toESM(require("./routes/importRoutes"));
var import_vendedoresRoutes = __toESM(require("./routes/vendedoresRoutes"));
var import_rupturaRoutes = __toESM(require("./routes/rupturaRoutes"));
var import_roteirizacaoRoutes = __toESM(require("./routes/roteirizacaoRoutes"));
var import_cadastrosRoutes = __toESM(require("./routes/cadastrosRoutes"));
var import_ticketsRoutes = __toESM(require("./routes/ticketsRoutes"));
var import_devedoresRoutes = __toESM(require("./routes/devedoresRoutes"));
const app = (0, import_express.default)();
app.set("trust proxy", 1);
app.use((req, _res, next) => {
  if (req.url.startsWith("/froneri")) {
    req.url = req.url.replace("/froneri", "") || "/";
  }
  next();
});
app.use((0, import_helmet.default)());
const corsOrigins = (process.env.CORS_ORIGIN || "*").split(",").map((o) => o.trim());
app.use((0, import_cors.default)({
  origin: corsOrigins.includes("*") ? "*" : corsOrigins,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use((0, import_express_rate_limit.default)({
  windowMs: 15 * 60 * 1e3,
  // 15 minutos
  max: 500,
  message: { erro: "Muitas requisi\xE7\xF5es. Tente novamente em 15 minutos." }
}));
app.use("/api/auth", (0, import_express_rate_limit.default)({
  windowMs: 15 * 60 * 1e3,
  max: 20,
  message: { erro: "Muitas tentativas de login." }
}));
app.use(import_express.default.json({ limit: "5mb" }));
app.use(import_express.default.urlencoded({ extended: true, limit: "5mb" }));
app.use("/api", (_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
app.use("/api/auth", import_authRoutes.default);
app.use("/api/dashboard", import_dashboardRoutes.default);
app.use("/api/clientes", import_clientesRoutes.default);
app.use("/api/vendas", import_vendasRoutes.default);
app.use("/api/vendedores", import_vendedoresRoutes.default);
app.use("/api/ruptura", import_rupturaRoutes.default);
app.use("/api/roteirizacao", import_roteirizacaoRoutes.default);
app.use("/api/cadastros", import_cadastrosRoutes.default);
app.use("/api/tickets", import_ticketsRoutes.default);
app.use("/api/devedores", import_devedoresRoutes.default);
app.use("/api/import", import_importRoutes.default);
app.get("/api/health", async (req, res) => {
  const dbOk = await (0, import_database.testConnection)().catch(() => false);
  const status = dbOk ? 200 : 503;
  res.status(status).json({
    status: dbOk ? "ok" : "degraded",
    banco: dbOk ? "conectado" : "desconectado",
    versao: "1.0.0",
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  });
});
app.use((req, res) => {
  res.status(404).json({ erro: `Rota n\xE3o encontrada: ${req.method} ${req.path}` });
});
app.use((err, req, res, _next) => {
  console.error("[API Error]", err.message, err.stack);
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    erro: err.message || "Erro interno do servidor",
    ...process.env.NODE_ENV === "development" && { stack: err.stack }
  });
});
var app_default = app;
