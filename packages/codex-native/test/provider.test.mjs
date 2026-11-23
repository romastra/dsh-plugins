import test from "node:test";
import assert from "node:assert/strict";
import { createCodexNativeProvider, settleNativeReplay } from "../src/provider.js";

const model = () => ({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-6.1-sol", baseUrl: "https://chatgpt.com/backend-api" });
const body = () => ({ model: "gpt-6.1-sol", store: false, include: ["reasoning.encrypted_content"], reasoning: { effort: "max", summary: "auto" }, input: [{ type: "reasoning", encrypted_content: "SECRET-CIPHER" }] });
const item = (id, cipher) => ({ type: "reasoning", id, summary: [], encrypted_content: cipher });
const message = (...items) => ({ stopReason: "stop", content: items.map(value => ({ type: "thinking", thinking: "summary", thinkingSignature: JSON.stringify(value) })) });

// Model the documented native seams, not an alternate transport implementation:
// await onPayload, honor undefined/replacement, then serialize shared SSE/WS body;
// await onProviderStreamEvent before native terminal processing and final done.
class FakeStream {
  constructor(work) {
    this.events = [];
    this.closed = false;
    this.work = Promise.resolve().then(() => work(this.events));
    this.work.catch(() => {});
  }
  result() { return this.work; }
  marker() { return this; }
  async *[Symbol.asyncIterator]() {
    // Native EventStream yields individual queued events (not yield* an Array).
    // Array delegation lacks throw() and replaces consumer errors with TypeError.
    try {
      await this.work;
      for (const event of this.events) yield event;
    } finally { this.closed = true; }
  }
}
function fixture({ snapshotSpeed = () => ({ tier: "standard" }), recordEvidence, payload = body, terminal, finalMessage = () => message(), eventType = "response.completed" } = {}) {
  const calls = [];
  const outbound = [];
  const nativeProvider = {
    id: "openai-codex", stream() { return "unchanged low-level"; },
    streamSimple(nativeModel, context, options) {
      const call = { model: nativeModel, context, options };
      calls.push(call);
      call.stream = new FakeStream(async events => {
        let request = payload();
        const replacement = await options.onPayload(request, nativeModel);
        if (replacement !== undefined) request = replacement;
        outbound.push({ sse: JSON.parse(JSON.stringify(request)), ws: JSON.parse(JSON.stringify({ type: "response.create", ...request })) });
        const output = finalMessage();
        if (terminal) await options.onProviderStreamEvent({ type: eventType, response: terminal() }, nativeModel);
        events.push({ type: "start", partial: output }, { type: output.stopReason === "error" || output.stopReason === "aborted" ? "error" : "done", message: output, error: output });
        return output;
      });
      return call.stream;
    },
  };
  return { provider: createCodexNativeProvider({ nativeProvider, snapshotSpeed, recordEvidence }), calls, outbound, nativeProvider };
}

test("standard-fast-standard reaches the common SSE/WS serialization body without changing reasoning/model/store/include", async () => {
  let tier = "standard";
  const evidence = [];
  const f = fixture({ snapshotSpeed: () => ({ tier }), recordEvidence: e => evidence.push(e) });
  for (tier of ["standard", "fast", "standard"]) {
    await f.provider.streamSimple(model(), {}, { transport: "sse", serviceTier: "priority" }).result();
  }
  assert.deepEqual(f.outbound.map(v => v.sse.service_tier), [undefined, "priority", undefined]);
  for (const entry of f.outbound) {
    const { service_tier, ...rest } = entry.sse;
    assert.deepEqual(rest, body());
    const { type, ...ws } = entry.ws;
    assert.equal(type, "response.create");
    assert.deepEqual(ws, entry.sse);
  }
  assert.deepEqual(evidence.map(e => e.serviceTierPresent), [false, true, false]);
  assert.equal(evidence[1].boundary, "native-onPayload-before-serialization");
  assert.equal(f.provider.stream, f.nativeProvider.stream);
});

test("request evidence counts only final payload reasoning/encrypted replay and function tool outputs without leakage", async () => {
  const evidence = [];
  const input = [
    { type: "reasoning", id: "SECRET-ITEM-ID", encrypted_content: "SECRET-CIPHER", summary: [{ text: "SECRET-SUMMARY" }] },
    { type: "reasoning", encrypted_content: "" },
    { type: "reasoning" },
    { type: "reasoning", encrypted_content: { value: "SECRET-NOT-STRING" } },
    { type: "reasoning", encrypted_content: "second-SECRET-CIPHER" },
    { type: "function_call_output", call_id: "SECRET-CALL-ID", output: "SECRET-TOOL-OUTPUT" },
    { type: "function_call_output", output: [{ text: "SECRET-TOOL-TEXT" }] },
    { type: "custom_tool_call_output", output: "SECRET-CUSTOM-OUTPUT" },
    { type: "message", content: "SECRET-TEXT", encrypted_content: "SECRET-NOT-REASONING" },
    null, false, "SECRET-STRING",
  ];
  const f = fixture({ recordEvidence: e => evidence.push(e) });
  await f.provider.streamSimple(model(), {}, { async onPayload(value) { return { ...value, input }; } }).result();
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].replayReasoningItems, 5);
  assert.equal(evidence[0].replayEncryptedReasoningItems, 2);
  assert.equal(evidence[0].toolResultItems, 2);
  assert.equal(Object.isFrozen(evidence[0]), true);
  assert.deepEqual(Object.keys(evidence[0]).sort(), [
    "requestId", "provider", "model", "selectedTier", "requestedTier", "scope", "phase", "endpoint", "boundary", "transport", "serviceTierPresent", "serviceTier", "reasoningEffort", "store", "includesEncryptedReasoning", "replayReasoningItems", "replayEncryptedReasoningItems", "toolResultItems",
  ].sort());
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET|call_id|encrypted_content|summary|cipher|hash|digest/);
  assert.deepEqual(f.outbound[0].sse.input, input);
});

