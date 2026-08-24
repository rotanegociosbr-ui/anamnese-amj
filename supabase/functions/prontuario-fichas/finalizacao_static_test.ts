const migrationUrl = new URL(
  "../../migrations/20260824064000_finalizacao_prontuario_exige_foto.sql",
  import.meta.url,
);
const edgeUrl = new URL("./index.ts", import.meta.url);

const migration = await Deno.readTextFile(migrationUrl);
const edge = await Deno.readTextFile(edgeUrl);

function assertIncludes(source: string, expected: string, label: string): void {
  if (!source.includes(expected)) {
    throw new Error(`${label}: trecho ausente: ${expected}`);
  }
}

function assertMatches(source: string, expected: RegExp, label: string): void {
  if (!expected.test(source)) {
    throw new Error(`${label}: padrão ausente: ${String(expected)}`);
  }
}

function functionBody(start: string, end: string): string {
  const startIndex = migration.indexOf(start);
  const endIndex = migration.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`Não foi possível isolar ${start}.`);
  }
  return migration.slice(startIndex, endIndex);
}

Deno.test("RPC é Edge-only, preparado para os dois papéis clínicos", () => {
  const finalize = functionBody(
    "create or replace function public.prontuario_finalizar(",
    "create or replace function public.prontuario_remover_foto(",
  );
  assertIncludes(
    finalize,
    "array['owner', 'professional']::text[]",
    "papéis permitidos",
  );
  assertMatches(
    migration,
    /revoke all on function public\.prontuario_finalizar\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    "revogação da assinatura exata",
  );
  assertMatches(
    migration,
    /grant execute on function public\.prontuario_finalizar\([\s\S]*?\) to service_role;/,
    "grant exclusivo ao service_role",
  );
});

Deno.test("lote de produto rejeita toda a faixa ASCII de controle", () => {
  assertIncludes(edge, "function containsControlCharacter", "validador explícito");
  assertIncludes(edge, "codePoint <= 0x1f || codePoint === 0x7f", "faixa de controle");
  assertIncludes(
    edge,
    "lotSnapshot.length > 100 || containsControlCharacter(lotSnapshot)",
    "validação do lote",
  );
});

Deno.test("finalização exige versão, consentimento atual e foto clínica ativa", () => {
  const finalize = functionBody(
    "create or replace function public.prontuario_finalizar(",
    "create or replace function public.prontuario_remover_foto(",
  );
  assertIncludes(finalize, "v_protocol.version <> p_expected_version", "versão esperada");
  assertIncludes(finalize, "consent.kind = 'clinical_photography'", "tipo do consentimento");
  assertIncludes(
    finalize,
    "order by consent.recorded_at desc, consent.id desc",
    "evento atual de consentimento",
  );
  assertIncludes(
    finalize,
    "photo.phase in ('before', 'during', 'after')",
    "fases clínicas aceitas",
  );
  assertIncludes(finalize, "photo.archived_at is null", "somente fotos ativas");
  assertIncludes(
    finalize,
    "join storage.objects stored_object",
    "foto clínica precisa ter objeto privado correspondente",
  );
  assertIncludes(
    finalize,
    "stored_object.name = photo.storage_path",
    "objeto precisa corresponder ao caminho registrado",
  );
  if (finalize.includes("products_used")) {
    throw new Error("Foto de produto não pode satisfazer a finalização.");
  }
  assertIncludes(finalize, "clinical_photo_required", "erro sem foto clínica");
});

Deno.test("draft para signed depende de guarda transacional dedicada", () => {
  const guard = functionBody(
    "create or replace function private.prontuario_guard_protocol_mutation()",
    "create or replace function public.prontuario_finalizar(",
  );
  assertIncludes(
    guard,
    "current_setting('amj.prontuario_finalize_guard', true)",
    "leitura da guarda",
  );
  assertIncludes(guard, "new.status <> 'signed'", "único destino permitido");
  assertIncludes(
    guard,
    "'status', 'updated_by', 'updated_at', 'version'",
    "campos exclusivos da transição",
  );
  assertIncludes(
    migration,
    "set_config(\n    'amj.prontuario_finalize_guard', v_guard, true",
    "guarda local à transação",
  );
  assertIncludes(migration, "signed_protocol_is_immutable", "imutabilidade preservada");
});

