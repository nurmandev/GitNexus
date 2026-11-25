import Parser from 'tree-sitter';
import { unquoteLiteral } from '../tree-sitter-scanner.js';

// ─── Statically-resolvable consumer path + builder verb-walk helpers ──────
// RestTemplate calls increasingly pass a non-literal path argument that is
// still statically derivable — `URI.create("/x")` or a `UriComponentsBuilder`
// fluent chain. These helpers resolve those shapes to a literal path; a
// genuinely dynamic argument (a variable, a non-`URI`/`UriComponentsBuilder`
// call) resolves to null and the call site is skipped. This module also owns
// the OkHttp / Java-HttpClient builder verb-walks (`inferOkHttpMethod` /
// `inferHttpClientMethod`), which recover the request verb by walking UP the
// fluent chain from the matched `.url(...)` / `.uri(...)` call. Extracted from
// java.ts (#2268) so that plugin stays under ~1000 lines; the `methodInvocation*`
// primitives + `firstLiteralArgument` are module-internal (shared by the path
// resolvers and the verb-walks), while the path resolver and the two verb-walks
// are java.ts's only entry points here.

function methodInvocationName(node: Parser.SyntaxNode): string | null {
  return node.type === 'method_invocation' ? (node.childForFieldName('name')?.text ?? null) : null;
}

function methodInvocationObject(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  return node.type === 'method_invocation' ? node.childForFieldName('object') : null;
}

function methodInvocationArguments(node: Parser.SyntaxNode): Parser.SyntaxNode[] {
  const argsNode = node.type === 'method_invocation' ? node.childForFieldName('arguments') : null;
  return argsNode?.namedChildren ?? [];
}

function firstLiteralArgument(node: Parser.SyntaxNode): string | null {
  const first = methodInvocationArguments(node)[0];
  return first?.type === 'string_literal' ? unquoteLiteral(first.text) : null;
}

/** Resolve a `URI.create("/path")` call to its literal path; null otherwise. */
function extractUriCreatePath(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'method_invocation') return null;
  if (methodInvocationObject(node)?.text !== 'URI' || methodInvocationName(node) !== 'create')
    return null;
  return firstLiteralArgument(node);
}

// Join a builder base with a sub-path using exactly one separating slash. This
// is intentionally NOT the shared `joinPath`: `joinPath` force-prepends `/`,
// whereas `appendPath` must preserve an absolute/host base (`fromHttpUrl`
// "https://host/api") so the host survives until `normalizeConsumerPath` strips
// it downstream. Do not unify the two.
function appendPath(base: string, subPath: string): string {
  if (!base) return subPath.startsWith('/') ? subPath : `/${subPath}`;
  if (!subPath) return base;
  return `${base.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`;
}

/**
 * Resolve a `UriComponentsBuilder` fluent chain to its literal path. Seed
 * methods (`fromPath`/`fromUriString`/`fromHttpUrl`) return the literal arg
 * VERBATIM — a `fromHttpUrl("https://host/api")` seed keeps its host, which the
 * shared `normalizeConsumerPath` later reduces to the path (the same single
 * normalization point every other consumer path goes through). `path` and
 * `pathSegment` append literal segments; `build`/`toUriString`/`toUri`/`encode`
 * and the `query*` family pass through (query attributes do not change the
 * path). Any non-literal segment or unknown call → null.
 */
// A UriComponentsBuilder chain deeper than this is not realistic source; cap the
// recursion so a pathological / machine-generated chain returns null instead of
// overflowing the stack (mirrors the project's other AST-depth guards).
const MAX_BUILDER_DEPTH = 100;

