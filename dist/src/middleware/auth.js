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
var auth_exports = {};
__export(auth_exports, {
  authMiddleware: () => authMiddleware,
  ownDataOnly: () => ownDataOnly,
  requireRole: () => requireRole
});
module.exports = __toCommonJS(auth_exports);
var import_jsonwebtoken = __toESM(require("jsonwebtoken"));
const JWT_SECRET = process.env.JWT_SECRET;
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ erro: "Token de autentica\xE7\xE3o n\xE3o fornecido." });
  }
  const token = header.split(" ")[1];
  try {
    const payload = import_jsonwebtoken.default.verify(token, JWT_SECRET);
    req.usuario = payload;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ erro: "Token expirado. Fa\xE7a login novamente." });
    }
    return res.status(401).json({ erro: "Token inv\xE1lido." });
  }
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ erro: "N\xE3o autenticado." });
    if (!roles.includes(req.usuario.role)) {
      return res.status(403).json({ erro: "Acesso negado. Permiss\xE3o insuficiente." });
    }
    next();
  };
}
function ownDataOnly(req, res, next) {
  if (["admin", "gerente"].includes(req.usuario?.role)) return next();
  if (req.usuario?.vendedor_id) {
    req.filtroVendedor = req.usuario.vendedor_id;
  }
  next();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  authMiddleware,
  ownDataOnly,
  requireRole
});