Deno.test("finalização é auditada e idempotente por operação e por estado", () => {
  const finalize = functionBody(
    "create or replace function public.prontuario_finalizar(",
    "create or replace function public.prontuario_remover_foto(",
  );
  assertIncludes(finalize, "':protocol-finalize:'", "serialização da operação");
  assertIncludes(finalize, "v_previous.action = 'finalize'", "replay pelo request id");
  assertIncludes(finalize, "if v_protocol.status = 'signed' then", "replay por estado");
  const archivedCheck = finalize.indexOf("if v_protocol.archived_at is not null then");
  const signedCheck = finalize.indexOf("if v_protocol.status = 'signed' then");
  if (archivedCheck < 0 || signedCheck < 0 || archivedCheck > signedCheck) {
    throw new Error("Protocolo arquivado precisa ser rejeitado antes do replay por estado.");
  }
  assertIncludes(
    finalize,
    "'protocol', p_protocol_id, 'finalize'",
    "evento de auditoria",
  );
  assertIncludes(finalize, "'target_kind', 'draft_to_signed'", "transição auditada");
});

Deno.test("erro pós-upload nunca apaga path que uma concorrente pode adotar", () => {
  const rpcStart = edge.indexOf('result = await rpc("prontuario_registrar_foto"');
  const catchStart = edge.indexOf("} catch (error) {", rpcStart);
  const catchEnd = edge.indexOf("\n  }\n\n  const registeredPhoto", catchStart);
  if (rpcStart < 0 || catchStart < 0 || catchEnd < 0) {
    throw new Error("Não foi possível isolar a compensação do upload clínico.");
  }
  const recovery = edge.slice(catchStart, catchEnd);
  const lookup = recovery.indexOf("findExistingPhoto(clinicId, protocolId, idempotencyKey)");
  if (lookup < 0) {
    throw new Error("A linha idempotente deve ser reconsultada após erro do RPC.");
  }
  assertIncludes(recovery, "if (committedPhoto)", "ramo de commit recuperado");
  assertIncludes(
    recovery,
    "assertPhotoIdempotencyMatch(committedPhoto, idempotencyExpectation)",
    "SHA e metadados precisam corresponder antes do sucesso recuperado",
  );
  assertIncludes(recovery, "return json(req", "commit recuperado devolve sucesso");
  assertIncludes(
    recovery,
    "const uncertainResult = !(error instanceof ApiError)",
    "erro de transporte precisa ser distinguido de rollback HTTP",
  );
  assertIncludes(
    recovery,
    "if (uncertainResult || !lookupConclusive)",
    "resultado incerto não pode entrar na compensação destrutiva",
  );
  assertIncludes(
    recovery,
    'error.code === "backend_error" || error.status >= 500',
    "gateway/5xx também é resultado incerto",
  );
  if (recovery.includes("deletePrivateImage(")) {
    throw new Error("Nenhum erro pós-upload pode apagar path idempotente concorrente.");
  }
  assertIncludes(
    recovery,
    "Nunca removemos o objeto publicado aqui",
    "órfão privado deve ser preferido a metadado clínico fantasma",
  );
});

Deno.test("falha de miniatura não apaga original já publicado", () => {
  const uploadStart = edge.indexOf(
    "const uploadResponse = await uploadPrivateImage(storagePath, file)",
  );
  const rpcStart = edge.indexOf('result = await rpc("prontuario_registrar_foto"', uploadStart);
  if (uploadStart < 0 || rpcStart < 0) throw new Error("Não foi possível isolar uploads.");
  const uploadFlow = edge.slice(uploadStart, rpcStart);
  if (uploadFlow.includes("deletePrivateImage(storagePath)")) {
    throw new Error("Falha de miniatura não pode apagar original adotável por concorrente.");
  }
});

