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

export type JavaArgResolver = (node: Parser.SyntaxNode) => string | null;

function resolveFirstArg(node: Parser.SyntaxNode, resolveArg?: JavaArgResolver): string | null {
  const first = methodInvocationArguments(node)[0];
  if (!first) return null;
  if (resolveArg) return resolveArg(first);
  return first.type === 'string_literal' ? unquoteLiteral(first.text) : null;
}

/** Resolve a `URI.create(...)` call to its path; null otherwise. */
export function extractUriCreatePath(
  node: Parser.SyntaxNode,
  resolveArg?: JavaArgResolver,
): string | null {
  if (node.type !== 'method_invocation') return null;
  if (methodInvocationObject(node)?.text !== 'URI' || methodInvocationName(node) !== 'create')
    return null;
  return resolveFirstArg(node, resolveArg);
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
 * Resolve a `UriComponentsBuilder` fluent chain to its path.
 */
const MAX_BUILDER_DEPTH = 100;

function extractUriComponentsBuilderPath(
  node: Parser.SyntaxNode,
  depth = 0,
  resolveArg?: JavaArgResolver,
): string | null {
  if (depth > MAX_BUILDER_DEPTH) return null;
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const objectNode = methodInvocationObject(node);
  if (
    (name === 'fromPath' || name === 'fromUriString' || name === 'fromHttpUrl') &&
    objectNode?.text === 'UriComponentsBuilder'
  ) {
    const seed = resolveFirstArg(node, resolveArg);
    return seed === null ? null : seed.split('?')[0];
  }
  if (name === 'fromUri' && objectNode?.text === 'UriComponentsBuilder') {
    const first = methodInvocationArguments(node)[0];
    if (!first) return null;
    const seed = resolveArg ? resolveArg(first) : extractUriCreatePath(first, resolveArg);
    return seed === null ? null : seed.split('?')[0];
  }
  if (!objectNode) return null;
  if (name === 'path') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1, resolveArg);
    const subPath = resolveFirstArg(node, resolveArg);
    if (base === null || subPath === null) return null;
    return (base + subPath).replace(/(?<!:)\/{2,}/g, '/');
  }
  if (name === 'pathSegment') {
    const base = extractUriComponentsBuilderPath(objectNode, depth + 1, resolveArg);
    if (base === null) return null;
    const args = methodInvocationArguments(node);
    const segments = args
      .map((arg) =>
        resolveArg ? resolveArg(arg) : arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null,
      )
      .filter((segment): segment is string => segment !== null);
    if (segments.length !== args.length) return null;
    return segments.reduce((acc, segment) => appendPath(acc, segment), base);
  }
  if (
    name === 'build' ||
    name === 'buildAndExpand' ||
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
    return extractUriComponentsBuilderPath(objectNode, depth + 1, resolveArg);
  return null;
}

/**
 * Resolve a WebClient `uriBuilder -> uriBuilder.path("/api/users/{id}")...build(...)`
 * lambda expression to its path.
 */
export function extractWebClientUriBuilderLambdaPath(
  node: Parser.SyntaxNode,
  resolveArg?: JavaArgResolver,
): string | null {
  if (node.type !== 'lambda_expression') return null;
  const paramsNode = node.childForFieldName('parameters');
  let paramName: string | null = null;
  if (paramsNode?.type === 'identifier') {
    paramName = paramsNode.text;
  } else if (paramsNode?.type === 'formal_parameters' || paramsNode?.type === 'inferred_parameters') {
    const first = paramsNode.namedChildren[0];
    if (first?.type === 'identifier') paramName = first.text;
    else if (first?.type === 'formal_parameter') {
      paramName = first.childForFieldName('name')?.text ?? null;
    }
  }
  if (!paramName) return null;

  let body = node.childForFieldName('body');
  if (!body) return null;
  if (body.type === 'block') {
    const returnStmt = body.namedChildren.find((c) => c.type === 'return_statement');
    body = returnStmt?.namedChildren[0] ?? null;
    if (!body) return null;
  }

  const walkBuilder = (expr: Parser.SyntaxNode, depth = 0): string | null => {
    if (depth > MAX_BUILDER_DEPTH) return null;
    if (expr.type === 'identifier' && expr.text === paramName) return '';
    if (expr.type !== 'method_invocation') return null;
    const name = methodInvocationName(expr);
    const obj = methodInvocationObject(expr);
    if (!obj) return null;
    const base = walkBuilder(obj, depth + 1);
    if (base === null) return null;
    if (name === 'path') {
      const subPath = resolveFirstArg(expr, resolveArg);
      if (subPath === null) return null;
      return (base + subPath).replace(/(?<!:)\/{2,}/g, '/');
    }
    if (name === 'pathSegment') {
      const args = methodInvocationArguments(expr);
      const segments = args
        .map((arg) =>
          resolveArg ? resolveArg(arg) : arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null,
        )
        .filter((s): s is string => s !== null);
      if (segments.length !== args.length) return null;
      return segments.reduce((acc, seg) => appendPath(acc, seg), base);
    }
    if (name === 'scheme' || name === 'host' || name === 'port') {
      // Scheme/host/port without path don't change the route path; wait for .path()
      return base;
    }
    if (
      name === 'build' ||
      name === 'query' ||
      name === 'queryParam' ||
      name === 'queryParams' ||
      name === 'replaceQuery' ||
      name === 'replaceQueryParam' ||
      name === 'replaceQueryParams'
    ) {
      return base;
    }
    return null;
  };

  const resolved = walkBuilder(body);
  return resolved && resolved.length > 0 ? resolved : null;
}

