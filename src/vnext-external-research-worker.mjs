import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { isIP } from 'node:net';
import { lookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isSafeId, sha256 } from './util.mjs';
import { canonicalVNextJson } from './vnext-contracts.mjs';

export const VNEXT_EXTERNAL_RESEARCH_PLAN_SCHEMA =
  'vnext-external-research-plan-v1';
export const VNEXT_EXTERNAL_RESEARCH_FETCH_SCHEMA =
  'vnext-external-research-fetch-v1';
export const VNEXT_EXTERNAL_RESEARCH_EVIDENCE_SCHEMA =
  'vnext-external-research-portable-evidence-v1';

const SHA256 = /^[a-f0-9]{64}$/;
const ALLOWED_CONTENT = /^(?:text\/|application\/(?:json|ld\+json|xml|xhtml\+xml))/i;

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return plainObject(value)
    && canonicalVNextJson(Object.keys(value).sort())
      === canonicalVNextJson([...expected].sort());
}

function boundedText(value, maximum) {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= maximum
    && !/[\0\r]/.test(value);
}

function atomicWrite(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  const next = `${path}.new`;
  if (existsSync(next)) throw new Error(`atomic staging path already exists: ${next}`);
  writeFileSync(next, content);
  renameSync(next, path);
}

function publicHostname(hostname) {
  const lower = hostname.toLowerCase();
  return lower !== 'localhost'
    && !lower.endsWith('.localhost')
    && !lower.endsWith('.local')
    && isIP(lower) === 0;
}

function publicAddress(address) {
  if (isIP(address) === 4) {
    const octets = address.split('.').map(Number);
    return !(octets[0] === 10
      || octets[0] === 127
      || octets[0] === 0
      || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127)
      || (octets[0] === 169 && octets[1] === 254)
      || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
      || (octets[0] === 192 && octets[1] === 0 && octets[2] <= 2)
      || (octets[0] === 192 && octets[1] === 168)
      || (octets[0] === 198 && octets[1] >= 18 && octets[1] <= 19)
      || (octets[0] === 198 && octets[1] === 51 && octets[2] === 100)
      || (octets[0] === 203 && octets[1] === 0 && octets[2] === 113)
      || (octets[0] >= 224));
  }
  if (isIP(address) === 6) {
    const lower = address.toLowerCase();
    if (lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4) {
      return publicAddress(lower.slice(7));
    }
    return lower !== '::1'
      && lower !== '::'
      && !lower.startsWith('fc')
      && !lower.startsWith('fd')
      && !/^fe[89ab]/.test(lower)
      && !lower.startsWith('2001:db8:')
      && !lower.startsWith('ff');
  }
  return false;
}

function comparableAddress(address) {
  const lower = String(address || '').toLowerCase();
  return lower.startsWith('::ffff:') && isIP(lower.slice(7)) === 4
    ? lower.slice(7)
    : lower;
}