Deno.test("retry de upload reconcilia objeto exato e usa um presenter estável", () => {
  assertIncludes(edge, "async function privateImageMatches(", "leitura privada para reconciliação");
  assertIncludes(edge, "await sha256Hex(storedBytes) === sha256", "comparação SHA-256");
  assertIncludes(edge, 'objectState === "match"', "adoção do objeto órfão exato");
  assertIncludes(edge, "async function presentStoredPhoto(", "presenter único");
  if ((edge.match(/async function presentStoredPhoto\(/g) || []).length !== 1) {
    throw new Error("Deve existir exatamente um presenter de sucesso/replay de foto.");
  }
  for (
    const field of [
      "thumbnailStoragePath",
      "thumbnailMimeType",
      "thumbnailSizeBytes",
      "thumbnailSha256",
      "attendanceId",
      "procedureItemId",
      "confirmDistinct",
    ]
  ) {
    assertIncludes(edge, `expected.${field}`, `idempotência completa: ${field}`);
  }
  if (
    edge.includes("expected.duplicateOperationId") ||
    edge.includes("expected.duplicateReason")
  ) {
    throw new Error("Prova/motivo de duplicidade não são conteúdo material do replay.");
  }
  assertIncludes(
    edge,
    "Boolean(existing.duplicate_confirmed_at) !== expected.confirmDistinct",
    "retry sem confirmação não pode corresponder a linha confirmada",
  );
});

Deno.test("última foto clínica de prontuário signed não pode ser arquivada", () => {
  const removePhoto = functionBody(
    "create or replace function public.prontuario_remover_foto(",
    "create or replace function public.prontuario_alterar_consentimento_fotografia(",
  );
  assertIncludes(removePhoto, "for update;", "bloqueio do protocolo");
  assertIncludes(removePhoto, "v_protocol_status = 'signed'", "estado protegido");
  assertIncludes(
    removePhoto,
    "v_photo.phase in ('before', 'during', 'after')",
    "alvo clínico",
  );
  assertIncludes(
    removePhoto,
    "photo.phase in ('before', 'during', 'after')",
    "contagem clínica",
  );
  assertIncludes(
    removePhoto,
    "join storage.objects stored_object",
    "metadado órfão não protege a remoção da última foto real",
  );
  assertIncludes(
    removePhoto,
    "last_clinical_photo_required",
    "erro da última foto",
  );
});

Deno.test("consentimento fotográfico segue alterável e revogável após assinatura", () => {
  const consentRpc = functionBody(
    "create or replace function public.prontuario_alterar_consentimento_fotografia(",
    "-- RPCs publicos, mas Edge-only",
  );
  assertIncludes(consentRpc, "array['owner']::text[]", "somente owner no banco");
  assertIncludes(consentRpc, "v_protocol.status not in ('draft', 'signed')", "estados permitidos");
  assertIncludes(
    consentRpc,
    "private.prontuario_append_consents",
    "histórico append-only existente",
  );
  assertIncludes(consentRpc, "'clinical_photography'", "único tipo alterável");
  assertIncludes(consentRpc, "'consent.clinical_photography'", "auditoria técnica");
  if (/\b(reason|motivo)\b/i.test(consentRpc)) {
    throw new Error("RPC de consentimento não pode copiar motivo livre para a auditoria.");
  }
  assertMatches(
    migration,
    /revoke all on function public\.prontuario_alterar_consentimento_fotografia\([\s\S]*?\) from public, anon, authenticated, service_role;/,
    "revogação do RPC de consentimento",
  );
  assertMatches(
    migration,
    /grant execute on function public\.prontuario_alterar_consentimento_fotografia\([\s\S]*?\) to service_role;/,
    "grant Edge-only do consentimento",
  );
  assertIncludes(edge, '"prontuario.consent.clinical_photography"', "prova recente dedicada");
  assertIncludes(edge, 'rpc("prontuario_alterar_consentimento_fotografia"', "chamada dedicada");
  assertIncludes(edge, 'case "alterar_consentimento_fotografia":', "roteamento dedicado");
});

Deno.test("Edge expõe action finalizar, erros claros e retorno estável", () => {
  assertIncludes(edge, 'allowedRoles: ["owner"]', "gate owner-only preservado");
  assertIncludes(edge, '"prontuario.finalize"', "prova recente dedicada");
  assertIncludes(edge, 'rpc("prontuario_finalizar"', "chamada RPC");
  assertIncludes(edge, 'case "finalizar":', "roteamento");
  assertIncludes(edge, "clinical_photo_required:", "mensagem sem foto");
  assertIncludes(edge, "last_clinical_photo_required:", "mensagem da última foto");
  assertMatches(
    edge,
    /protocolo_id: result\.id,[\s\S]*?status: "signed",[\s\S]*?versao: result\.version,[\s\S]*?finalizado: true,[\s\S]*?idempotente:/,
    "contrato de resposta",
  );
});