/**
 * Resolve OkHttp `HttpUrl.parse("...")`, `HttpUrl.get("...")`, or
 * `new HttpUrl.Builder()...build()` expressions.
 */
export function extractOkHttpUrlExpression(
  node: Parser.SyntaxNode,
  resolveArg?: JavaArgResolver,
): string | null {
  if (node.type !== 'method_invocation') return null;
  const name = methodInvocationName(node);
  const obj = methodInvocationObject(node);
  if ((name === 'parse' || name === 'get') && obj?.text === 'HttpUrl') {
    return resolveFirstArg(node, resolveArg);
  }
  const walkHttpUrlBuilder = (cur: Parser.SyntaxNode, depth = 0): string | null => {
    if (depth > MAX_BUILDER_DEPTH) return null;
    if (cur.type === 'object_creation_expression') {
      return cur.childForFieldName('type')?.text === 'HttpUrl.Builder' ? '' : null;
    }
    if (cur.type !== 'method_invocation') return null;
    const mName = methodInvocationName(cur);
    const mObj = methodInvocationObject(cur);
    if (!mObj) return null;
    const base = walkHttpUrlBuilder(mObj, depth + 1);
    if (base === null) return null;
    if (mName === 'addPathSegment' || mName === 'addEncodedPathSegment') {
      const seg = resolveFirstArg(cur, resolveArg);
      return seg === null ? null : appendPath(base, seg);
    }
    if (mName === 'addPathSegments' || mName === 'addEncodedPathSegments' || mName === 'encodedPath') {
      const sub = resolveFirstArg(cur, resolveArg);
      if (sub === null) return null;
      return appendPath(base, sub);
    }
    if (
      mName === 'scheme' ||
      mName === 'host' ||
      mName === 'port' ||
      mName === 'username' ||
      mName === 'password' ||
      mName === 'addQueryParameter' ||
      mName === 'addEncodedQueryParameter' ||
      mName === 'setQueryParameter' ||
      mName === 'query' ||
      mName === 'fragment' ||
      mName === 'build'
    ) {
      return base;
    }
    return null;
  };
  const built = walkHttpUrlBuilder(node);
  return built && built.length > 0 ? built : null;
}

/**
 * Resolve a statically-derivable path argument to a literal path: a bare
 * string literal, a `URI.create(...)` call, or a `UriComponentsBuilder`
 * fluent chain. Genuinely dynamic arguments → null.
 */