function canonicalPlanCore(input) {
  if (!exactKeys(input, [
    'allowlist', 'createdAt', 'failureSha256', 'maximumPerSourceBytes',
    'maximumSources', 'maximumTotalBytes', 'networkEnabled', 'planId',
    'queries', 'retrievalSha256', 'sealedMode', 'sources', 'timeoutMs'
  ])
      || !isSafeId(input.planId)
      || typeof input.createdAt !== 'string'
      || !Number.isFinite(Date.parse(input.createdAt))
      || ![input.failureSha256, input.retrievalSha256].every((value) => SHA256.test(String(value || '')))
      || input.networkEnabled !== true
      || input.sealedMode !== false
      || !Array.isArray(input.allowlist)
      || input.allowlist.length < 1
      || input.allowlist.length > 64
      || !input.allowlist.every((host) => (
        typeof host === 'string'
          && /^[A-Za-z0-9.-]+$/.test(host)
          && publicHostname(host)
      ))
      || new Set(input.allowlist.map((host) => host.toLowerCase())).size !== input.allowlist.length
      || !Array.isArray(input.queries)
      || input.queries.length < 1
      || input.queries.length > 32
      || !input.queries.every((query) => boundedText(query, 500))
      || !Number.isInteger(input.maximumSources)
      || input.maximumSources < 1
      || input.maximumSources > 32
      || !Number.isInteger(input.maximumPerSourceBytes)
      || input.maximumPerSourceBytes < 1024
      || input.maximumPerSourceBytes > 1024 * 1024
      || !Number.isInteger(input.maximumTotalBytes)
      || input.maximumTotalBytes < input.maximumPerSourceBytes
      || input.maximumTotalBytes > 8 * 1024 * 1024
      || !Number.isInteger(input.timeoutMs)
      || input.timeoutMs < 250
      || input.timeoutMs > 60_000
      || !Array.isArray(input.sources)
      || input.sources.length < 1
      || input.sources.length > input.maximumSources) return null;
  const allowlist = new Set(input.allowlist.map((host) => host.toLowerCase()));
  const sources = input.sources.map((source) => {
    if (!exactKeys(source, [
      'authorityClass', 'reason', 'sourceId', 'title', 'url'
    ])
        || !isSafeId(source.sourceId)
        || source.authorityClass !== 'primary'
        || !boundedText(source.reason, 1000)
        || !boundedText(source.title, 500)) return null;
    let url;
    try { url = new URL(source.url); } catch { return null; }
    if (url.protocol !== 'https:'
        || url.username || url.password || url.hash
        || !publicHostname(url.hostname)
        || !allowlist.has(url.hostname.toLowerCase())) return null;
    return {
      sourceId: source.sourceId,
      url: url.toString(),
      title: source.title.trim(),
      reason: source.reason.trim(),
      authorityClass: 'primary'
    };
  });
  if (sources.some((source) => source == null)
      || new Set(sources.map(({ sourceId }) => sourceId)).size !== sources.length
      || new Set(sources.map(({ url }) => url)).size !== sources.length) return null;
  return {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_PLAN_SCHEMA,
    planId: input.planId,
    createdAt: new Date(input.createdAt).toISOString(),
    failureSha256: input.failureSha256,
    retrievalSha256: input.retrievalSha256,
    queries: [...input.queries],
    allowlist: [...input.allowlist].map((host) => host.toLowerCase()).sort(),
    sources: sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    maximumSources: input.maximumSources,
    maximumPerSourceBytes: input.maximumPerSourceBytes,
    maximumTotalBytes: input.maximumTotalBytes,
    timeoutMs: input.timeoutMs,
    networkEnabled: true,
    sealedMode: false,
    activationAuthority: false
  };
}

export function createExternalResearchPlan(input = {}) {
  if (input.sealedMode === true || input.networkEnabled !== true) {
    return refused('VNEXT_EXTERNAL_RESEARCH_NETWORK_FORBIDDEN', 'External research is disabled unless an unsealed plan explicitly enables network access.');
  }
  const core = canonicalPlanCore(input);
  if (!core) return refused('VNEXT_EXTERNAL_RESEARCH_PLAN_INVALID', 'External research plan is invalid, non-primary, private-network, or outside its bounds.');
  return {
    status: 'OK',
    plan: {
      ...core,
      planSha256: sha256(canonicalVNextJson(core))
    }
  };
}

export function validateExternalResearchPlan(plan) {
  if (!plainObject(plan) || !SHA256.test(String(plan.planSha256 || ''))) {
    return refused('VNEXT_EXTERNAL_RESEARCH_PLAN_INVALID', 'External research plan shape is invalid.');
  }
  const input = structuredClone(plan);
  delete input.schemaVersion;
  delete input.activationAuthority;
  delete input.planSha256;
  const rebuilt = canonicalPlanCore(input);
  const actualCore = structuredClone(plan);
  delete actualCore.planSha256;
  if (!rebuilt
      || plan.schemaVersion !== VNEXT_EXTERNAL_RESEARCH_PLAN_SCHEMA
      || plan.activationAuthority !== false
      || sha256(canonicalVNextJson(actualCore)) !== plan.planSha256
      || canonicalVNextJson(rebuilt) !== canonicalVNextJson(actualCore)) {
    if (sha256(canonicalVNextJson(actualCore)) !== plan.planSha256) {
      return refused('VNEXT_EXTERNAL_RESEARCH_PLAN_TAMPERED', 'External research plan hash does not match its content.');
    }
    return refused('VNEXT_EXTERNAL_RESEARCH_PLAN_INVALID', 'External research plan semantics are invalid.');
  }
  return { status: 'OK', plan: structuredClone(plan) };
}

