/** Owned, dependency-injected Codex policy. No runtime host imports, auth or I/O. */
import { REPORTED_SERVICE_TIERS, SPEED_TIERS, requestedServiceTier } from './policy.js';
import { digest } from './compaction/checkpoint.js';
const lateContractError=()=>Object.assign(Error('Cloud checkpoint no longer matches the prepared request. Disable cloud compaction and retry with full history.'),{code:'CLOUD_LATE_CONTRACT_CHANGED'});
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
export const CODEX_PAYLOAD_REVISION = 5;
const TIERS = new Set(REPORTED_SERVICE_TIERS);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SCOPES = new Set(["session", "subagent-default", "route-default", "default"]);
const TERMINALS = new Set(["response.done", "response.completed", "response.incomplete"]);

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(name + " must be a function");
}

function guardModel(model) {
  if (!model || model.provider !== "openai-codex" ||
      (model.api !== undefined && model.api !== "openai-codex-responses")) {
    throw new Error("Codex native wrapper requires the native openai-codex route");
  }
  // Exact strings also reject credentials, query/fragment, alternate ports, encodings
  // and normalization tricks. These are the three forms native resolveCodexUrl uses.
  if (model.baseUrl !== undefined && model.baseUrl !== "" &&
      (typeof model.baseUrl !== "string" ||
       !["https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex", ENDPOINT]
         .includes(model.baseUrl.replace(/\/+$/, "")))) {
    throw new Error("Codex native endpoint must be the official ChatGPT endpoint");
  }
}

function safeModelId(model) {
  return typeof model.id === "string" && /^[a-zA-Z0-9._-]{1,100}$/.test(model.id)
    ? model.id : "redacted";
}

function policySnapshot(snapshot) {
  if (snapshot && typeof snapshot.then === "function") {
    // Synchronous stream factories cannot await a policy without changing their API.
    void Promise.resolve(snapshot).catch(() => {});
    throw new TypeError("snapshotSpeed must return a synchronous policy");
  }
  if (!snapshot || !SPEED_TIERS.includes(snapshot.tier)) {
    throw new Error("Codex speed policy must explicitly select standard, fast or ultrafast");
  }
  return Object.freeze({
    tier: snapshot.tier,
    scope: SCOPES.has(snapshot.scope) ? snapshot.scope : "other",
  });
}

function payloadWithPolicy(payload, policy) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(payload)) ||
      typeof payload.toJSON === "function") {
    throw new TypeError("Codex onPayload must produce a plain JSON object");
  }
  // Do not mutate the caller's replacement (which may be frozen or shared).
  const next = { ...payload };
  // The ChatGPT Codex endpoint rejects sampling temperature (including 0 from AutoReview).
  // Enforce endpoint compatibility after every caller hook, without changing its options/history.
  delete next.temperature;
  const tier = requestedServiceTier(policy.tier);
  if (tier !== null) next.service_tier = tier;
  else delete next.service_tier;
  return next;
}

/**
 * Repair only existing native thinking blocks with an exact matching item ID.
 * Terminal-only blocks are never synthesized: they fail closed because no safe
 * native content index exists. No index fallback, ciphertext logs or history I/O.
 */
export function settleNativeReplay(message, terminalSignatures) {
  if (!message || message.stopReason === "error" || message.stopReason === "aborted" ||
      !Array.isArray(message.content)) return message;
  const matched = new Set();
  for (const block of message.content) {
    if (block.type !== "thinking" || typeof block.thinkingSignature !== "string") continue;
    let item;
    try { item = JSON.parse(block.thinkingSignature); } catch { continue; }
    if (item?.type !== "reasoning" || typeof item.id !== "string") continue;
    const authoritative = terminalSignatures.get(item.id);
    if (authoritative !== undefined) {
      if (matched.has(item.id)) throw new Error("REPLAY_TERMINAL_MISMATCH: duplicate native reasoning item ID");
      matched.add(item.id);
      block.thinkingSignature = authoritative;
    }
  }
  if (matched.size !== terminalSignatures.size) {
    throw new Error("REPLAY_TERMINAL_MISMATCH: terminal reasoning has no matching native block");
  }
  return message;
}

