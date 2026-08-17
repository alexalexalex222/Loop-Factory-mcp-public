import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createExternalResearchPortableEvidence,
  createExternalResearchPlan,
  fetchExternalResearchPlan,
  validateExternalResearchPlan,
  verifyExternalResearchFetchRun,
  verifyExternalResearchPortableEvidence
} from '../src/vnext-external-research-worker.mjs';

const NOW = '2026-08-05T12:00:00.000Z';

function planInput(overrides = {}) {
  return {
    planId: 'research-run-1',
    createdAt: NOW,
    failureSha256: 'a'.repeat(64),
    retrievalSha256: 'b'.repeat(64),
    queries: ['official evidence for bounded agent retrieval'],
    allowlist: ['example.com'],
    sources: [{
      sourceId: 'source-example',
      url: 'https://example.com/research',
      title: 'Official Example Research',
      reason: 'Primary-source fixture for deterministic capture.',
      authorityClass: 'primary'
    }],
    maximumSources: 4,
    maximumPerSourceBytes: 64 * 1024,
    maximumTotalBytes: 128 * 1024,
    timeoutMs: 5000,
    networkEnabled: true,
    sealedMode: false,
    ...overrides
  };
}

function fixtureTransport(source) {
  return Promise.resolve({
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
    body: Buffer.from(`Primary bytes for ${source.sourceId}.`, 'utf8'),
    finalUrl: source.url,
    remoteAddresses: ['93.184.216.34'],
    peerAddressVerified: true,
    tlsAuthorized: true,
    tlsProtocol: 'TLSv1.3'
  });
}