function defaultTransport(source, plan) {
  return new Promise((resolveRequest, rejectRequest) => {
    const addresses = [];
    const req = httpsRequest(source.url, {
      method: 'GET',
      headers: {
        accept: 'text/html,text/plain,application/json,application/ld+json,application/xml;q=0.8',
        'user-agent': 'Loop-Factory-VNext-Research/1.0'
      },
      lookup(hostname, options, callback) {
        lookup(hostname, { ...options, all: true }, (error, rows) => {
          if (error) return callback(error);
          const addressesFound = Array.isArray(rows) ? rows : [rows];
          if (!addressesFound.length
              || addressesFound.some(({ address }) => !publicAddress(address))) {
            return callback(new Error('resolved address is not public'));
          }
          addresses.push(...addressesFound.map(({ address }) => address));
          if (options?.all === true) return callback(null, addressesFound);
          const selected = addressesFound[0];
          return callback(null, selected.address, selected.family);
        });
      },
      timeout: plan.timeoutMs
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      const tlsAuthorized = response.socket?.authorized === true;
      const tlsProtocol = response.socket?.getProtocol?.() ?? null;
      const remoteAddress = response.socket?.remoteAddress ?? null;
      const peerAddressVerified = remoteAddress != null
        && addresses.some((address) => (
          comparableAddress(address) === comparableAddress(remoteAddress)
        ));
      response.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > plan.maximumPerSourceBytes) {
          req.destroy(new Error('source exceeded byte ceiling'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolveRequest({
        statusCode: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
        finalUrl: source.url,
        remoteAddresses: [...new Set(addresses)].sort(),
        peerAddressVerified,
        tlsAuthorized,
        tlsProtocol
      }));
    });
    req.once('timeout', () => req.destroy(new Error('source request timed out')));
    req.once('error', rejectRequest);
    req.end();
  });
}

function validateResponse(response, source, plan) {
  const contentTypeHeader = String(response?.headers?.['content-type'] || '');
  const contentType = contentTypeHeader.split(';')[0].trim();
  const charset = contentTypeHeader.match(/;\s*charset\s*=\s*"?([^;"\s]+)/i)?.[1]
    ?.toLowerCase() ?? null;
  const reasons = [];
  if (!plainObject(response)) reasons.push('RESPONSE_NOT_OBJECT');
  if (response?.statusCode !== 200) reasons.push('STATUS_NOT_200');
  if (response?.finalUrl !== source.url) reasons.push('ORIGIN_OR_REDIRECT_DRIFT');
  if (response?.tlsAuthorized !== true) reasons.push('TLS_UNAUTHORIZED');
  if (!['TLSv1.2', 'TLSv1.3'].includes(response?.tlsProtocol)) {
    reasons.push('TLS_PROTOCOL_FORBIDDEN');
  }
  if (response?.peerAddressVerified !== true) reasons.push('REMOTE_ADDRESS_DNS_MISMATCH');
  if (!ALLOWED_CONTENT.test(contentType)) reasons.push('MIME_FORBIDDEN');
  if (charset != null && !['utf-8', 'utf8'].includes(charset)) {
    reasons.push('CHARSET_FORBIDDEN');
  }
  if (!Buffer.isBuffer(response?.body)) reasons.push('BODY_NOT_BUFFER');
  else {
    if (response.body.length === 0) reasons.push('BODY_EMPTY');
    if (response.body.length > plan.maximumPerSourceBytes) reasons.push('SOURCE_BYTES_EXCEEDED');
  }
  if (!Array.isArray(response?.remoteAddresses)
      || response.remoteAddresses.length === 0) reasons.push('REMOTE_ADDRESS_MISSING');
  else if (!response.remoteAddresses.every(publicAddress)) {
    reasons.push('REMOTE_ADDRESS_NOT_PUBLIC');
  }
  return { contentType, reasons };
}