function decorateStream(stream, signatures) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== "function" ||
      typeof stream.result !== "function") {
    throw new TypeError("Native provider must return an assistant event stream");
  }
  let resultPromise;
  const result = () => resultPromise ??= Promise.resolve(stream.result())
    .then(message => settleNativeReplay(message, signatures));
  const iterate = () => {
    const iterator = stream[Symbol.asyncIterator]();
    const forward = async (method, value) => {
      const step = await iterator[method](value);
      try {
        if (!step.done && step.value?.type === "done") {
          settleNativeReplay(step.value.message, signatures);
        }
      } catch (error) {
        await iterator.return?.();
        throw error;
      }
      return step;
    };
    return {
      next: value => forward("next", value),
      ...(typeof iterator.return === "function" ? { return: value => forward("return", value) } : {}),
      ...(typeof iterator.throw === "function" ? { throw: value => forward("throw", value) } : {}),
      [Symbol.asyncIterator]() { return this; },
    };
  };
  return new Proxy(stream, {
    get(target, key) {
      if (key === "result") return result;
      if (key === Symbol.asyncIterator) return iterate;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * nativeProvider: openaiCodexProvider() from the bundled runtime, injected by owner.
 * snapshotSpeed({sessionId, model}): synchronous {tier, scope?}; throws for
 * unsupported/unknown Fast capability. Entitlement is owned by that policy source,
 * never inferred here from a static model catalog. Called once per streamSimple.
 * recordEvidence(evidence): optional sync/async strict-allowlist sink. Its failures,
 * like existing hook failures, propagate and abort the native request/stream.
 * Only streamSimple is wrapped; all other native provider behavior is retained.
 */
export function createCodexNativeProvider({ nativeProvider, snapshotSpeed, snapshotCloud = () => null, observeHttpStatus, recordEvidence = () => {} }) {
  if (!nativeProvider || typeof nativeProvider.streamSimple !== "function") {
    throw new TypeError("nativeProvider.streamSimple is required");
  }
  requireFunction(snapshotSpeed, "snapshotSpeed");
  requireFunction(recordEvidence, "recordEvidence");
  if (observeHttpStatus !== undefined) requireFunction(observeHttpStatus, "observeHttpStatus");
  let invocation = 0;
  return {
    ...nativeProvider,
    streamSimple(model, context, options = {}) {
      guardModel(model);
      const policy = policySnapshot(snapshotSpeed({ sessionId: options.sessionId, model }));
      const cloud=snapshotCloud();
      const finalPayloads=cloud?new WeakMap():null;
      const checksum=value=>{try{return digest(value);}catch{return null;}};
      const signatures = new Map(); // Private to this invocation; never persisted/logged.
      const requestId = ++invocation;
      const modelId = safeModelId(model);
      const common = Object.freeze({
        requestId, provider: "openai-codex", model: modelId,
        selectedTier: policy.tier, requestedTier: requestedServiceTier(policy.tier),
        scope: policy.scope,
      });
      let headers;
      if (policy.tier === "ultrafast") {
        if (modelId !== model.id) throw new Error("Invalid Codex model ID for Ultrafast");
        // Body is authoritative; the official Codex client keeps this routing
        // hint aligned with the request on the same ChatGPT endpoint.
        const prepared = new Headers(options.headers);
        prepared.set("x-codex-routing-hint", `model=${modelId};tier=ultrafast`);
        headers = Object.fromEntries(prepared);
      }
      const priorPayload = options.onPayload;
      const priorEvent = options.onProviderStreamEvent;
      const priorResponse = options.onResponse;
      if (priorPayload !== undefined) requireFunction(priorPayload, "onPayload");
      if (priorEvent !== undefined) requireFunction(priorEvent, "onProviderStreamEvent");
      if (observeHttpStatus && priorResponse != null) requireFunction(priorResponse, "onResponse");
      const wrappedOptions = {
        ...options,
        ...(headers ? { headers } : {}),
        ...(observeHttpStatus ? { onResponse(response, nativeModel) {
          // Preserve just the HTTP status across Pi's friendly-error normalization.
          if (Number.isInteger(response?.status)) observeHttpStatus(response.status);
          return priorResponse?.call(options, response, nativeModel);
        } } : {}),
        async onPayload(payload, nativeModel) {
          let prepared;
          try {
            if(finalPayloads?.has(payload)) {
              const verified=finalPayloads.get(payload);
              if(verified===null||checksum(payload)!==verified)throw lateContractError();
              prepared=payload;
            } else {
              const contract=cloud?.before(payload);
              const replacement=await priorPayload?.call(options,payload,nativeModel);
              prepared=replacement===undefined?payload:replacement;
              if(cloud)prepared=cloud.prepare(prepared,contract);
            }
          } catch(error) {
            if(cloud&&error?.code==='CLOUD_LATE_CONTRACT_CHANGED')cloud.lateFailure={code:error.code,message:error.message};
            throw error;
          }
          const next = payloadWithPolicy(prepared, policy);
          guardModel(model); // Also reject endpoint mutation by an earlier hook.
          if (policy.tier === 'ultrafast' && (modelId !== model.id || modelId !== next.model)) {
            throw new Error('Codex payload model does not match the checked Ultrafast model');
          }
          // Count only final payload item types; never expose item identifiers,
          // content, ciphertext, lengths or digests through diagnostics.
          let replayReasoningItems = 0;
          let replayEncryptedReasoningItems = 0;
          let toolResultItems = 0;
          if (Array.isArray(next.input)) {
            for (const item of next.input) {
              if (item?.type === "reasoning") {
                replayReasoningItems++;
                if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
                  replayEncryptedReasoningItems++;
                }
              } else if (item?.type === "function_call_output") {
                toolResultItems++;
              }
            }
          }
          await recordEvidence(Object.freeze({
            ...common, phase: "request-policy", endpoint: ENDPOINT,
            // Hook runs before transport selection/compression, NOT proof of send.
            boundary: "native-onPayload-before-serialization",
            transport: ["sse", "websocket", "websocket-cached", "auto"].includes(options.transport)
              ? options.transport : "auto",
            serviceTierPresent: Object.hasOwn(next, "service_tier"),
            serviceTier: next.service_tier ?? null,
            reasoningEffort: EFFORTS.has(next.reasoning?.effort) ? next.reasoning.effort : null,
            store: typeof next.store === "boolean" ? next.store : null,
            includesEncryptedReasoning: Array.isArray(next.include) && next.include.includes("reasoning.encrypted_content"),
            replayReasoningItems, replayEncryptedReasoningItems, toolResultItems,
          }));
          if(finalPayloads)finalPayloads.set(next,checksum(next));
          return next;
        },
        async onProviderStreamEvent(event, nativeModel) {
          cloud?.observe(event);
          if (TERMINALS.has(event?.type)) {
            const response = event.response;
            const nextSignatures = new Map();
            const ids = new Set();
            let reasoningItems = 0;
            if (Array.isArray(response?.output)) {
              for (const item of response.output) {
                if (item?.type !== "reasoning") continue;
                reasoningItems++;
                if (typeof item.id !== "string" || !item.id) {
                  if (item.encrypted_content) throw new Error("REPLAY_TERMINAL_MISMATCH: missing terminal reasoning item ID");
                  continue;
                }
                if (ids.has(item.id)) throw new Error("Duplicate terminal reasoning item ID");
                ids.add(item.id);
                if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) {
                  nextSignatures.set(item.id, JSON.stringify(item));
                }
              }
            }
            // Capture raw server fields BEFORE user callbacks or native pricing.
            const raw = response?.service_tier;
            await recordEvidence(Object.freeze({
              ...common, phase: "response-terminal", eventType: event.type,
              rawReportedTierPresent: Object.hasOwn(response ?? {}, "service_tier"),
              rawReportedTier: typeof raw === "string" && TIERS.has(raw) ? raw : null,
              rawReportedTierRecognized: typeof raw === "string" && TIERS.has(raw),
              reasoningItems, terminalSignatures: nextSignatures.size,
            }));
            signatures.clear();
            for (const [id, signature] of nextSignatures) signatures.set(id, signature);
          }
          return await priorEvent?.call(options, event, nativeModel);
        },
      };
      return decorateStream(nativeProvider.streamSimple(model, context, wrappedOptions), signatures);
    },
  };
}