function extractUriComponentsBuilderPath(node: Parser.SyntaxNode, depth = 0): string | null {
  if (depth > MAX_BUILDER_DEPTH) return null;
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const objectNode = methodInvocationObject(node);
  if (
    (name === 'fromPath' || name === 'fromUriString' || name === 'fromHttpUrl') &&
    objectNode?.text === 'UriComponentsBuilder'
  ) {
    // Strip any `?query` baked into the seed literal so a later `.path()` appends
    // to a clean base; otherwise the sub-path is glued after the query
    // (`/base?x=1/sub`) and normalizeHttpPath truncates the whole tail at `?`.
    // A host prefix (`https://h/api`) is preserved and stripped downstream by
    // normalizeConsumerPath.
    const seed = firstLiteralArgument(node);
    return seed === null ? null : seed.split('?')[0];
  }
  if (!objectNode) return null;
  if (name === 'path') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    const subPath = firstLiteralArgument(node);
    if (base === null || subPath === null) return null;
    // Spring `UriComponentsBuilder.path(p)` appends `p` VERBATIM (no slash
    // inserted — unlike `pathSegment`, which slash-joins), then normalizes the
    // full path to collapse duplicate slashes. So `fromPath("/api").path("users")`
    // → `/apiusers`, while `.path("/users")` → `/api/users`, and a trailing-slash
    // base collapses (`/api/` + `/users` → `/api/users`). The `(?<!:)` keeps a
    // scheme `://` in a host seed intact; the downstream normalizer is the other
    // slash-collapser for consumer paths (see KTD2 — do not remove it).
    return (base + subPath).replace(/(?<!:)\/{2,}/g, '/');
  }
  if (name === 'pathSegment') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1);
    if (base === null) return null;
    const args = methodInvocationArguments(node);
    const segments = args
      .map((arg) => (arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null))
      .filter((segment): segment is string => segment !== null);
    if (segments.length !== args.length) return null; // a non-literal segment defeats static resolution
    return segments.reduce((acc, segment) => appendPath(acc, segment), base);
  }
  if (
    name === 'build' ||
    name === 'toUriString' ||
    name === 'toUri' ||
    name === 'encode' ||
    name === 'query' ||
    name === 'queryParam' ||
    name === 'queryParams' ||
    name === 'replaceQuery' ||
    name === 'replaceQueryParam' ||
    name === 'replaceQueryParams'
  )
    return extractUriComponentsBuilderPath(objectNode, depth + 1);
  return null;
}

/**
 * Resolve a statically-derivable path argument to a literal path: a bare
 * string literal, a `URI.create("/x")` call, or a `UriComponentsBuilder`
 * fluent chain. Genuinely dynamic arguments → null.
 */
export function extractStaticPathExpression(node: Parser.SyntaxNode): string | null {
  if (node.type === 'string_literal') return unquoteLiteral(node.text);
  return extractUriCreatePath(node) ?? extractUriComponentsBuilderPath(node);
}

// ─── Builder verb-walks ───────────────────────────────────────────────
// OkHttp / Java-HttpClient encode the request verb on a SIBLING call elsewhere in
// the fluent chain, not on the matched path call. Both queries capture the path
// call (`.url(...)` / `.uri(...)`); these helpers recover the verb by scanning
// the WHOLE chain — transparent to neutral calls (`.addHeader()`/`.header()`/
// `.timeout()`/`.version()`) wherever they sit relative to the path call, so the
// verb resolves whether it precedes or follows the path call.

/** Every `method_invocation` in the fluent chain `pathCall` belongs to, ordered
 *  innermost (next to the construction) → outermost (terminal). Lets the verb-walk
 *  find the verb wherever it sits, and lets the root gates inspect the chain base. */
function builderChainCalls(pathCall: Parser.SyntaxNode): Parser.SyntaxNode[] {
  let innermost = pathCall;
  let obj = methodInvocationObject(innermost);
  while (obj?.type === 'method_invocation') {
    innermost = obj;
    obj = methodInvocationObject(innermost);
  }
  const calls: Parser.SyntaxNode[] = [innermost];
  let cur = innermost;
  let parent = cur.parent;
  while (parent?.type === 'method_invocation' && methodInvocationObject(parent)?.id === cur.id) {
    calls.push(parent);
    cur = parent;
    parent = parent.parent;
  }
  return calls;
}