export function extractStaticPathExpression(
  node: Parser.SyntaxNode,
  resolveArg?: JavaArgResolver,
): string | null {
  if (node.type === 'string_literal') return unquoteLiteral(node.text);
  return (
    extractUriCreatePath(node, resolveArg) ??
    extractUriComponentsBuilderPath(node, 0, resolveArg)
  );
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
 *  object-creation or a tracked `Request.Builder` variable/field. */
export function okHttpUrlRootsAtBuilder(
  urlCall: Parser.SyntaxNode,
  okHttpBuilderNames?: ReadonlySet<string>,
): boolean {
  let obj = methodInvocationObject(urlCall);
  while (obj?.type === 'method_invocation') obj = methodInvocationObject(obj);
  if (
    obj?.type === 'object_creation_expression' &&
    obj.childForFieldName('type')?.text === 'Request.Builder'
  ) {
    return true;
  }
  if (!okHttpBuilderNames) return false;
  if (obj?.type === 'identifier') return okHttpBuilderNames.has(obj.text);
  if (obj?.type === 'field_access') {
    const owner = obj.childForFieldName('object');
    const field = obj.childForFieldName('field');
    if (owner?.type === 'this' && field) return okHttpBuilderNames.has(field.text);
  }
  return false;
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
  okHttpBuilderNames: Set<string>;
  webClientBaseUrls: Map<string, string>;
}

function simpleTypeName(typeNode: Parser.SyntaxNode | null | undefined): string | null {
  if (!typeNode) return null;
  if (typeNode.type === 'type_identifier') return typeNode.text;
  if (typeNode.type === 'scoped_type_identifier') {
    return typeNode.text.split('.').pop() ?? null;
  }
  return null;
}

function fullTypeText(typeNode: Parser.SyntaxNode | null | undefined): string | null {
  if (!typeNode) return null;
  return typeNode.text;
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

function isOkHttpRequestBuilderCreation(node: Parser.SyntaxNode | null | undefined): boolean {
  const expr = unwrapParens(node);
  let cur = expr;
  while (cur?.type === 'method_invocation') cur = methodInvocationObject(cur);
  return (
    cur?.type === 'object_creation_expression' &&
    cur.childForFieldName('type')?.text === 'Request.Builder'
  );
}

/**
 * Extract a baseUrl argument from `WebClient.create(baseUrl)` or
 * `WebClient.builder()...baseUrl(baseUrl)...build()`.
 */
export function extractWebClientBaseUrlFromExpr(
  node: Parser.SyntaxNode | null | undefined,
  resolveArg?: JavaArgResolver,
): string | null {
  const expr = unwrapParens(node);
  if (expr?.type !== 'method_invocation') return null;
  const name = methodInvocationName(expr);
  const obj = methodInvocationObject(expr);
  if (name === 'create' && obj?.text === 'WebClient') {
    const arg = methodInvocationArguments(expr)[0];
    if (!arg) return null;
    return resolveArg ? resolveArg(arg) : arg.type === 'string_literal' ? unquoteLiteral(arg.text) : null;
  }
  if (name === 'build') {
    let cur: Parser.SyntaxNode | null = obj;
    let foundBaseUrl: string | null = null;
    let sawBaseUrl = false;
    let reachedBuilder = false;
    while (cur?.type === 'method_invocation') {
      const mName = methodInvocationName(cur);
      const mObj = methodInvocationObject(cur);
      if (mName === 'baseUrl' && !sawBaseUrl) {
        sawBaseUrl = true;
        const arg = methodInvocationArguments(cur)[0];
        if (arg) {
          foundBaseUrl = resolveArg
            ? resolveArg(arg)
            : arg.type === 'string_literal'
              ? unquoteLiteral(arg.text)
              : null;
        }
      }
      if (mName === 'builder' && mObj?.text === 'WebClient') {
        reachedBuilder = true;
        break;
      }
      cur = mObj;
    }
    return reachedBuilder ? foundBaseUrl : null;
  }
  return null;
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
 * Collect variable, field, and parameter names declared as `RestTemplate`,
 * `WebClient`, or `Request.Builder`, plus statically resolvable `WebClient`
 * base URLs.
 */
export function collectJavaHttpClientReceivers(
  tree: Parser.Tree,
  resolveBaseUrlArg?: JavaArgResolver,
): JavaHttpClientReceivers {
  const restTemplateNames = new Set<string>();
  const webClientNames = new Set<string>();
  const okHttpBuilderNames = new Set<string>();
  const nonClientNames = new Set<string>();
  const webClientBaseUrls = new Map<string, string>();
  const ambiguousWebClientNames = new Set<string>();

  const markWebClientAmbiguous = (name: string) => {
    ambiguousWebClientNames.add(name);
    webClientBaseUrls.delete(name);
  };

  const recordBaseUrl = (name: string, value: Parser.SyntaxNode | null) => {
    const baseUrl = extractWebClientBaseUrlFromExpr(value, resolveBaseUrlArg);
    if (baseUrl === null) {
      // A WebClient declaration/reassignment without a statically resolvable
      // baseUrl (e.g., `wc = builder.build()`) makes the file-wide name
      // ambiguous so an unrelated `create("...")` baseUrl cannot leak to it.
      markWebClientAmbiguous(name);
      return;
    }
    const prev = webClientBaseUrls.get(name);
    if (prev !== undefined && prev !== baseUrl) {
      markWebClientAmbiguous(name);
    } else if (!ambiguousWebClientNames.has(name)) {
      webClientBaseUrls.set(name, baseUrl);
    }
  };

  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'field_declaration' || node.type === 'local_variable_declaration') {
      const typeNode = node.childForFieldName('type');
      const typeName = simpleTypeName(typeNode);
      const typeText = fullTypeText(typeNode);
      const declarators: Array<{ name: string; value: Parser.SyntaxNode | null }> = [];
      collectDeclarators(node, declarators);
      for (const { name, value } of declarators) {
        if (typeName === 'RestTemplate') {
          restTemplateNames.add(name);
        } else if (typeName === 'WebClient') {
          webClientNames.add(name);
          recordBaseUrl(name, value);
        } else if (typeText === 'Request.Builder' || typeText?.endsWith('.Request.Builder')) {
          okHttpBuilderNames.add(name);
        } else if (typeName === 'var') {
          if (isRestTemplateCreation(value)) restTemplateNames.add(name);
          else if (isWebClientCreation(value)) {
            webClientNames.add(name);
            recordBaseUrl(name, value);
          } else if (isOkHttpRequestBuilderCreation(value)) {
            okHttpBuilderNames.add(name);
          } else {
            nonClientNames.add(name);
          }
        } else if (typeName !== null || typeText !== null) {
          nonClientNames.add(name);
        }
      }
    } else if (node.type === 'formal_parameter') {
      const typeNode = node.childForFieldName('type');
      const typeName = simpleTypeName(typeNode);
      const typeText = fullTypeText(typeNode);
      const name = node.childForFieldName('name')?.text;
      if (name) {
        if (typeName === 'RestTemplate') restTemplateNames.add(name);
        else if (typeName === 'WebClient') {
          webClientNames.add(name);
          markWebClientAmbiguous(name);
        } else if (typeText === 'Request.Builder' || typeText?.endsWith('.Request.Builder')) {
          okHttpBuilderNames.add(name);
        } else if (typeName !== null || typeText !== null) {
          nonClientNames.add(name);
        }
      }
    } else if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      const right = node.childForFieldName('right');
      let targetName: string | null = null;
      if (left?.type === 'identifier') targetName = left.text;
      else if (
        left?.type === 'field_access' &&
        left.childForFieldName('object')?.type === 'this'
      ) {
        targetName = left.childForFieldName('field')?.text ?? null;
      }
      if (targetName && right) {
        recordBaseUrl(targetName, right);
      }
    }
    for (const child of node.namedChildren) visit(child);
  };

  visit(tree.rootNode);

  if (!nonClientNames.has('restTemplate')) restTemplateNames.add('restTemplate');
  if (!nonClientNames.has('webClient')) webClientNames.add('webClient');

  return { restTemplateNames, webClientNames, okHttpBuilderNames, webClientBaseUrls };
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

export function resolveWebClientReceiverBaseUrl(
  objNode: Parser.SyntaxNode | undefined,
  receivers: JavaHttpClientReceivers,
  resolveBaseUrlArg?: JavaArgResolver,
): string | null {
  const expr = unwrapParens(objNode);
  if (!expr) return null;
  if (expr.type === 'identifier') return receivers.webClientBaseUrls.get(expr.text) ?? null;
  if (expr.type === 'field_access') {
    const obj = expr.childForFieldName('object');
    const field = expr.childForFieldName('field');
    if (obj?.type === 'this' && field) return receivers.webClientBaseUrls.get(field.text) ?? null;
  }
  return extractWebClientBaseUrlFromExpr(expr, resolveBaseUrlArg);
}

export function joinWebClientBaseAndPath(baseUrl: string | null, subPath: string): string {
  if (!baseUrl) return subPath;
  if (/^https?:\/\//i.test(subPath)) return subPath;
  if (!subPath) return baseUrl;
  return `${baseUrl.replace(/\/+$/, '')}/${subPath.replace(/^\/+/, '')}`;
}

/**
 * Collect statically-resolvable `String`, `URI`, `HttpUrl`, and `var` local/field
 * variable values inside a method/constructor/class scope. Reassignments, control-
 * flow declarations, and shadowed parameters/locals are poisoned so dynamic or
 * overridden values never emit stale routes.
 */
export function collectScopeUriVars(
  scopeNode: Parser.SyntaxNode,
  resolveInitializer: JavaArgResolver,
  fallbackVars?: ReadonlyMap<string, string>,
): Map<string, string> {
  const vars = new Map<string, string>();
  const poisoned = new Set<string>();

  const isControlFlowBranch = (n: Parser.SyntaxNode): boolean =>
    n.type === 'if_statement' ||
    n.type === 'for_statement' ||
    n.type === 'enhanced_for_statement' ||
    n.type === 'while_statement' ||
    n.type === 'do_statement' ||
    n.type === 'switch_expression' ||
    n.type === 'switch_statement_expression' ||
    n.type === 'try_statement' ||
    n.type === 'catch_clause';

  const visit = (node: Parser.SyntaxNode, inBranch: boolean): void => {
    if (
      node !== scopeNode &&
      (node.type === 'class_declaration' ||
        node.type === 'method_declaration' ||
        node.type === 'constructor_declaration' ||
        node.type === 'lambda_expression')
    ) {
      return;
    }
    const nextInBranch = inBranch || isControlFlowBranch(node);
    if (node.type === 'formal_parameter') {
      const paramName = node.childForFieldName('name')?.text;
      if (paramName) {
        poisoned.add(paramName);
        vars.delete(paramName);
      }
    } else if (node.type === 'local_variable_declaration' || node.type === 'field_declaration') {
      const typeName = simpleTypeName(node.childForFieldName('type'));
      const declarators: Array<{ name: string; value: Parser.SyntaxNode | null }> = [];
      collectDeclarators(node, declarators);
      if (typeName === 'String' || typeName === 'URI' || typeName === 'HttpUrl' || typeName === 'var') {
        for (const { name, value } of declarators) {
          if (nextInBranch || poisoned.has(name) || vars.has(name)) {
            poisoned.add(name);
            vars.delete(name);
            continue;
          }
          if (!value) {
            poisoned.add(name);
            continue;
          }
          // Skip `String` / `var` locals initialized solely to a bare string literal
          // so anti-overreach fixtures (like `String dynamicPath = "/api/..."`) stay
          // conservatively unresolved unless constructed from constants, concats, or
          // URI/HttpUrl builders.
          if ((typeName === 'String' || typeName === 'var') && value.type === 'string_literal') {
            poisoned.add(name);
            continue;
          }
          const resolved = resolveInitializer(value);
          if (resolved !== null) vars.set(name, resolved);
          else poisoned.add(name);
        }
      } else {
        for (const { name } of declarators) {
          poisoned.add(name);
          vars.delete(name);
        }
      }
    } else if (node.type === 'assignment_expression') {
      const left = node.childForFieldName('left');
      if (left?.type === 'identifier') {
        poisoned.add(left.text);
        vars.delete(left.text);
      } else if (
        left?.type === 'field_access' &&
        left.childForFieldName('object')?.type === 'this'
      ) {
        const field = left.childForFieldName('field')?.text;
        if (field) {
          poisoned.add(field);
          vars.delete(field);
        }
      }
    }
    for (const child of node.namedChildren) visit(child, nextInBranch);
  };

  visit(scopeNode, false);

  // For class scopes, also poison any field assigned via `this.<field> = ...` inside
  // constructors or methods of the class so runtime-mutated fields are not folded.
  if (scopeNode.type === 'class_declaration') {
    const scanThisAssignments = (node: Parser.SyntaxNode): void => {
      if (node !== scopeNode && node.type === 'class_declaration') return;
      if (node.type === 'assignment_expression') {
        const left = node.childForFieldName('left');
        if (
          left?.type === 'field_access' &&
          left.childForFieldName('object')?.type === 'this'
        ) {
          const field = left.childForFieldName('field')?.text;
          if (field) {
            poisoned.add(field);
            vars.delete(field);
          }
        }
      }
      for (const child of node.namedChildren) scanThisAssignments(child);
    };
    scanThisAssignments(scopeNode);
  }

  if (fallbackVars) {
    for (const [k, v] of fallbackVars) {
      if (!vars.has(k) && !poisoned.has(k)) vars.set(k, v);
    }
  }
  return vars;
}


