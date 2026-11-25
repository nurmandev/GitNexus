import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HttpRouteExtractor } from '../../../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';

describe('Java imperative HTTP consumer constant and concat resolution (#1870)', () => {
  let tmpDir: string;
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-constants-'));
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

  it('resolves same-class constants, cross-file constants, and constant+variable concats across all 5 clients', async () => {
    const dir = path.join(tmpDir, 'const-consumers');
    fs.mkdirSync(path.join(dir, 'src/main/java/com/example'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/main/java/com/example/ApiUrls.java'),
      `package com.example;

public final class ApiUrls {
  public static final String BASE_URL = "https://users.example.com";
  public static final String ORDERS_PATH = "/api/orders";
  public static final String FULL_ORDERS = BASE_URL + ORDERS_PATH;
  public static final String SUBMIT_ORDERS = FULL_ORDERS + "/submit";
  public static final String UNRELATED_CONST = "/api/never-called";
}
`,
    );

    fs.writeFileSync(
      path.join(dir, 'src/main/java/com/example/ConsumerService.java'),
      `package com.example;

import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;
import static com.example.ApiUrls.BASE_URL;

public class ConsumerService {
  private static final String USERS_PATH = "/api/users";
  private static final String LOCAL_USERS_FULL = BASE_URL + USERS_PATH;

  private final RestTemplate client;
  private final WebClient http;

  public ConsumerService(RestTemplate client, WebClient http) {
    this.client = client;
    this.http = http;
  }

  public void callAll(String id) {
    // Same-class + cross-file constant concat
    client.getForObject(LOCAL_USERS_FULL, String.class);
    // Cross-file constant + dynamic path param
    client.exchange(BASE_URL + "/api/users/" + id, HttpMethod.DELETE, null, String.class);
    // Qualified class constant + numeric literal segment
    http.get().uri(ApiUrls.BASE_URL + "/api/items/" + 42 + "/details").retrieve();
    // Cross-file folded constant on WebClient long form
    http.method(HttpMethod.PUT).uri(ApiUrls.FULL_ORDERS).retrieve();
    // OkHttp constant + dynamic param
    new Request.Builder().url(BASE_URL + "/api/okhttp/" + id + "/status").get().build();
    // Java HttpClient with URI.create(constant + concat)
    HttpRequest.newBuilder().uri(URI.create(ApiUrls.FULL_ORDERS)).POST(HttpRequest.BodyPublishers.noBody()).build();
    // Apache HttpClient constructors with constant and concat
    new HttpGet(BASE_URL + USERS_PATH + "/" + id);
    new HttpPost(ApiUrls.SUBMIT_ORDERS);
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    const keys = new Set(consumers.map((c) => `${c.meta.framework}:${c.contractId}`));

    assert.ok(keys.has('spring-rest-template:http::GET::/api/users'));
    assert.ok(keys.has('spring-rest-template:http::DELETE::/api/users/{param}'));
    assert.ok(keys.has('spring-web-client:http::GET::/api/items/{param}/details'));
    assert.ok(keys.has('spring-web-client:http::PUT::/api/orders'));
    assert.ok(keys.has('okhttp:http::GET::/api/okhttp/{param}/status'));
    assert.ok(keys.has('java-http-client:http::POST::/api/orders'));
    assert.ok(keys.has('apache-http-client:http::GET::/api/users/{param}'));
    assert.ok(keys.has('apache-http-client:http::POST::/api/orders/submit'));

    // Unrelated constant must never emit a contract.
    assert.equal(
      consumers.some((c) => c.contractId.includes('never-called')),
      false,
    );
  });

  it('rejects unsupported runtime expressions and ambiguous partial concats conservatively', async () => {
    const dir = path.join(tmpDir, 'const-negative');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/DynamicService.java'),
      `package com.example;

import java.net.URI;
import java.net.http.HttpRequest;
import okhttp3.Request;
import org.apache.http.client.methods.HttpGet;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

public class DynamicService {
  private String computeId() { return "1"; }

  public void callDynamic(RestTemplate client, WebClient http, String runtimeUrl, String version) {
    client.getForObject(runtimeUrl, String.class);
    client.getForObject("/api/v" + version, String.class);
    http.get().uri("/api/users/" + computeId()).retrieve();
    new Request.Builder().url(runtimeUrl).build();
    HttpRequest.newBuilder(URI.create(runtimeUrl)).GET().build();
    new HttpGet(runtimeUrl);
    new HttpGet(runtimeUrl + "relative-no-slash");
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    assert.equal(consumers.length, 0);
  });
});