/** Scan the chain for the verb a `name`-matching helper or a `.method("LITERAL")`
 *  call sets, resolving the LAST such call — each verb-setter overwrites the
 *  previous at runtime, so on the (non-idiomatic) chain that sets two verbs the
 *  one nearest the terminal wins. `null` means "verb is set but not statically
 *  resolvable" (a non-literal/empty `.method(verb)`) → the caller skips rather
 *  than guessing. `defaultVerb` is returned only when the chain has no verb call
 *  at all (a bare build). `verbHelpers` are matched on the method NAME (OkHttp
 *  helpers are lowercase, HttpClient helpers uppercase). */
function inferBuilderVerb(
  pathCall: Parser.SyntaxNode,
  verbHelpers: readonly string[],
  defaultVerb: string,
): string | null {
  let lastVerbCall: Parser.SyntaxNode | null = null;
  for (const call of builderChainCalls(pathCall)) {
    if (call.id === pathCall.id) continue; // the path call itself is never the verb
    const name = methodInvocationName(call);
    if (name === 'method' || (name !== null && verbHelpers.includes(name))) lastVerbCall = call;
  }
  if (lastVerbCall === null) return defaultVerb; // no verb call → builder default
  const name = methodInvocationName(lastVerbCall);
  // Explicit `.method(...)`: a non-empty string-literal verb resolves; a
  // non-literal (variable-bound) OR empty-string verb is unresolvable → null
  // (skip), NOT a guessed default or a malformed empty-method contract.
  if (name === 'method') {
    const verb = firstLiteralArgument(lastVerbCall);
    return verb ? verb.toUpperCase() : null;
  }
  return name === null ? defaultVerb : name.toUpperCase(); // a verb-helper name
}

const OK_HTTP_VERB_HELPERS = ['get', 'head', 'post', 'put', 'delete', 'patch'] as const;
const HTTP_CLIENT_VERB_HELPERS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD'] as const;

/**
 * Infer an OkHttp request verb by scanning the builder chain around the matched
 * `.url(...)` call: a `.get()/.head()/.post()/.put()/.delete()/.patch()` helper
 * (before or after `.url()`), or a `.method("VERB", …)` literal, wins. Returns
 * `'GET'` only when the chain has NO verb call at all (a bare `.url(...).build()`
 * — OkHttp's real default). Returns `null` for an explicit `.method(verb, …)`
 * whose verb is a non-literal: the verb is set but not statically resolvable, so
 * the caller skips the call rather than asserting a wrong GET (parity with the
 * WebClient long-form variable-bound-verb behavior, which also skips).
 */
export function inferOkHttpMethod(urlCall: Parser.SyntaxNode): string | null {
  return inferBuilderVerb(urlCall, OK_HTTP_VERB_HELPERS, 'GET');
}

/**
 * Infer a Java-`HttpClient` request verb by walking UP the builder chain from the
 * matched `.uri(URI.create("..."))` call: the first `.GET()/.POST()/.PUT()/`
 * `.DELETE()/.HEAD()` verb-helper, or a `.method("VERB", body)` literal, wins.
 * Returns `'GET'` only when the chain has no verb call (a bare `.build()` — the
 * builder's real default). Returns `null` for an explicit `.method(verb, …)` with
 * a non-literal verb (skip, not a guessed GET). The scan is transparent to
 * neutral calls anywhere in the chain (`.header()`/`.timeout()`/`.version()`),
 * before or after `.uri()`, so neither a header/timeout hop nor a verb call's
 * position drops the contract.
 */
export function inferHttpClientMethod(uriCall: Parser.SyntaxNode): string | null {
  return inferBuilderVerb(uriCall, HTTP_CLIENT_VERB_HELPERS, 'GET');
}

