import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HttpRouteExtractor } from '../../../../../src/core/group/extractors/http-route-extractor.js';
import { JAVA_HTTP_PLUGIN } from '../../../../../src/core/group/extractors/http-patterns/java.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';

describe('Java HTTP consumer receiver name independence (#1870)', () => {
  let tmpDir: string;
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-receivers-'));
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

  it('detects RestTemplate and WebClient across field, parameter, local, var, and factory receivers', async () => {
    const dir = path.join(tmpDir, 'diverse-receivers');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/Clients.java'),
      `package com.example;
import org.springframework.http.HttpMethod;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

public class Clients {
  private final RestTemplate userServiceClient;
  private final WebClient paymentWebClient;

  public Clients(RestTemplate userServiceClient, WebClient paymentWebClient) {
    this.userServiceClient = userServiceClient;
    this.paymentWebClient = paymentWebClient;
  }

  public void callRestTemplate(RestTemplate client) {
    userServiceClient.getForObject("/api/field-users", String.class);
    this.userServiceClient.postForEntity("/api/this-users", null, String.class);
    client.exchange("/api/param-users", HttpMethod.DELETE, null, String.class);
    var localRt = new RestTemplate();
    localRt.put("/api/var-users", null);
    new RestTemplate().getForEntity("/api/inline-users", String.class);
  }

  public void callWebClient(WebClient http) {
    paymentWebClient.post().uri("/api/field-payments").retrieve();
    this.paymentWebClient.delete().uri("/api/this-payments").retrieve();
    http.get().uri("/api/param-http").retrieve();
    var localWc = WebClient.create("https://orders.local");
    localWc.method(HttpMethod.PATCH).uri("/api/var-orders").retrieve();
    WebClient.builder().baseUrl("https://billing.local").build().post().uri("/api/inline-billing").retrieve();
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    const ids = new Set(consumers.map((c) => `${c.meta.framework}:${c.contractId}`));

    assert.ok(ids.has('spring-rest-template:http::GET::/api/field-users'));
    assert.ok(ids.has('spring-rest-template:http::POST::/api/this-users'));
    assert.ok(ids.has('spring-rest-template:http::DELETE::/api/param-users'));
    assert.ok(ids.has('spring-rest-template:http::PUT::/api/var-users'));
    assert.ok(ids.has('spring-rest-template:http::GET::/api/inline-users'));

    assert.ok(ids.has('spring-web-client:http::POST::/api/field-payments'));
    assert.ok(ids.has('spring-web-client:http::DELETE::/api/this-payments'));
    assert.ok(ids.has('spring-web-client:http::GET::/api/param-http'));
    assert.ok(ids.has('spring-web-client:http::PATCH::/api/var-orders'));
    assert.ok(ids.has('spring-web-client:http::POST::/api/inline-billing'));
  });

  it('ignores unrelated objects exposing get(), post(), or getForObject() and shadowed restTemplate/webClient', async () => {
    const dir = path.join(tmpDir, 'negative-receivers');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/Unrelated.java'),
      `package com.example;

class CacheClient {
  Object getForObject(String key, Class<?> cls) { return null; }
}

class BuilderLike {
  BuilderLike uri(String u) { return this; }
}

class UnrelatedClient {
  BuilderLike get() { return new BuilderLike(); }
  BuilderLike post() { return new BuilderLike(); }
}

public class Unrelated {
  private final CacheClient restTemplate = new CacheClient();
  private final UnrelatedClient webClient = new UnrelatedClient();
  private final CacheClient cache = new CacheClient();
  private final UnrelatedClient other = new UnrelatedClient();

  public void run() {
    restTemplate.getForObject("/nope/shadow-rt", String.class);
    cache.getForObject("/nope/cache", String.class);
    webClient.get().uri("/nope/shadow-wc");
    other.get().uri("/nope/other-get");
    other.post().uri("/nope/other-post");
  }
}
`,
    );

    const contracts = await extractor.extract(null, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');
    assert.equal(consumers.length, 0);
  });

  it('hasConsumerSignals detects typed RestTemplate and WebClient declarations', () => {
    assert.equal(JAVA_HTTP_PLUGIN.hasConsumerSignals?.('private final RestTemplate client;'), true);
    assert.equal(JAVA_HTTP_PLUGIN.hasConsumerSignals?.('private final WebClient http;'), true);
  });
});
