"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/handler/secret-watcher.ts
var secret_watcher_exports = {};
__export(secret_watcher_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(secret_watcher_exports);
var import_node_crypto = require("node:crypto");
var import_client_secrets_manager = require("@aws-sdk/client-secrets-manager");
var import_client_ssm = require("@aws-sdk/client-ssm");
var ssm = new import_client_ssm.SSMClient({});
var sm = new import_client_secrets_manager.SecretsManagerClient({});
function assertNever(x) {
  throw new Error(`Unreachable: unexpected Kind ${JSON.stringify(x)}`);
}
async function resolveVersion(kind, targetId) {
  switch (kind) {
    case "ssm": {
      const res = await ssm.send(
        new import_client_ssm.GetParameterCommand({ Name: targetId, WithDecryption: false })
      );
      return String(res.Parameter?.Version);
    }
    case "secretsmanager": {
      const res = await sm.send(new import_client_secrets_manager.DescribeSecretCommand({ SecretId: targetId }));
      const current = Object.entries(res.VersionIdsToStages ?? {}).find(
        ([, stages]) => stages.includes("AWSCURRENT")
      );
      if (!current) throw new Error(`AWSCURRENT version not found: ${targetId}`);
      return current[0];
    }
    default:
      return assertNever(kind);
  }
}
var handler = async (event) => {
  const props = event.ResourceProperties;
  const physicalResourceId = props.TargetId;
  if (event.RequestType === "Delete") {
    console.log(JSON.stringify({ RequestType: event.RequestType, physicalResourceId }));
    return {};
  }
  const version = await resolveVersion(props.Kind, props.TargetId);
  const hash = (0, import_node_crypto.createHash)("sha256").update(`${physicalResourceId}:${version}`).digest("hex").slice(0, 32);
  console.log(
    JSON.stringify({
      RequestType: event.RequestType,
      physicalResourceId,
      Nonce: props.Nonce,
      hash
    })
  );
  return { PhysicalResourceId: physicalResourceId, Data: { Hash: hash } };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
