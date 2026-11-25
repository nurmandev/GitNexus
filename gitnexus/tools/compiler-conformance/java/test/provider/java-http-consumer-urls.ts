import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HttpRouteExtractor } from '../../../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';

describe('Java HTTP consumer URL and URI expression extraction (#1870)', () => {
  let tmpDir: string;
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-urls-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/backend',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  it('resolves UriComponentsBuilder, URI vars, WebClient lambdas/baseUrl, and OkHttp HttpUrl/builder vars', async () => {
    const dir = path.join(tmpDir, 'uri-expressions');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/UrlClients.java'),
      `package com.example;

import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.HttpUrl;
import okhttp3.Request;
import okhttp3.RequestBody;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.util.UriComponentsBuilder;

public class UrlClients {
  private static final String BASE = "https://svc.example.com/v1";
  private final WebClient createdClient = WebClient.create(BASE);
  private final WebClient builtClient = WebClient.builder().baseUrl("https://svc.example.com/v2").build();

  public void restTemplateExpressions(RestTemplate rt) {
    URI userUri = UriComponentsBuilder.fromHttpUrl(BASE).path("/users").pathSegment("42").build().toUri();
    rt.getForObject(userUri, String.class);
    String urlVar = BASE + "/orders";
    rt.postForObject(urlVar, null, String.class);
  }

  public void webClientExpressions(WebClient wc, String id) {
    wc.get().uri(URI.create("/api/wc-uri")).retrieve();
    wc.post().uri(b -> b.path("/api/wc-lambda/{id}").queryParam("q", 1).build(id)).retrieve();
    wc.put().uri(UriComponentsBuilder.fromPath("/api/wc-ucb").build().toUri()).retrieve();
    createdClient.get().uri("/created-items").retrieve();
    builtClient.delete().uri("/built-items/5").retrieve();
    builtClient.get().uri("https://override.example.com/abs-path").retrieve();
  }

  public void okHttpExpressions(RequestBody body) {
    new Request.Builder().url(HttpUrl.parse("https://svc.example.com/api/okhttp-parse")).get().build();
    new Request.Builder().url(new HttpUrl.Builder()
        .scheme("https")
        .host("svc.example.com")
        .addPathSegment("api")
        .addPathSegments("carts/99")
        .build()).post(body).build();
    Request.Builder builderVar = new Request.Builder();
    builderVar.url("/api/builder-var").put(body).build();
  }

  public void httpClientsWithVars() {
    URI hcUri = URI.create(BASE + "/hc-var");
    HttpRequest.newBuilder(hcUri).GET().build();
    URI hcUcb = UriComponentsBuilder.fromPath("/api/hc-ucb").pathSegment("99").build().toUri();
    HttpRequest.newBuilder().uri(hcUcb).DELETE().build();
    new HttpGet(URI.create("/api/apache-uri"));
    new HttpPost(hcUri);
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    const keys = new Set(consumers.map((c) => `${c.meta.framework}:${c.contractId}`));

    assert.ok(keys.has('spring-rest-template:http::GET::/v1/users/{param}'));
    assert.ok(keys.has('spring-rest-template:http::POST::/v1/orders'));

    assert.ok(keys.has('spring-web-client:http::GET::/api/wc-uri'));
    assert.ok(keys.has('spring-web-client:http::POST::/api/wc-lambda/{param}'));
    assert.ok(keys.has('spring-web-client:http::PUT::/api/wc-ucb'));
    assert.ok(keys.has('spring-web-client:http::GET::/v1/created-items'));
    assert.ok(keys.has('spring-web-client:http::DELETE::/v2/built-items/{param}'));
    assert.ok(keys.has('spring-web-client:http::GET::/abs-path'));

    assert.ok(keys.has('okhttp:http::GET::/api/okhttp-parse'));
    assert.ok(keys.has('okhttp:http::POST::/api/carts/{param}'));
    assert.ok(keys.has('okhttp:http::PUT::/api/builder-var'));

    assert.ok(keys.has('java-http-client:http::GET::/v1/hc-var'));
    assert.ok(keys.has('java-http-client:http::DELETE::/api/hc-ucb/{param}'));
    assert.ok(keys.has('apache-http-client:http::GET::/api/apache-uri'));
    assert.ok(keys.has('apache-http-client:http::POST::/v1/hc-var'));
  });

  it('drops reassigned, conditional, shadowed, or dynamically segmented URI variables rather than emitting stale paths', async () => {
    const dir = path.join(tmpDir, 'poisoned-vars');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/Poisoned.java'),
      `package com.example;

import java.net.URI;
import java.net.http.HttpRequest;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

public class Poisoned {
  private static final String BASE = "https://svc.example.com";
  private final String fieldUrl = BASE + "/api/from-field";
  private String mutableField = BASE + "/api/from-mutable-field";

  public Poisoned(String runtimeField) {
    this.mutableField = runtimeField;
  }

  public void call(RestTemplate client, boolean flag, URI unknownUri, String runtime, String fieldUrl) {
    String url = BASE + "/api/stale";
    url = runtime;
    client.getForObject(url, String.class);

    // Method parameter shadows class field fieldUrl
    client.getForObject(fieldUrl, String.class);
    // Constructor reassigned this.mutableField
    client.getForObject(mutableField, String.class);

    if (flag) {
      URI conditionalUri = URI.create("/api/conditional");
      HttpRequest.newBuilder(conditionalUri).GET().build();
    }

    HttpRequest.newBuilder(unknownUri).GET().build();
  }

  public void baseUrlIsolation(WebClient sharedName, String dynamicBase) {
    WebClient.builder().baseUrl("https://svc.example.com/stale-v1").baseUrl(dynamicBase).build()
        .get().uri("/override-base").retrieve();
    sharedName.get().uri("/param-rel").retrieve();
  }

  public void otherMethodWithSameWcName() {
    var sharedName = WebClient.create("https://svc.example.com/v9");
    sharedName.get().uri("/v9-item").retrieve();
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    const keys = new Set(consumers.map((c) => `${c.meta.framework}:${c.contractId}`));

    assert.equal(keys.has('spring-web-client:http::GET::/override-base'), true);
    assert.equal(keys.has('spring-web-client:http::GET::/param-rel'), true);
    assert.equal(keys.has('spring-web-client:http::GET::/v9-item'), true);
    assert.equal(consumers.length, 3);
  });
});