test("request evidence replay counts default to zero for missing/non-array input", async () => {
  for (const input of [undefined, null, "SECRET-NON-ARRAY", {}, []]) {
    const evidence = [];
    const f = fixture({ payload: () => ({ ...body(), input }), recordEvidence: e => evidence.push(e) });
    await f.provider.streamSimple(model(), {}).result();
    assert.equal(evidence[0].replayReasoningItems, 0);
    assert.equal(evidence[0].replayEncryptedReasoningItems, 0);
    assert.equal(evidence[0].toolResultItems, 0);
    assert.doesNotMatch(JSON.stringify(evidence), /SECRET/);
  }
});

test("snapshot is once per invocation, isolated across sessions, frozen across delay/retries/tool continuations", async () => {
  const choices = new Map([["parent", { tier: "fast", scope: "session" }], ["child", { tier: "standard", scope: "subagent-default" }]]);
  const seen = [];
  const f = fixture({ snapshotSpeed(args) { seen.push(args); return choices.get(args.sessionId); } });
  const m = model();
  const parent = f.provider.streamSimple(m, {}, { sessionId: "parent" });
  const child = f.provider.streamSimple(m, {}, { sessionId: "child" });
  choices.get("parent").tier = "standard";
  await Promise.all([parent.result(), child.result()]);
  assert.deepEqual(f.outbound.map(v => v.sse.service_tier), ["priority", undefined]);
  // Repeated onPayload calls for this original invocation retain the frozen choice.
  for (let i = 0; i < 2; i++) assert.equal((await f.calls[0].options.onPayload(body(), m)).service_tier, "priority");
  await f.provider.streamSimple(m, { messages: [{ role: "toolResult" }] }, { sessionId: "parent" }).result();
  assert.equal(f.outbound[2].sse.service_tier, undefined);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].model, m);
  assert.equal(seen[1].sessionId, "child");
});

test("all options/context/model and non-policy provider behavior are preserved", async () => {
  const m = model(); const context = { messages: [] }; const signal = new AbortController().signal;
  const options = { signal, reasoning: "max", toolChoice: "auto", headers: { custom: "value" }, onResponse() {}, maxTokens: 42, temperature: 0.2, metadata: { hello: true }, fetch() {}, transport: "sse", timeoutMs: 1000 };
  const f = fixture();
  await f.provider.streamSimple(m, context, options).result();
  assert.equal(f.calls[0].model, m); assert.equal(f.calls[0].context, context);
  for (const [key, value] of Object.entries(options)) assert.equal(f.calls[0].options[key], value);
  assert.equal(options.onPayload, undefined);
});

