var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
var import_config = require("dotenv/config");
var import_app = __toESM(require("./src/app"));
const PORT = parseInt(
  process.env.PORT_DIST_SERVER || "21062"
);
async function start() {
  import_app.default.listen(PORT, "0.0.0.0", () => {
    console.log(`[SERVER] ERP Froneri rodando na porta ${PORT}`);
    console.log(`[SERVER] Ambiente: ${process.env.NODE_ENV || "development"}`);
    console.log(`[SERVER] Health: http://localhost:${PORT}/api/health`);
  });
}
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] UnhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[FATAL] UncaughtException:", err);
  process.exit(1);
});
start();
