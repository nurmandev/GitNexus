import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import { HttpRouteExtractor } from '../../../../../src/core/group/extractors/http-route-extractor.js';
import type { RepoHandle } from '../../../../../src/core/group/types.js';

const askedSymbolFiles = (params?: Record<string, unknown>): string[] =>
  Array.isArray(params?.filePaths)
    ? (params.filePaths as unknown[]).map(String)
    : [String(params?.filePath ?? '')];

describe('Java HttpClient and Apache HttpClient symbol attribution (#1870)', () => {
  let tmpDir: string;
  let extractor: HttpRouteExtractor;

  beforeEach(() => {
    extractor = new HttpRouteExtractor();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-java-http-attr-'));
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

  it('resolves enclosing method symbols for Apache HttpClient and Java HttpClient calls', async () => {
    const dir = path.join(tmpDir, 'java-http-symbol-attribution');
    const rel = 'src/main/java/com/example/GatewayClient.java';
    fs.mkdirSync(path.join(dir, 'src/main/java/com/example'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, rel),
      `package com.example;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;

public class GatewayClient {
  public void fetchUsers(HttpClient client) throws Exception {
    HttpRequest req = HttpRequest.newBuilder()
        .uri(URI.create("/api/users/42"))
        .GET()
        .build();
    client.send(HttpRequest.newBuilder(URI.create("/api/users")).POST(HttpRequest.BodyPublishers.noBody()).build(), null);
  }

  public void createOrder() {
    new HttpGet("/api/orders/1");
    new HttpPost("/api/orders");
  }
}
`,
    );

    const mockDbExecutor = async (
      query: string,
      params?: Record<string, unknown>,
    ): Promise<Record<string, unknown>[]> => {
      if (
        query.includes('UNION ALL') &&
        askedSymbolFiles(params).some((f) => f.endsWith('GatewayClient.java'))
      ) {
        return [
          {
            uid: 'Method:GatewayClient.fetchUsers',
            name: 'fetchUsers',
            filePath: rel,
            startLine: 8,
            endLine: 14,
            labels: ['Method'],
          },
          {
            uid: 'Method:GatewayClient.createOrder',
            name: 'createOrder',
            filePath: rel,
            startLine: 16,
            endLine: 19,
            labels: ['Method'],
          },
        ];
      }
      return [];
    };

    const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    const getUsers = consumers.find((c) => c.contractId === 'http::GET::/api/users/{param}');
    assert.equal(getUsers?.symbolUid, 'Method:GatewayClient.fetchUsers');
    assert.equal(getUsers?.symbolName, 'fetchUsers');
    assert.deepEqual(getUsers?.symbolRef, { filePath: rel, name: 'fetchUsers' });
    assert.equal(getUsers?.meta.framework, 'java-http-client');
    assert.equal(getUsers?.meta.extractionStrategy, 'source_scan_resolved');

    const postUsers = consumers.find((c) => c.contractId === 'http::POST::/api/users');
    assert.equal(postUsers?.symbolUid, 'Method:GatewayClient.fetchUsers');
    assert.equal(postUsers?.symbolName, 'fetchUsers');
    assert.equal(postUsers?.meta.framework, 'java-http-client');
    assert.equal(postUsers?.meta.extractionStrategy, 'source_scan_resolved');

    const getOrders = consumers.find((c) => c.contractId === 'http::GET::/api/orders/{param}');
    assert.equal(getOrders?.symbolUid, 'Method:GatewayClient.createOrder');
    assert.equal(getOrders?.symbolName, 'createOrder');
    assert.deepEqual(getOrders?.symbolRef, { filePath: rel, name: 'createOrder' });
    assert.equal(getOrders?.meta.framework, 'apache-http-client');
    assert.equal(getOrders?.meta.extractionStrategy, 'source_scan_resolved');

    const postOrders = consumers.find((c) => c.contractId === 'http::POST::/api/orders');
    assert.equal(postOrders?.symbolUid, 'Method:GatewayClient.createOrder');
    assert.equal(postOrders?.symbolName, 'createOrder');
    assert.equal(postOrders?.meta.framework, 'apache-http-client');
    assert.equal(postOrders?.meta.extractionStrategy, 'source_scan_resolved');
  });

  it('leaves symbolUid empty without fabricating when enclosing symbol is absent', async () => {
    const dir = path.join(tmpDir, 'java-http-unresolvable');
    const rel = 'src/main/java/com/example/OrphanClient.java';
    fs.mkdirSync(path.join(dir, 'src/main/java/com/example'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, rel),
      `package com.example;
import java.net.URI;
import java.net.http.HttpRequest;
import org.apache.http.client.methods.HttpGet;

public class OrphanClient {
  HttpRequest req = HttpRequest.newBuilder(URI.create("/api/orphan-java")).GET().build();
  HttpGet apache = new HttpGet("/api/orphan-apache");
}
`,
    );

    const mockDbExecutor = async (): Promise<Record<string, unknown>[]> => [];
    const contracts = await extractor.extract(mockDbExecutor, dir, makeRepo(dir));
    const consumers = contracts.filter((c) => c.role === 'consumer');

    const orphanJava = consumers.find((c) => c.contractId === 'http::GET::/api/orphan-java');
    assert.equal(orphanJava?.symbolUid, '');
    assert.equal(orphanJava?.symbolRef.filePath, rel);
    assert.equal(orphanJava?.meta.framework, 'java-http-client');
    assert.equal(orphanJava?.meta.extractionStrategy, 'source_scan');

    const orphanApache = consumers.find((c) => c.contractId === 'http::GET::/api/orphan-apache');
    assert.equal(orphanApache?.symbolUid, '');
    assert.equal(orphanApache?.symbolRef.filePath, rel);
    assert.equal(orphanApache?.meta.framework, 'apache-http-client');
    assert.equal(orphanApache?.meta.extractionStrategy, 'source_scan');
  });
});