test('external research fetches, persists, and replays exact primary-source bytes', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-research-worker-'));
  try {
    const built = createExternalResearchPlan(planInput());
    assert.equal(built.status, 'OK');
    assert.equal(validateExternalResearchPlan(built.plan).status, 'OK');
    let tick = 0;
    const result = await fetchExternalResearchPlan({
      plan: built.plan,
      stateRoot,
      transport: fixtureTransport,
      allowTestTransport: true,
      now: () => new Date(Date.parse(NOW) + (++tick * 1000))
    });
    assert.equal(result.status, 'OK', result.message);
    assert.equal(result.receipt.networkPerformed, true);
    assert.equal(result.receipt.activationAuthority, false);
    assert.equal(result.sources[0].rawSha256.length, 64);
    const replay = verifyExternalResearchFetchRun({ runDir: result.runDir });
    assert.equal(replay.status, 'OK');
    const portable = createExternalResearchPortableEvidence({ runDir: result.runDir });
    assert.equal(portable.status, 'OK');
    assert.equal(
      verifyExternalResearchPortableEvidence(portable.evidence).status,
      'OK'
    );
    const tamperedPortable = structuredClone(portable.evidence);
    tamperedPortable.rawSources[0].rawBase64 = Buffer.from('tampered').toString('base64');
    assert.equal(
      verifyExternalResearchPortableEvidence(tamperedPortable).status,
      'REFUSED'
    );

    writeFileSync(join(result.runDir, result.sources[0].rawPath), 'tampered');
    assert.equal(
      verifyExternalResearchFetchRun({ runDir: result.runDir }).status,
      'REFUSED'
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('research plans reject sealed mode, private hosts, and hash resealing', () => {
  assert.equal(
    createExternalResearchPlan(planInput({ sealedMode: true })).status,
    'REFUSED'
  );
  assert.equal(
    createExternalResearchPlan(planInput({
      allowlist: ['127.0.0.1'],
      sources: [{
        sourceId: 'private-source', url: 'https://127.0.0.1/research',
        title: 'Private', reason: 'Should fail.', authorityClass: 'primary'
      }]
    })).status,
    'REFUSED'
  );
  const built = createExternalResearchPlan(planInput());
  const tampered = structuredClone(built.plan);
  tampered.sources[0].url = 'https://example.com/changed';
  assert.equal(validateExternalResearchPlan(tampered).status, 'REFUSED');
});

test('caller transport is unavailable without the explicit test seam', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-research-worker-'));
  try {
    const plan = createExternalResearchPlan(planInput({ planId: 'research-run-transport' })).plan;
    let calls = 0;
    const result = await fetchExternalResearchPlan({
      plan,
      stateRoot,
      transport: async () => { calls += 1; return fixtureTransport(plan.sources[0]); }
    });
    assert.equal(result.status, 'REFUSED');
    assert.equal(calls, 0);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('captured peer addresses reject IPv4-mapped private IPv6', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-research-private-peer-'));
  try {
    const plan = createExternalResearchPlan(planInput({
      planId: 'research-run-private-peer'
    })).plan;
    const result = await fetchExternalResearchPlan({
      plan,
      stateRoot,
      allowTestTransport: true,
      transport: async (source) => ({
        ...(await fixtureTransport(source)),
        remoteAddresses: ['::ffff:127.0.0.1']
      })
    });
    assert.equal(result.status, 'REFUSED');
    assert.deepEqual(result.diagnostics, ['REMOTE_ADDRESS_NOT_PUBLIC']);
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
});

test('hostile HTTP responses fail closed at every frozen fetch boundary', async (t) => {
  const cases = [
    {
      name: 'non-200 status',
      mutate: (response) => ({ ...response, statusCode: 302 }),
      diagnostics: ['STATUS_NOT_200']
    },
    {
      name: 'redirect or origin drift',
      mutate: (response) => ({ ...response, finalUrl: 'https://example.com/redirected' }),
      diagnostics: ['ORIGIN_OR_REDIRECT_DRIFT']
    },
    {
      name: 'unauthorized TLS',
      mutate: (response) => ({ ...response, tlsAuthorized: false }),
      diagnostics: ['TLS_UNAUTHORIZED']
    },
    {
      name: 'obsolete TLS protocol',
      mutate: (response) => ({ ...response, tlsProtocol: 'TLSv1.1' }),
      diagnostics: ['TLS_PROTOCOL_FORBIDDEN']
    },
    {
      name: 'peer not bound to DNS answers',
      mutate: (response) => ({ ...response, peerAddressVerified: false }),
      diagnostics: ['REMOTE_ADDRESS_DNS_MISMATCH']
    },
    {
      name: 'forbidden MIME',
      mutate: (response) => ({ ...response, headers: { 'content-type': 'image/png' } }),
      diagnostics: ['MIME_FORBIDDEN']
    },
    {
      name: 'declared non-UTF-8 charset',
      mutate: (response) => ({
        ...response,
        headers: { 'content-type': 'text/plain; charset=iso-8859-1' }
      }),
      diagnostics: ['CHARSET_FORBIDDEN']
    },
    {
      name: 'empty body',
      mutate: (response) => ({ ...response, body: Buffer.alloc(0) }),
      diagnostics: ['BODY_EMPTY']
    },
    {
      name: 'non-buffer body',
      mutate: (response) => ({ ...response, body: 'not raw bytes' }),
      diagnostics: ['BODY_NOT_BUFFER']
    },
    {
      name: 'per-source byte ceiling',
      mutate: (response, plan) => ({
        ...response,
        body: Buffer.alloc(plan.maximumPerSourceBytes + 1, 0x61)
      }),
      diagnostics: ['SOURCE_BYTES_EXCEEDED']
    },
    {
      name: 'missing peer evidence',
      mutate: (response) => ({ ...response, remoteAddresses: [] }),
      diagnostics: ['REMOTE_ADDRESS_MISSING']
    }
  ];

  for (const [index, hostile] of cases.entries()) {
    await t.test(hostile.name, async () => {
      const stateRoot = mkdtempSync(join(tmpdir(), 'vnext-research-hostile-'));
      try {
        const plan = createExternalResearchPlan(planInput({
          planId: `research-hostile-${index}`,
          maximumPerSourceBytes: 1024,
          maximumTotalBytes: 2048
        })).plan;
        const result = await fetchExternalResearchPlan({
          plan,
          stateRoot,
          allowTestTransport: true,
          transport: async (source) => hostile.mutate(
            await fixtureTransport(source),
            plan
          )
        });
        assert.equal(result.code, 'VNEXT_EXTERNAL_RESEARCH_RESPONSE_INVALID');
        assert.deepEqual(result.diagnostics, hostile.diagnostics);
      } finally {
        rmSync(stateRoot, { recursive: true, force: true });
      }
    });
  }
});

test('invalid UTF-8 and aggregate byte overflow cannot produce a receipt', async () => {
  const utfRoot = mkdtempSync(join(tmpdir(), 'vnext-research-utf8-'));
  const totalRoot = mkdtempSync(join(tmpdir(), 'vnext-research-total-'));
  try {
    const utfPlan = createExternalResearchPlan(planInput({
      planId: 'research-invalid-utf8'
    })).plan;
    const invalidUtf8 = await fetchExternalResearchPlan({
      plan: utfPlan,
      stateRoot: utfRoot,
      allowTestTransport: true,
      transport: async (source) => ({
        ...(await fixtureTransport(source)),
        body: Buffer.from([0xc3, 0x28])
      })
    });
    assert.equal(invalidUtf8.code, 'VNEXT_EXTERNAL_RESEARCH_UTF8_INVALID');
    assert.equal(existsSync(join(invalidUtf8.runDir, 'receipt.json')), false);

    const sources = [0, 1].map((index) => ({
      sourceId: `source-total-${index}`,
      url: `https://example.com/research-${index}`,
      title: `Official source ${index}`,
      reason: 'Primary-source aggregate byte fixture.',
      authorityClass: 'primary'
    }));
    const totalPlan = createExternalResearchPlan(planInput({
      planId: 'research-total-overflow',
      sources,
      maximumPerSourceBytes: 1024,
      maximumTotalBytes: 1024
    })).plan;
    const overflow = await fetchExternalResearchPlan({
      plan: totalPlan,
      stateRoot: totalRoot,
      allowTestTransport: true,
      transport: async (source) => ({
        ...(await fixtureTransport(source)),
        body: Buffer.alloc(600, 0x61)
      })
    });
    assert.equal(overflow.code, 'VNEXT_EXTERNAL_RESEARCH_TOTAL_BYTES_EXCEEDED');
    assert.equal(existsSync(join(overflow.runDir, 'receipt.json')), false);
  } finally {
    rmSync(utfRoot, { recursive: true, force: true });
    rmSync(totalRoot, { recursive: true, force: true });
  }
});