// ─── Builder-chain root gates (anti-overreach) ────────────────────────
// The path queries match a bare `.url(...)` / `.uri(URI.create(...))` call on ANY
// receiver so that a builder call BEFORE the path call (`new Request.Builder()`
// `.addHeader(...).url(...)`, `HttpRequest.newBuilder().version(v).uri(...)`) is
// still captured. These gates re-impose the framework anchor in JS — only a chain
// that bottoms out on the right construction emits, so a `.url(...)`/`.uri(...)`
// on an unrelated object does not.

/** True when `urlCall`'s receiver chain bottoms out on a `new Request.Builder()`
 *  object-creation (descending the `.object` chain past any intervening calls). */
export function okHttpUrlRootsAtBuilder(urlCall: Parser.SyntaxNode): boolean {
  let obj = methodInvocationObject(urlCall);
  while (obj?.type === 'method_invocation') obj = methodInvocationObject(obj);
  return (
    obj?.type === 'object_creation_expression' &&
    obj.childForFieldName('type')?.text === 'Request.Builder'
  );
}

/** True when `uriCall`'s receiver chain includes a `HttpRequest.newBuilder()`. */
export function httpClientUriRootsAtNewBuilder(uriCall: Parser.SyntaxNode): boolean {
  let obj = methodInvocationObject(uriCall);
  while (obj?.type === 'method_invocation') {
    if (
      methodInvocationName(obj) === 'newBuilder' &&
      methodInvocationObject(obj)?.text === 'HttpRequest'
    )
      return true;
    obj = methodInvocationObject(obj);
  }
  return false;
}

/** True when a `HttpRequest.newBuilder(URI.create(...))` chain ALSO calls `.uri(...)`
 *  later — a later `.uri()` overrides the constructor URI at runtime, so the
 *  constructor-arg path must NOT be emitted (the `.uri()` query emits the override). */
export function httpClientChainHasUriCall(newBuilderCall: Parser.SyntaxNode): boolean {
  return builderChainCalls(newBuilderCall).some(
    (call) => call.id !== newBuilderCall.id && methodInvocationName(call) === 'uri',
  );
}

// ─── Type-aware HTTP client receiver resolution (#1870) ──────────────────

export interface JavaHttpClientReceivers {
  restTemplateNames: Set<string>;
  webClientNames: Set<string>;
}

function simpleTypeName(typeNode: Parser.SyntaxNode | null | undefined): string | null {
  if (!typeNode) return null;
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'scoped_type_identifier') {
    return typeNode.text.split('.').pop() ?? null;
  }
  return null;
}

function unwrapParens(node: Parser.SyntaxNode | null | undefined): Parser.SyntaxNode | null {
  let cur = node ?? null;
  while (cur?.type === 'parenthesized_expression') {
    cur = cur.namedChildren[0] ?? null;
  }
  return cur;
}

function isRestTemplateCreation(node: Parser.SyntaxNode | null | undefined): boolean {
  const expr = unwrapParens(node);
  if (!expr) return false;
  if (expr.type === 'object_creation_expression') {
    return simpleTypeName(expr.childForFieldName('type')) === 'RestTemplate';
  }
  if (expr.type === 'method_invocation') {
    // e.g. new RestTemplateBuilder()...build()
    if (methodInvocationName(expr) !== 'build') return false;
    let obj = methodInvocationObject(expr);
    while (obj?.type === 'method_invocation') obj = methodInvocationObject(obj);
    return (
      obj?.type === 'object_creation_expression' &&
      simpleTypeName(obj.childForFieldName('type')) === 'RestTemplateBuilder'
    );
  }
  return false;
}