export async function fetchExternalResearchPlan({
  plan,
  stateRoot,
  transport = null,
  allowTestTransport = false,
  now = () => new Date()
} = {}) {
  const validation = validateExternalResearchPlan(plan);
  if (validation.status !== 'OK'
      || typeof stateRoot !== 'string'
      || !isAbsolute(stateRoot)
      || (transport != null && allowTestTransport !== true)) {
    return refused('VNEXT_EXTERNAL_RESEARCH_FETCH_INPUT_INVALID', 'Research fetch requires a valid unsealed plan, absolute state root, and production transport.');
  }
  const runDir = join(resolve(stateRoot), plan.planId);
  if (existsSync(runDir)) {
    return refused('VNEXT_EXTERNAL_RESEARCH_RUN_EXISTS', 'Research fetch run already exists.');
  }
  mkdirSync(join(runDir, 'raw'), { recursive: true });
  atomicWrite(join(runDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  const invoke = transport ?? defaultTransport;
  const sources = [];
  let totalBytes = 0;
  for (const source of plan.sources) {
    let response;
    try {
      response = await invoke(source, plan);
    } catch (error) {
      const failure = {
        schemaVersion: 'vnext-external-research-fetch-failure-v1',
        planSha256: plan.planSha256,
        sourceId: source.sourceId,
        code: 'FETCH_FAILED',
        message: String(error?.message || 'fetch failed').slice(0, 1000),
        activationAuthority: false
      };
      atomicWrite(join(runDir, 'failure.json'), `${JSON.stringify(failure, null, 2)}\n`);
      return refused('VNEXT_EXTERNAL_RESEARCH_FETCH_FAILED', failure.message, { runDir, sourceId: source.sourceId });
    }
    const responseCheck = validateResponse(response, source, plan);
    if (responseCheck.reasons.length) {
      return refused('VNEXT_EXTERNAL_RESEARCH_RESPONSE_INVALID', 'Research response violated status, origin, TLS, MIME, address, or byte bounds.', {
        diagnostics: responseCheck.reasons,
        runDir,
        sourceId: source.sourceId
      });
    }
    const { contentType } = responseCheck;
    totalBytes += response.body.length;
    if (totalBytes > plan.maximumTotalBytes) {
      return refused('VNEXT_EXTERNAL_RESEARCH_TOTAL_BYTES_EXCEEDED', 'Research responses exceeded the total byte ceiling.', { runDir });
    }
    const rawPath = `raw/${source.sourceId}.bin`;
    atomicWrite(join(runDir, rawPath), response.body);
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(response.body);
    } catch {
      return refused('VNEXT_EXTERNAL_RESEARCH_UTF8_INVALID', 'Research response is not valid UTF-8 text.', { runDir, sourceId: source.sourceId });
    }
    const content = decoded.slice(0, 32_000);
    const retrievedAt = now().toISOString();
    sources.push({
      id: source.sourceId,
      url: source.url,
      title: source.title,
      authorityClass: 'primary',
      retrievedAt,
      content,
      contentSha256: sha256(content),
      rawSha256: sha256(response.body),
      rawBytes: response.body.length,
      excerptTruncated: decoded.length > content.length,
      contentType,
      remoteAddresses: [...response.remoteAddresses].sort(),
      tlsAuthorized: true,
      tlsProtocol: response.tlsProtocol ?? null,
      rawPath
    });
  }
  const core = {
    schemaVersion: VNEXT_EXTERNAL_RESEARCH_FETCH_SCHEMA,
    planId: plan.planId,
    planSha256: plan.planSha256,
    fetchedAt: now().toISOString(),
    sourceCount: sources.length,
    totalRawBytes: totalBytes,
    sources,
    networkPerformed: true,
    sealedMode: false,
    activationAuthority: false,
    promotionAuthority: false
  };
  const receipt = {
    ...core,
    receiptSha256: sha256(canonicalVNextJson(core))
  };
  atomicWrite(join(runDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return { status: 'OK', runDir, receipt, sources };
}

function receiptSourceValid(source, planSource, plan, receipt) {
  return exactKeys(source, [
    'authorityClass', 'content', 'contentSha256', 'contentType',
    'excerptTruncated', 'id', 'rawBytes', 'rawPath', 'rawSha256',
    'remoteAddresses', 'retrievedAt', 'title', 'tlsAuthorized',
    'tlsProtocol', 'url'
  ])
    && source.id === planSource?.sourceId
    && source.url === planSource.url
    && source.title === planSource.title
    && source.authorityClass === 'primary'
    && typeof source.retrievedAt === 'string'
    && Number.isFinite(Date.parse(source.retrievedAt))
    && Date.parse(source.retrievedAt) >= Date.parse(plan.createdAt)
    && Date.parse(source.retrievedAt) <= Date.parse(receipt.fetchedAt)
    && boundedText(source.content, 32_000)
    && source.contentSha256 === sha256(source.content)
    && SHA256.test(String(source.rawSha256 || ''))
    && Number.isInteger(source.rawBytes)
    && source.rawBytes >= 1
    && source.rawBytes <= plan.maximumPerSourceBytes
    && typeof source.excerptTruncated === 'boolean'
    && ALLOWED_CONTENT.test(String(source.contentType || ''))
    && Array.isArray(source.remoteAddresses)
    && source.remoteAddresses.length >= 1
    && source.remoteAddresses.length <= 32
    && new Set(source.remoteAddresses).size === source.remoteAddresses.length
    && source.remoteAddresses.every(publicAddress)
    && source.tlsAuthorized === true
    && ['TLSv1.2', 'TLSv1.3'].includes(source.tlsProtocol)
    && source.rawPath === `raw/${source.id}.bin`;
}

function receiptValid(receipt, plan) {
  if (!exactKeys(receipt, [
    'activationAuthority', 'fetchedAt', 'networkPerformed', 'planId',
    'planSha256', 'promotionAuthority', 'receiptSha256', 'schemaVersion',
    'sealedMode', 'sourceCount', 'sources', 'totalRawBytes'
  ])
      || receipt.schemaVersion !== VNEXT_EXTERNAL_RESEARCH_FETCH_SCHEMA
      || receipt.planId !== plan.planId
      || receipt.planSha256 !== plan.planSha256
      || typeof receipt.fetchedAt !== 'string'
      || !Number.isFinite(Date.parse(receipt.fetchedAt))
      || Date.parse(receipt.fetchedAt) < Date.parse(plan.createdAt)
      || !Number.isInteger(receipt.sourceCount)
      || receipt.sourceCount !== plan.sources.length
      || !Number.isInteger(receipt.totalRawBytes)
      || receipt.totalRawBytes < 1
      || receipt.totalRawBytes > plan.maximumTotalBytes
      || !Array.isArray(receipt.sources)
      || receipt.sources.length !== receipt.sourceCount
      || receipt.networkPerformed !== true
      || receipt.sealedMode !== false
      || receipt.activationAuthority !== false
      || receipt.promotionAuthority !== false
      || !SHA256.test(String(receipt.receiptSha256 || ''))) return false;
  const planById = new Map(plan.sources.map((source) => [source.sourceId, source]));
  if (receipt.sources.some((source) => !receiptSourceValid(
    source,
    planById.get(source.id),
    plan,
    receipt
  ))) return false;
  const core = structuredClone(receipt);
  delete core.receiptSha256;
  return sha256(canonicalVNextJson(core)) === receipt.receiptSha256;
}

export function verifyExternalResearchPortableEvidence(evidence) {
  try {
    if (!exactKeys(evidence, [
      'evidenceSha256', 'plan', 'rawSources', 'receipt', 'schemaVersion'
    ])
        || evidence.schemaVersion !== VNEXT_EXTERNAL_RESEARCH_EVIDENCE_SCHEMA
        || validateExternalResearchPlan(evidence.plan).status !== 'OK'
        || !receiptValid(evidence.receipt, evidence.plan)
        || !Array.isArray(evidence.rawSources)
        || evidence.rawSources.length !== evidence.receipt.sourceCount
        || !SHA256.test(String(evidence.evidenceSha256 || ''))) {
      return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', 'Portable research evidence shape is invalid.');
    }
    const core = {
      plan: evidence.plan,
      receipt: evidence.receipt,
      rawSources: evidence.rawSources
    };
    if (sha256(canonicalVNextJson(core)) !== evidence.evidenceSha256) {
      return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_TAMPERED', 'Portable research evidence hash changed.');
    }
    const rawById = new Map();
    for (const source of evidence.rawSources) {
      if (!exactKeys(source, ['rawBase64', 'rawBytes', 'rawSha256', 'sourceId'])
          || !isSafeId(source.sourceId)
          || typeof source.rawBase64 !== 'string'
          || !Number.isInteger(source.rawBytes)
          || !SHA256.test(String(source.rawSha256 || ''))
          || rawById.has(source.sourceId)) {
        return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', 'Portable raw source record is invalid.');
      }
      const raw = Buffer.from(source.rawBase64, 'base64');
      if (raw.toString('base64') !== source.rawBase64
          || raw.length !== source.rawBytes
          || sha256(raw) !== source.rawSha256) {
        return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_TAMPERED', 'Portable raw source bytes changed.');
      }
      rawById.set(source.sourceId, raw);
    }
    let total = 0;
    for (const source of evidence.receipt.sources) {
      const raw = rawById.get(source.id);
      if (!raw || raw.length !== source.rawBytes || sha256(raw) !== source.rawSha256) {
        return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_TAMPERED', 'Research receipt no longer matches raw source bytes.');
      }
      let decoded;
      try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch {
        return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', 'Research source is not valid UTF-8.');
      }
      const excerpt = decoded.slice(0, 32_000);
      if (excerpt !== source.content
          || source.excerptTruncated !== (decoded.length > excerpt.length)) {
        return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_TAMPERED', 'Research excerpt does not derive from raw source bytes.');
      }
      total += raw.length;
    }
    if (total !== evidence.receipt.totalRawBytes) {
      return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', 'Research total byte receipt does not replay.');
    }
    return {
      status: 'OK',
      plan: evidence.plan,
      receipt: evidence.receipt,
      evidence,
      evidenceSha256: evidence.evidenceSha256
    };
  } catch (error) {
    return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', error.message);
  }
}

export function verifyExternalResearchFetchRun({ runDir } = {}) {
  try {
    const root = resolve(runDir);
    const plan = JSON.parse(readFileSync(join(root, 'plan.json'), 'utf8'));
    const receipt = JSON.parse(readFileSync(join(root, 'receipt.json'), 'utf8'));
    const rawSources = receipt.sources.map((source) => {
      const rawPath = resolve(root, source.rawPath);
      const rel = relative(root, rawPath);
      const portableRel = rel.split(sep).join('/');
      if (portableRel !== source.rawPath
          || rel.startsWith('..')
          || isAbsolute(rel)
          || !existsSync(rawPath)
          || lstatSync(rawPath).isSymbolicLink()) {
        throw new Error('Research raw artifact path is invalid.');
      }
      const raw = readFileSync(rawPath);
      return {
        sourceId: source.id,
        rawBase64: raw.toString('base64'),
        rawBytes: raw.length,
        rawSha256: sha256(raw)
      };
    });
    const core = { plan, receipt, rawSources };
    return verifyExternalResearchPortableEvidence({
      schemaVersion: VNEXT_EXTERNAL_RESEARCH_EVIDENCE_SCHEMA,
      ...core,
      evidenceSha256: sha256(canonicalVNextJson(core))
    });
  } catch (error) {
    return refused('VNEXT_EXTERNAL_RESEARCH_REPLAY_INVALID', error.message);
  }
}

export function createExternalResearchPortableEvidence({ runDir } = {}) {
  const replay = verifyExternalResearchFetchRun({ runDir });
  return replay.status === 'OK'
    ? { status: 'OK', evidence: replay.evidence, evidenceSha256: replay.evidenceSha256 }
    : replay;
}