for (const asyncHook of [false, true]) {
  for (const returnsReplacement of [false, true]) {
    test("onPayload mutation/replacement semantics; async=" + asyncHook + " replacement=" + returnsReplacement, async () => {
      const f = fixture({ snapshotSpeed: () => ({ tier: "fast" }) });
      const m = model();
      function hook(value, hookModel) {
        assert.equal(hookModel, m); assert.equal(this, options);
        value.custom = "mutation"; value.service_tier = "flex";
        const replacement = returnsReplacement ? Object.freeze({ ...value, custom: "replacement", service_tier: "default" }) : undefined;
        return asyncHook ? Promise.resolve(replacement) : replacement;
      }
      const options = { onPayload: hook };
      await f.provider.streamSimple(m, {}, options).result();
      assert.equal(f.outbound[0].sse.custom, returnsReplacement ? "replacement" : "mutation");
      assert.equal(f.outbound[0].sse.service_tier, "priority");
    });
  }
}

test("Codex always removes unsupported temperature after caller mutation/replacement for AutoReview and ordinary calls", async () => {
  for (const tier of ["standard", "fast"]) for (const temperature of [0, 0.2, 1, null]) {
    const request = Object.freeze({ ...body(), temperature });
    const f = fixture({ snapshotSpeed: () => ({ tier }), payload: () => request });
    const options = Object.freeze({ temperature, async onPayload(value) { return Object.freeze({ ...value, temperature }); } });
    await f.provider.streamSimple(model(), {}, options).result();
    const sent = f.outbound[0];
    assert.equal(Object.hasOwn(sent.sse, "temperature"), false);
    assert.equal(Object.hasOwn(sent.ws, "temperature"), false);
    assert.equal(request.temperature, temperature);
    assert.equal(options.temperature, temperature);
    assert.equal(sent.sse.reasoning.effort, "max");
    assert.deepEqual(sent.sse.input, request.input);
    assert.equal(sent.sse.service_tier, tier === "fast" ? "priority" : undefined);
  }
});

test("standard policy deletes priority after an existing async replacement hook", async () => {
  const f = fixture();
  await f.provider.streamSimple(model(), {}, { async onPayload(value) { return { ...value, service_tier: "priority" }; } }).result();
  assert.equal(Object.hasOwn(f.outbound[0].sse, "service_tier"), false);
});

test("unsafe endpoint/provider/API rejected before snapshot/native invocation", async () => {
  let snapshots = 0;
  const f = fixture({ snapshotSpeed() { snapshots++; return { tier: "standard" }; } });
  for (const baseUrl of ["http://chatgpt.com/backend-api", "https://chatgpt.com.evil/backend-api", "https://evil/backend-api", "https://chatgpt.com:443/backend-api", "https://token@chatgpt.com/backend-api", "https://chatgpt.com/backend-api?x=1", "https://chatgpt.com/backend-api#x", "https://chatgpt.com/backend-api/codex/../codex", null, {}]) {
    assert.throws(() => f.provider.streamSimple({ ...model(), baseUrl }, {}), /official/);
  }
  assert.throws(() => f.provider.streamSimple({ ...model(), provider: "codex" }, {}), /route/);
  assert.throws(() => f.provider.streamSimple({ ...model(), api: "openai-responses" }, {}), /route/);
  assert.equal(snapshots, 0); assert.equal(f.calls.length, 0);
  for (const baseUrl of [undefined, "", "https://chatgpt.com/backend-api", "https://chatgpt.com/backend-api/codex/", "https://chatgpt.com/backend-api/codex/responses"]) {
    await f.provider.streamSimple({ ...model(), baseUrl }, {}).result();
  }
});

test("unknown/unsupported policy and callback errors fail closed before dispatch", async () => {
  for (const value of [undefined, {}, { tier: "priority" }, { tier: "unknown" }, Promise.resolve({ tier: "fast" })]) {
    const f = fixture({ snapshotSpeed: () => value });
    assert.throws(() => f.provider.streamSimple(model(), {}), /policy|synchronous/);
    assert.equal(f.calls.length, 0);
  }
  const unsupported = fixture({ snapshotSpeed() { throw new Error("unsupported-account"); } });
  assert.throws(() => unsupported.provider.streamSimple(model(), {}), /unsupported-account/);
  assert.equal(unsupported.calls.length, 0);
  for (const onPayload of [() => { throw new Error("callback"); }, async () => { throw new Error("callback"); }]) {
    const f = fixture();
    await assert.rejects(f.provider.streamSimple(model(), {}, { onPayload }).result(), /callback/);
    assert.equal(f.outbound.length, 0);
  }
  for (const recordEvidence of [() => { throw new Error("evidence"); }, async () => { throw new Error("evidence"); }]) {
    const f = fixture({ recordEvidence });
    await assert.rejects(f.provider.streamSimple(model(), {}).result(), /evidence/);
    assert.equal(f.outbound.length, 0);
  }
});

