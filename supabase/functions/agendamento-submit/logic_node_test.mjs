import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_BODY_BYTES,
  normalizeIdentity,
  normalizePhone,
  normalizeSubmission,
  readJsonBody,
  SubmissionError,
} from "./logic.ts";

const now = new Date("2026-08-29T15:00:00.000Z");
const payload = () => ({
  idempotency_key: "22222222-2222-4222-8222-222222222222",
  started_at: "2026-08-29T14:59:55.000Z",
  website: "",
  nome: "Ana Maria Jacob",
  telefone: "(31) 99584-4803",
  primeira_visita: "primeira_avaliacao",
  interesse: "avaliacao_sem_procedimento",
  data_preferida: "2026-08-30",
  periodo: "manha",
  consentimento_contato: true,
});

test("normalização de identidade e telefone coincide com contrato SQL", () => {
  assert.equal(normalizeIdentity("  Ana Mária-Jacob  "), "anamariajacob");
  assert.equal(normalizePhone("+55 (31) 99584-4803"), "+5531995844803");
});

test("normalização pública mantém apenas allowlist e hashes SHA-256", async () => {
  const result = await normalizeSubmission(payload(), now);
  assert.equal(result.interest, "avaliacao_sem_procedimento");
  assert.match(result.payloadSha256, /^[a-f0-9]{64}$/);
  assert.match(result.dedupSha256, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result, "objetivo"), false);
});

test("campos extras e objetivo são recusados, não silenciosamente persistidos", async () => {
  await assert.rejects(
    () => normalizeSubmission({ ...payload(), objetivo: "não armazenar" }, now),
    (error) => error instanceof SubmissionError && error.code === "unexpected_field",
  );
});

test("limite real do corpo é 8KB", async () => {
  const request = new Request("https://edge.test", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(MAX_BODY_BYTES + 1) }),
  });
  await assert.rejects(
    () => readJsonBody(request),
    (error) => error instanceof SubmissionError && error.code === "body_too_large",
  );
});