function isWebClientCreation(node: Parser.SyntaxNode | null | undefined): boolean {
  const expr = unwrapParens(node);
  if (expr?.type !== 'method_invocation') return false;
  const name = methodInvocationName(expr);
  const obj = methodInvocationObject(expr);
  if (name === 'create' && obj?.text === 'WebClient') return true;
  if (name === 'build') {
    let cur = obj;
    while (cur?.type === 'method_invocation') {
      if (methodInvocationName(cur) === 'builder' && methodInvocationObject(cur)?.text === 'WebClient') {
        return true;
      }
      cur = methodInvocationObject(cur);
    }
  }
  return false;
}

function collectDeclarators(
  declNode: Parser.SyntaxNode,
  out: Array<{ name: string; value: Parser.SyntaxNode | null }>,
): void {
  for (const child of declNode.namedChildren) {
    if (child.type === 'variable_declarator') {
      const name = child.childForFieldName('name')?.text;
      if (name) out.push({ name, value: child.childForFieldName('value') });
    }
  }
}

/**
 * Collect variable, field, and parameter names declared as `RestTemplate` or
 * `WebClient` (including `var` locals initialized from `new RestTemplate()` /
 * `WebClient.create()` / `WebClient.builder()...build()`). Preserves `restTemplate`
 * / `webClient` as fallback names when not explicitly shadowed by an unrelated type.
 */
export function collectJavaHttpClientReceivers(tree: Parser.Tree): JavaHttpClientReceivers {
  const restTemplateNames = new Set<string>();
  const webClientNames = new Set<string>();
  const nonClientNames = new Set<string>();

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'field_declaration' || node.type === 'local_variable_declaration') {
      const typeName = simpleTypeName(node.childForFieldName('type'));
      const declarators: Array<{ name: string; value: Parser.SyntaxNode | null }> = [];
      collectDeclarators(node, declarators);
      for (const { name, value } of declarators) {
        if (typeName === 'RestTemplate') {
          restTemplateNames.add(name);
        } else if (typeName === 'WebClient') {
          webClientNames.add(name);
        } else if (typeName === 'var') {
          if (isRestTemplateCreation(value)) restTemplateNames.add(name);
          else if (isWebClientCreation(value)) webClientNames.add(name);
          else nonClientNames.add(name);
        } else if (typeName !== null) {
          nonClientNames.add(name);
        }
      }
    } else if (node.type === 'formal_parameter') {
      const typeName = simpleTypeName(node.childForFieldName('type'));
      const name = node.childForFieldName('name')?.text;
      if (name) {
        if (typeName === 'RestTemplate') restTemplateNames.add(name);
        else if (typeName === 'WebClient') webClientNames.add(name);
        else if (typeName !== null) nonClientNames.add(name);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);

  if (!nonClientNames.has('restTemplate')) restTemplateNames.add('restTemplate');
  if (!nonClientNames.has('webClient')) webClientNames.add('webClient');

  return { restTemplateNames, webClientNames };
}

export function isRestTemplateReceiver(
  objNode: Parser.SyntaxNode | undefined,
  receivers: JavaHttpClientReceivers,
): boolean {
  const expr = unwrapParens(objNode);
  if (!expr) return false;
  if (expr.type === 'identifier') return receivers.restTemplateNames.has(expr.text);
  if (expr.type === 'field_access') {
    const obj = expr.childForFieldName('object');
    const field = expr.childForFieldName('field');
    if (obj?.type === 'this' && field) return receivers.restTemplateNames.has(field.text);
  }
  return isRestTemplateCreation(expr);
}

export function isWebClientReceiver(
  objNode: Parser.SyntaxNode | undefined,
  receivers: JavaHttpClientReceivers,
): boolean {
  const expr = unwrapParens(objNode);
  if (!expr) return false;
  if (expr.type === 'identifier') return receivers.webClientNames.has(expr.text);
  if (expr.type === 'field_access') {
    const obj = expr.childForFieldName('object');
    const field = expr.childForFieldName('field');
    if (obj?.type === 'this' && field) return receivers.webClientNames.has(field.text);
  }
  return isWebClientCreation(expr);
}