test("invalid replacement and toJSON policy bypass fail closed", async () => {
  for (const value of [null, false, [], "json", { toJSON() { return { service_tier: "priority" }; } }]) {
    const f = fixture();
    await assert.rejects(f.provider.streamSimple(model(), {}, { onPayload: () => value }).result(), /plain JSON/);
    assert.equal(f.outbound.length, 0);
  }
  const f = fixture(); const m = model();
  await assert.rejects(f.provider.streamSimple(m, {}, { onPayload() { m.baseUrl = "https://evil"; } }).result(), /official/);
  assert.equal(f.outbound.length, 0);
});

for (const eventType of ["response.done", "response.completed", "response.incomplete"]) {
  test("terminal authority corrects conflicting ciphertext for iterator AND result: " + eventType, async () => {
    const authoritative = item("r1", "terminal-cipher");
    const f = fixture({ eventType, terminal: () => ({ output: [authoritative], service_tier: "default" }), finalMessage: () => message(item("r1", "interim-cipher")) });
    const stream = f.provider.streamSimple(model(), {});
    assert.equal(stream.marker(), f.calls[0].stream);
    const events = [];
    for await (const event of stream) events.push(event);
    const final = await stream.result();
    assert.equal(events.at(-1).message, final);
    assert.equal(final.content[0].thinkingSignature, JSON.stringify(authoritative));
    assert.equal(final.content[0].thinking, "summary");
    assert.equal(stream.result(), stream.result());
  });
}

test("result-only caller gets terminal authority and invocations never share signatures", async () => {
  let n = 0;
  const f = fixture({ terminal: () => ({ output: [item("r1", "terminal-" + ++n)] }), finalMessage: () => message(item("r1", "interim")) });
  const a = f.provider.streamSimple(model(), {}); const b = f.provider.streamSimple(model(), {});
  const [ma, mb] = await Promise.all([a.result(), b.result()]);
  assert.equal(JSON.parse(ma.content[0].thinkingSignature).encrypted_content, "terminal-1");
  assert.equal(JSON.parse(mb.content[0].thinkingSignature).encrypted_content, "terminal-2");
});

test("raw tier separate from request/pricing; evidence is allowlisted and secret-free", async () => {
  const evidence = []; let calls = 0;
  const f = fixture({ snapshotSpeed: () => ({ tier: "fast", scope: "SECRET-SCOPE" }), recordEvidence: e => evidence.push(e), terminal: () => ({ output: [item("r1", "SECRET-CIPHER")], service_tier: "default", access_token: "SECRET-TOKEN" }), finalMessage: () => message(item("r1", "interim")) });
  const terminalHook = function(event, nativeModel) { calls++; assert.equal(this, options); assert.equal(nativeModel.id, "gpt-6.1-sol"); event.response.service_tier = "priority"; return Promise.resolve("prior-return"); };
  const options = { apiKey: "SECRET-TOKEN", sessionId: "SECRET-SESSION", headers: { authorization: "SECRET-TOKEN" }, onProviderStreamEvent: terminalHook };
  await f.provider.streamSimple(model(), { messages: ["SECRET-PROMPT"] }, options).result();
  assert.equal(calls, 1);
  assert.equal(evidence[1].requestedTier, "priority");
  assert.equal(evidence[1].rawReportedTier, "default");
  assert.equal(evidence[0].scope, "other");
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET|interim|thinkingSignature|encrypted_content/);
  const wrapped = f.calls[0].options;
  assert.equal(await wrapped.onProviderStreamEvent({ type: "response.completed", response: {} }, model()), "prior-return");
  assert.equal(evidence.at(-1).rawReportedTier, null);
  await wrapped.onProviderStreamEvent({ type: "response.completed", response: { service_tier: "SECRET-RAW" } }, model());
  assert.equal(evidence.at(-1).rawReportedTierRecognized, false);
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET/);
});

test("terminal-only/duplicate IDs and terminal callback errors fail closed", async () => {
  const f = fixture({ terminal: () => ({ output: [item("r1", "cipher")] }) });
  const stream = f.provider.streamSimple(model(), {});
  await assert.rejects(stream.result(), /REPLAY_TERMINAL_MISMATCH/);
  await assert.rejects(async () => { for await (const event of stream) void event; }, /REPLAY_TERMINAL_MISMATCH/);
  const duplicate = fixture({ terminal: () => ({ output: [item("r1", "a"), item("r1", "b")] }) });
  await assert.rejects(duplicate.provider.streamSimple(model(), {}).result(), /Duplicate/);
  const throwing = fixture({ terminal: () => ({ output: [] }) });
  await assert.rejects(throwing.provider.streamSimple(model(), {}, { async onProviderStreamEvent() { throw new Error("terminal-hook"); } }).result(), /terminal-hook/);
});

test("missing terminal ciphertext keeps native signature; abort/error and unrelated blocks pass through", async () => {
  const original = item("r1", "original");
  const f = fixture({ terminal: () => ({ output: [item("r1", "")] }), finalMessage: () => message(original) });
  assert.equal((await f.provider.streamSimple(model(), {}).result()).content[0].thinkingSignature, JSON.stringify(original));
  for (const stopReason of ["error", "aborted"]) {
    const f = fixture({ terminal: () => ({ output: [item("r2", "other")] }), finalMessage: () => ({ ...message(original), stopReason }) });
    const stream = f.provider.streamSimple(model(), {});
    const events = []; for await (const event of stream) events.push(event);
    assert.equal(events.at(-1).type, "error");
    assert.equal((await stream.result()).content[0].thinkingSignature, JSON.stringify(original));
  }
  const msg = { content: [{ type: "text", text: "hello" }, { type: "thinking", thinkingSignature: "not json" }] };
  assert.equal(settleNativeReplay(msg, new Map()), msg);
});

test("ambiguous terminal/native identities fail closed without inserting content blocks", async () => {
  const missingId = fixture({ terminal: () => ({ output: [{ type: "reasoning", encrypted_content: "cipher" }] }) });
  await assert.rejects(missingId.provider.streamSimple(model(), {}).result(), /REPLAY_TERMINAL_MISMATCH/);
  const duplicateNative = fixture({ terminal: () => ({ output: [item("r1", "cipher")] }), finalMessage: () => message(item("r1", "old"), item("r1", "old")) });
  await assert.rejects(duplicateNative.provider.streamSimple(model(), {}).result(), /duplicate native/);
});

test("iterator forwards next/return/throw arguments and completion values exactly", async () => {
  const invocations = [];
  const nextStep = { done: false, value: { type: "start" } };
  const returnStep = { done: true, value: "return-value" };
  const throwStep = { done: false, value: { type: "recover" } };
  const nativeIterator = {
    async next(value) { invocations.push(["next", value]); return nextStep; },
    async return(value) { invocations.push(["return", value]); return returnStep; },
    async throw(value) { invocations.push(["throw", value]); return throwStep; },
  };
  const nativeStream = { result: async () => message(), [Symbol.asyncIterator]: () => nativeIterator };
  const provider = createCodexNativeProvider({ nativeProvider: { streamSimple: () => nativeStream }, snapshotSpeed: () => ({ tier: "standard" }) });
  const iterator = provider.streamSimple(model(), {})[Symbol.asyncIterator]();
  const error = new Error("sentinel");
  assert.equal(await iterator.next("next-arg"), nextStep);
  assert.equal(await iterator.throw(error), throwStep);
  assert.equal(await iterator.return("return-arg"), returnStep);
  assert.deepEqual(invocations, [["next", "next-arg"], ["throw", error], ["return", "return-arg"]]);
});

test("a genuine underlying delegation TypeError propagates unchanged", async () => {
  const nativeStream = {
    result: async () => message(),
    async *[Symbol.asyncIterator]() { yield* [{ type: "start" }]; },
  };
  const provider = createCodexNativeProvider({ nativeProvider: { streamSimple: () => nativeStream }, snapshotSpeed: () => ({ tier: "standard" }) });
  const iterator = provider.streamSimple(model(), {})[Symbol.asyncIterator]();
  await iterator.next();
  await assert.rejects(iterator.throw(new Error("consumer")), error => error instanceof TypeError && /throw/.test(error.message));
});

test("iterator early return/throw closes underlying stream without changing cancellation signal", async () => {
  for (const operation of ["return", "throw"]) {
    const f = fixture(); const signal = new AbortController().signal;
    const stream = f.provider.streamSimple(model(), {}, { signal });
    const iterator = stream[Symbol.asyncIterator]();
    await iterator.next();
    if (operation === "return") await iterator.return();
    else await assert.rejects(iterator.throw(new Error("consumer")), /consumer/);
    assert.equal(f.calls[0].stream.closed, true);
    assert.equal(f.calls[0].options.signal, signal);
  }
});
