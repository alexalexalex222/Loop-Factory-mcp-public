import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import {
  ADAPTIVE_SCHEMA,
  canonicalAdaptiveJson,
  isCausallyAdmittedCanaryImport,
  selectLatestApplicationRevisions,
  validateAdaptiveRecord
} from './adaptive-records.mjs';
import { deriveAdaptiveCanaryImport } from './adaptive-canary-import.mjs';
import { verifyAdaptiveRecursiveCanaryRun } from './adaptive-recursive-runner.mjs';
import { verifyAdaptiveRecursiveCanaryV2Run } from './adaptive-recursive-runner-v2.mjs';
import {
  MECHANISM_EVOLUTION_ADMISSION_V2,
  validateMechanismEvolutionAdmissionV2
} from './mechanism-evolution-admission-v2.mjs';
import {
  RECURSIVE_REPLICATED_ANALYSIS_SCHEMA,
  validateRecursiveReplicatedAnalysis
} from './adaptive-recursive-statistics.mjs';
import { round, sha256 } from './util.mjs';
import { deriveActiveEvolutionRoutingApplications } from './mechanism-router.mjs';

export const MECHANISM_CATALOG_SCHEMA_VERSION = 'mechanism-catalog-v1';
export const ADAPTIVE_LEDGER_ENTRY_SCHEMA_VERSION = 'adaptive-ledger-entry-v1';
const LOCK_STALE_MS = 30 * 1000;
const SHA256_RE = /^[a-f0-9]{64}$/;

const RECORD_TYPES = Object.freeze({
  [ADAPTIVE_SCHEMA.FAMILY]: {
    dir: 'families',
    idField: 'familyId',
    hashField: 'familySha256',
    filename: (record) => `${record.familyId}.json`
  },
  [ADAPTIVE_SCHEMA.APPLICATION]: {
    dir: 'application-receipts',
    idField: 'applicationReceiptId',
    hashField: 'applicationSha256',
    filename: (record) => `${record.applicationReceiptId}.json`
  },
  [ADAPTIVE_SCHEMA.CANARY_IMPORT]: {
    dir: 'canary-imports',
    idField: 'applicationReceiptId',
    hashField: 'applicationSha256',
    filename: (record) => `${record.applicationReceiptId}.json`
  },
  [ADAPTIVE_SCHEMA.MEASUREMENT]: {
    dir: 'measurements',
    idField: 'measurementId',
    hashField: 'measurementSha256',
    filename: (record) => `${record.measurementId}.json`
  },
  [ADAPTIVE_SCHEMA.EVOLUTION]: {
    dir: 'evolutions',
    idField: 'evolutionReceiptId',
    hashField: 'evolutionSha256',
    filename: (record) => `${record.evolutionReceiptId}.json`
  },
  [MECHANISM_EVOLUTION_ADMISSION_V2]: {
    dir: 'evolution-admissions',
    idField: 'admissionReceiptId',
    hashField: 'admissionSha256',
    filename: (record) => `${record.admissionReceiptId}.json`
  },
  [RECURSIVE_REPLICATED_ANALYSIS_SCHEMA]: {
    dir: 'recursive-analyses',
    idField: 'analysisSha256',
    hashField: 'analysisSha256',
    filename: (record) => `${record.analysisSha256}.json`
  },
  [ADAPTIVE_SCHEMA.ROUTING_DECISION]: {
    dir: 'routing-decisions',
    idField: 'routingDecisionId',
    hashField: 'routingDecisionSha256',
    filename: (record) => `${record.routingDecisionId}.json`
  },
  [ADAPTIVE_SCHEMA.POLICY_EPOCH]: {
    dir: 'policy-epochs',
    idField: 'policyEpochId',
    hashField: 'policyEpochSha256',
    filename: (record) => `${record.policyEpochId}.json`
  },
  [ADAPTIVE_SCHEMA.AUTO_PROMOTION]: {
    dir: 'automatic-promotion-decisions',
    idField: 'automaticPromotionDecisionId',
    hashField: 'automaticPromotionDecisionSha256',
    filename: (record) => `${record.automaticPromotionDecisionId}.json`
  }
});

function ok(extra = {}) {
  return { status: 'OK', ...extra };
}

function refused(code, message, extra = {}) {
  return { status: 'REFUSED', code, message, ...extra };
}

function normalizedHome(homeDir) {
  if (typeof homeDir !== 'string'
      || !homeDir
      || homeDir.includes('\0')
      || !isAbsolute(homeDir)
      || normalize(homeDir) !== homeDir) {
    return null;
  }
  return resolve(homeDir);
}

function within(base, target) {
  const rel = relative(base, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function ensureNoSymlink(paths) {
  for (const path of paths) {
    if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
      return refused('SYMLINK_REFUSED', 'Adaptive catalog paths cannot be symbolic links.');
    }
  }
  return ok();
}

function pathsFor(home) {
  const root = resolve(home, 'adaptive-memory-v1');
  const directories = Object.fromEntries(
    Object.entries(RECORD_TYPES).map(([schemaVersion, config]) => [
      schemaVersion,
      resolve(root, config.dir)
    ])
  );
  return {
    home,
    root,
    directories,
    catalogPath: resolve(root, 'catalog.json'),
    ledgerPath: resolve(root, 'ledger.jsonl'),
    lockPath: resolve(root, '.lock'),
    staleLocksDir: resolve(root, 'stale-locks')
  };
}

function validatePaths(paths) {
  const targets = [
    paths.root,
    paths.catalogPath,
    paths.ledgerPath,
    paths.lockPath,
    paths.staleLocksDir,
    ...Object.values(paths.directories)
  ];
  if (!targets.every((target) => within(paths.home, target))
      || !Object.values(paths.directories).every((target) => within(paths.root, target))) {
    return refused('PATH_ESCAPE', 'Adaptive catalog path escaped its configured home.');
  }
  return ensureNoSymlink([paths.home, paths.root, ...Object.values(paths.directories)]);
}

function archiveStaleLock(paths, nowMs, staleAfterMs) {
  if (!existsSync(paths.lockPath)) return ok({ archived: false });
  const ageMs = nowMs - statSync(paths.lockPath).mtimeMs;
  if (!Number.isFinite(ageMs) || ageMs <= staleAfterMs) {
    return refused('CATALOG_LOCKED', 'Another adaptive catalog writer holds the lock.');
  }
  const bytes = readFileSync(paths.lockPath);
  const digest = sha256(bytes);
  mkdirSync(paths.staleLocksDir, { recursive: true });
  const archivePath = resolve(
    paths.staleLocksDir,
    `lock-${String(Math.floor(nowMs))}-${digest.slice(0, 16)}.json`
  );
  if (!within(paths.staleLocksDir, archivePath)) {
    return refused('PATH_ESCAPE', 'Stale lock archive escaped its configured directory.');
  }
  renameSync(paths.lockPath, archivePath);
  return ok({ archived: true, archivePath });
}

function acquireLock(paths, {
  now = () => Date.now(),
  staleAfterMs = LOCK_STALE_MS
} = {}) {
  mkdirSync(paths.root, { recursive: true });
  let fd;
  let archived = null;
  try {
    fd = openSync(paths.lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    archived = archiveStaleLock(paths, now(), staleAfterMs);
    if (archived.status !== 'OK') return archived;
    fd = openSync(paths.lockPath, 'wx', 0o600);
  }
  const lockRecord = {
    schemaVersion: 'adaptive-catalog-lock-v1',
    pid: process.pid,
    acquiredAtMs: now()
  };
  writeFileSync(fd, `${canonicalAdaptiveJson(lockRecord)}\n`, 'utf8');
  return ok({
    fd,
    lockPath: paths.lockPath,
    staleLockPath: archived?.archivePath || null
  });
}

function releaseLock(lock) {
  if (!lock || lock.status !== 'OK') return;
  try {
    closeSync(lock.fd);
  } finally {
    try {
      unlinkSync(lock.lockPath);
    } catch {
      // A failed unlock remains visible and will be archived after the stale window.
    }
  }
}

function atomicWrite(path, bytes) {
  const tempPath = `${path}.tmp-${process.pid}-${sha256(bytes).slice(0, 12)}`;
  writeFileSync(tempPath, bytes, { encoding: 'utf8', flag: 'wx' });
  renameSync(tempPath, path);
}

function recordIdentity(record) {
  const type = RECORD_TYPES[record?.schemaVersion];
  if (!type) return null;
  const id = record[type.idField];
  const digest = record[type.hashField];
  if (typeof id !== 'string' || !SHA256_RE.test(String(digest || ''))) return null;
  return { type, id, digest };
}

function validateCatalogRecord(record) {
  if (record?.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2) {
    return validateMechanismEvolutionAdmissionV2(record);
  }
  if (record?.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA) {
    return validateRecursiveReplicatedAnalysis(record);
  }
  return validateAdaptiveRecord(record);
}

function scanRecords(paths, schemaFilter = null) {
  const records = [];
  const rejected = [];
  const schemas = schemaFilter ? [schemaFilter] : Object.keys(RECORD_TYPES);
  for (const schemaVersion of schemas) {
    const type = RECORD_TYPES[schemaVersion];
    if (!type) {
      return refused('UNKNOWN_ADAPTIVE_SCHEMA', `Unknown adaptive schema "${schemaVersion}".`);
    }
    const directory = paths.directories[schemaVersion];
    if (!existsSync(directory)) continue;
    const safety = ensureNoSymlink([directory]);
    if (safety.status !== 'OK') return safety;
    for (const filename of readdirSync(directory).sort()) {
      if (!filename.endsWith('.json')) continue;
      const recordPath = resolve(directory, filename);
      if (!within(directory, recordPath)) {
        rejected.push({ schemaVersion, filename, code: 'PATH_ESCAPE' });
        continue;
      }
      if (lstatSync(recordPath).isSymbolicLink()) {
        rejected.push({ schemaVersion, filename, code: 'SYMLINK_REFUSED' });
        continue;
      }
      try {
        const record = JSON.parse(readFileSync(recordPath, 'utf8'));
        const validation = validateCatalogRecord(record);
        const identity = recordIdentity(record);
        if (validation.status !== 'OK'
            || !identity
            || type.filename(record) !== filename) {
          rejected.push({
            schemaVersion,
            filename,
            code: validation.code || 'RECORD_FILENAME_MISMATCH'
          });
          continue;
        }
        records.push({ record, recordPath, filename, identity });
      } catch {
        rejected.push({ schemaVersion, filename, code: 'RECORD_PARSE_FAILED' });
      }
    }
  }
  records.sort((left, right) => (
    left.record.schemaVersion.localeCompare(right.record.schemaVersion)
    || left.identity.id.localeCompare(right.identity.id)
    || left.identity.digest.localeCompare(right.identity.digest)
  ));
  rejected.sort((left, right) => (
    left.schemaVersion.localeCompare(right.schemaVersion)
    || left.filename.localeCompare(right.filename)
  ));
  return ok({ records, rejected });
}

function applicationIsContradicted(application) {
  return application.outcome?.verdict === 'regression'
    || (application.outcome?.controlRegressions ?? 0) > 0
    || (application.outcome?.contradictionCodes || []).length > 0
    || (application.outcome?.transferChecks || []).some((check) => (
      check.attempted && check.passed === false
    ));
}

function applicationCanRouteMechanism(application) {
  return application.eligibleForRouting === true
    && application.routing?.allocation !== 'control';
}

function latestApplications(records) {
  const selected = selectLatestApplicationRevisions(records.filter((record) => (
    record.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
  )));
  if (selected.status !== 'OK') return [];
  const imports = records.filter((record) => (
    record.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
    && isCausallyAdmittedCanaryImport(record)
  ));
  const importsByEvidence = new Map();
  for (const record of imports) {
    const evidenceSha256 = record.evidence.verifierEvidenceSha256;
    if (!importsByEvidence.has(evidenceSha256)) {
      importsByEvidence.set(evidenceSha256, record);
    }
  }
  return [...selected.applications, ...importsByEvidence.values()].sort((left, right) => (
    left.applicationReceiptId.localeCompare(right.applicationReceiptId)
  ));
}

function familyCatalogRows(records) {
  const families = records
    .filter((record) => record.schemaVersion === ADAPTIVE_SCHEMA.FAMILY);
  const applications = records.filter((record) => (
    record.schemaVersion === ADAPTIVE_SCHEMA.APPLICATION
    || record.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
  ));
  const recursive = deriveActiveEvolutionRoutingApplications({
    families,
    evolutions: records.filter((record) => record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION),
    measurements: records.filter((record) => record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT),
    admissions: records.filter((record) => (
      record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
    )),
    analyses: records.filter((record) => (
      record.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
    ))
  });
  const recursiveApplications = recursive.status === 'OK' ? recursive.applications : [];
  const currentApplications = [
    ...latestApplications(records),
    ...recursiveApplications
  ];
  return families.map((family) => {
    const receipts = applications.filter((item) => item.familyId === family.familyId);
    const attempts = currentApplications.filter((item) => item.familyId === family.familyId);
    const activeEvolutionCount = recursiveApplications
      .filter((item) => item.familyId === family.familyId).length;
    const positive = attempts.filter((item) => item.credit?.positiveEvidence === true);
    const contradicted = attempts.filter(applicationIsContradicted);
    const reverifiedContradictions = contradicted.filter((item) => item.outcome?.reverified === true);
    const positiveRuns = new Set(positive
      .filter((item) => item.outcome?.reverified === true)
      .map((item) => item.source?.runId)
      .filter(Boolean));
    const confidenceValues = attempts
      .map((item) => item.credit?.confidence)
      .filter(Number.isFinite);
    const quarantined = reverifiedContradictions.length > 0;
    const lifecycle = contradicted.length
      ? 'contradicted'
      : (positiveRuns.size >= 2 ? 'replicated' : 'observed');
    const verdicts = {
      improvement: 0,
      no_improvement: 0,
      tradeoff: 0,
      invalid: 0,
      regression: 0
    };
    for (const application of attempts) {
      if (Object.hasOwn(verdicts, application.outcome?.verdict)) {
        verdicts[application.outcome.verdict]++;
      }
    }
    return {
      familyId: family.familyId,
      familySha256: family.familySha256,
      lifecycle,
      quarantineStatus: quarantined ? 'QUARANTINED' : 'ACTIVE',
      quarantined,
      routingEligible: !quarantined
        && attempts.some(applicationCanRouteMechanism),
      receiptCount: receipts.length,
      applicationCount: attempts.length,
      validApplicationCount: attempts.filter((item) => item.outcome?.valid === true).length,
      routingEligibleApplicationCount: attempts
        .filter(applicationCanRouteMechanism).length,
      activeEvolutionCount,
      uniqueRunCount: new Set(attempts.map((item) => item.source?.runId).filter(Boolean)).size,
      confidence: confidenceValues.length
        ? round(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
        : null,
      creditConfidence: confidenceValues.length
        ? round(confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length)
        : null,
      positiveEvidenceCount: positive.length,
      reverifiedPositiveRunCount: positiveRuns.size,
      failureDerivedCount: attempts.filter((item) => item.credit?.failureDerived === true).length,
      contradictionEvidenceCount: contradicted.length,
      failedTransferCount: attempts.filter((item) => (
        (item.outcome?.transferChecks || []).some((check) => (
          check.attempted && check.passed === false
        ))
      )).length,
      transferEvidence: {
        passed: attempts.filter((item) => (
          (item.outcome?.transferChecks || []).some((check) => (
            check.attempted && check.passed === true
          ))
        )).length,
        failed: attempts.filter((item) => (
          (item.outcome?.transferChecks || []).some((check) => (
            check.attempted && check.passed === false
          ))
        )).length,
        unknown: attempts.filter((item) => (
          !(item.outcome?.transferChecks || []).some((check) => check.attempted)
        )).length
      },
      verdicts
    };
  }).sort((left, right) => left.familyId.localeCompare(right.familyId));
}

function ledgerEntry(paths, item) {
  return {
    schemaVersion: ADAPTIVE_LEDGER_ENTRY_SCHEMA_VERSION,
    recordSchemaVersion: item.record.schemaVersion,
    recordId: item.identity.id,
    recordSha256: item.identity.digest,
    path: relative(paths.root, item.recordPath).split(sep).join('/')
  };
}

function buildCatalog(records, rejected, rejectedLedgerEntries = []) {
  const counts = Object.fromEntries(
    Object.keys(RECORD_TYPES).map((schemaVersion) => [
      schemaVersion,
      records.filter((record) => record.schemaVersion === schemaVersion).length
    ])
  );
  const payload = {
    schemaVersion: MECHANISM_CATALOG_SCHEMA_VERSION,
    recordCount: records.length,
    rejectedCount: rejected.length,
    rejectedRecordCount: rejected.length,
    rejectedLedgerEntryCount: rejectedLedgerEntries.length,
    counts,
    families: familyCatalogRows(records),
    rejected,
    rejectedLedgerEntries
  };
  return {
    ...payload,
    catalogSha256: sha256(canonicalAdaptiveJson(payload))
  };
}

function reconcileUnlocked(paths) {
  const scanned = scanRecords(paths);
  if (scanned.status !== 'OK') return scanned;
  const records = scanned.records.map((item) => item.record);
  const entries = scanned.records.map((item) => ledgerEntry(paths, item));
  const expectedByKey = new Map(entries.map((entry) => [
    `${entry.recordSchemaVersion}:${entry.recordId}:${entry.recordSha256}`,
    canonicalAdaptiveJson(entry)
  ]));
  const existingKeys = new Set();
  const rejectedLedgerEntries = [];
  if (existsSync(paths.ledgerPath)) {
    const ledgerSafety = ensureNoSymlink([paths.ledgerPath]);
    if (ledgerSafety.status !== 'OK') return ledgerSafety;
    for (const [lineIndex, line] of readFileSync(paths.ledgerPath, 'utf8').split('\n').entries()) {
      if (!line) continue;
      try {
        const entry = JSON.parse(line);
        const key = `${entry.recordSchemaVersion}:${entry.recordId}:${entry.recordSha256}`;
        if (entry.schemaVersion !== ADAPTIVE_LEDGER_ENTRY_SCHEMA_VERSION
            || expectedByKey.get(key) !== canonicalAdaptiveJson(entry)) {
          rejectedLedgerEntries.push({ line: lineIndex + 1, code: 'LEDGER_ENTRY_MISMATCH' });
          continue;
        }
        existingKeys.add(key);
      } catch {
        rejectedLedgerEntries.push({ line: lineIndex + 1, code: 'LEDGER_ENTRY_PARSE_FAILED' });
      }
    }
  }
  const missingEntries = entries.filter((entry) => !existingKeys.has(
    `${entry.recordSchemaVersion}:${entry.recordId}:${entry.recordSha256}`
  ));
  const catalog = buildCatalog(records, scanned.rejected, rejectedLedgerEntries);
  const indexSafety = ensureNoSymlink([paths.catalogPath, paths.ledgerPath]);
  if (indexSafety.status !== 'OK') return indexSafety;
  atomicWrite(paths.catalogPath, `${canonicalAdaptiveJson(catalog)}\n`);
  if (missingEntries.length) {
    appendFileSync(
      paths.ledgerPath,
      `${missingEntries.map((entry) => canonicalAdaptiveJson(entry)).join('\n')}\n`,
      { encoding: 'utf8', flag: 'a' }
    );
  } else if (!existsSync(paths.ledgerPath)) {
    writeFileSync(paths.ledgerPath, '', { encoding: 'utf8', flag: 'wx' });
  }
  return ok({
    catalog,
    recordCount: records.length,
    rejected: scanned.rejected,
    rejectedRecords: scanned.rejected,
    rejectedLedgerEntries,
    appendedEntries: missingEntries.length,
    catalogPath: paths.catalogPath,
    ledgerPath: paths.ledgerPath
  });
}

function persistAdaptiveRecordInternal({
  homeDir,
  record,
  hooks = {},
  now,
  staleAfterMs,
  allowCanaryImport = false,
  allowVerifierMeasurement = false,
  allowVerifierEvolution = false,
  allowVerifierAdmission = false,
  allowVerifierAnalysis = false
} = {}) {
  if (record?.schemaVersion === ADAPTIVE_SCHEMA.CANARY_IMPORT
      && allowCanaryImport !== true) {
    return refused(
      'CANARY_IMPORT_VERIFIER_REQUIRED',
      'Canary import records must be derived and persisted through the verifier-owned import boundary.'
    );
  }
  if (record?.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT
      && allowVerifierMeasurement !== true) {
    return refused(
      'ADAPTIVE_MEASUREMENT_VERIFIER_REQUIRED',
      'Measurement v2 records must be derived and persisted through a verifier-owned boundary.'
    );
  }
  if (record?.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
      && ['VERIFIED', 'ACTIVE'].includes(record.state)
      && allowVerifierEvolution !== true) {
    return refused(
      'MECHANISM_EVOLUTION_VERIFIER_REQUIRED',
      'Verified or active evolution states require a dedicated independent-verifier persistence boundary.'
    );
  }
  if (record?.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2
      && ['VERIFIED', 'ACTIVE'].includes(record.state)
      && allowVerifierAdmission !== true) {
    return refused(
      'MECHANISM_EVOLUTION_ADMISSION_VERIFIER_REQUIRED',
      'Verified or active replicated admissions require a dedicated independent-verifier persistence boundary.'
    );
  }
  if (record?.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
      && allowVerifierAnalysis !== true) {
    return refused(
      'RECURSIVE_ANALYSIS_VERIFIER_REQUIRED',
      'Replicated recursive analyses must be persisted through a verifier-owned boundary.'
    );
  }
  const validation = validateCatalogRecord(record);
  if (validation.status !== 'OK') return validation;
  const identity = recordIdentity(record);
  if (!identity) return refused('INVALID_ADAPTIVE_RECORD', 'Adaptive record identity is missing.');
  const home = normalizedHome(homeDir);
  if (!home) return refused('UNSAFE_HOME', 'homeDir must be a normalized absolute path.');
  const paths = pathsFor(home);
  const safety = validatePaths(paths);
  if (safety.status !== 'OK') return safety;
  let lock;
  try {
    lock = acquireLock(paths, { now, staleAfterMs });
    if (lock.status !== 'OK') return lock;
    const directory = paths.directories[record.schemaVersion];
    mkdirSync(directory, { recursive: true });
    const recordPath = resolve(directory, identity.type.filename(record));
    if (!within(directory, recordPath)) {
      return refused('PATH_ESCAPE', 'Adaptive record path escaped its schema directory.');
    }
    const pathSafety = ensureNoSymlink([directory, recordPath]);
    if (pathSafety.status !== 'OK') return pathSafety;
    const bytes = `${canonicalAdaptiveJson(record)}\n`;
    let idempotent = false;
    try {
      writeFileSync(recordPath, bytes, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (readFileSync(recordPath, 'utf8') !== bytes) {
        return refused(
          'IMMUTABLE_RECORD_CONFLICT',
          `Immutable adaptive record ${identity.id} already exists with different bytes.`,
          { recordPath }
        );
      }
      idempotent = true;
    }
    if (typeof hooks.afterRecordWrite === 'function') {
      hooks.afterRecordWrite({ recordPath, idempotent });
    }
    const reconciled = reconcileUnlocked(paths);
    if (reconciled.status !== 'OK') return reconciled;
    return ok({
      recordId: identity.id,
      recordSha256: identity.digest,
      recordPath,
      idempotent,
      catalogSha256: reconciled.catalog.catalogSha256,
      appendedEntries: reconciled.appendedEntries,
      staleLockPath: lock.staleLockPath,
      catalogPath: reconciled.catalogPath,
      ledgerPath: reconciled.ledgerPath
    });
  } catch (error) {
    return refused('ADAPTIVE_RECORD_PERSIST_FAILED', error.message);
  } finally {
    releaseLock(lock);
  }
}

export function persistAdaptiveRecord(args = {}) {
  return persistAdaptiveRecordInternal(args);
}

export function persistAdaptiveCanaryImport({
  homeDir,
  sourceStore,
  runId,
  automatic = false
} = {}) {
  const built = deriveAdaptiveCanaryImport({ sourceStore, runId, automatic });
  if (built.status !== 'OK') return built;
  const familyPersisted = persistAdaptiveRecordInternal({
    homeDir,
    record: built.family
  });
  if (familyPersisted.status !== 'OK') return familyPersisted;
  const measurementPersisted = persistAdaptiveRecordInternal({
    homeDir,
    record: built.measurementV2,
    allowVerifierMeasurement: true
  });
  if (measurementPersisted.status !== 'OK') return measurementPersisted;
  const importPersisted = persistAdaptiveRecordInternal({
    homeDir,
    record: built.record,
    allowCanaryImport: true
  });
  if (importPersisted.status !== 'OK') return importPersisted;
  return ok({
    family: built.family,
    record: built.record,
    measurement: built.measurement,
    measurementV2: built.measurementV2,
    verification: built.verification,
    familyPersisted,
    measurementPersisted,
    importPersisted
  });
}

export function persistAdaptiveRecursiveCanaryResult({
  homeDir,
  sourceStore,
  runId
} = {}) {
  const verification = verifyAdaptiveRecursiveCanaryRun(sourceStore, runId);
  if (verification.experimentValid !== true || !verification.measurement) {
    return refused(
      'RECURSIVE_CANARY_VERIFIER_REQUIRED',
      'Recursive canary persistence requires a currently valid independent verification.',
      { verification }
    );
  }
  const state = sourceStore.load(runId);
  const configArtifact = sourceStore.readArtifact(
    runId,
    state?.evidenceArtifacts?.config?.id
  );
  let config;
  try {
    config = JSON.parse(configArtifact?.content || '');
  } catch {
    return refused(
      'RECURSIVE_CANARY_CONFIG_INVALID',
      'The verifier-bound recursive config could not be reopened.'
    );
  }
  const records = [
    config.parentFamily,
    config.candidateFamily,
    config.evolutionRecord,
    verification.measurement,
    verification.verifiedEvolution,
    verification.activeEvolution,
    verification.rejectedEvolution
  ].filter(Boolean);
  const persisted = [];
  for (const record of records) {
    const result = persistAdaptiveRecordInternal({
      homeDir,
      record,
      allowVerifierMeasurement: record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT,
      allowVerifierEvolution: record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
        && ['VERIFIED', 'ACTIVE'].includes(record.state)
    });
    if (result.status !== 'OK') return result;
    persisted.push({
      schemaVersion: record.schemaVersion,
      state: record.state || null,
      recordId: result.recordId,
      recordSha256: result.recordSha256,
      idempotent: result.idempotent
    });
  }
  return ok({
    runId,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible,
    verifierEvidenceSha256: verification.evidenceSha256,
    persisted,
    verification
  });
}

export function persistAdaptiveRecursiveCanaryV2Result({
  homeDir,
  sourceStore,
  runId
} = {}) {
  const verification = verifyAdaptiveRecursiveCanaryV2Run(sourceStore, runId);
  if (verification.experimentValid !== true
      || !verification.calibrationMeasurement
      || !verification.calibrationAnalysis) {
    return refused(
      'RECURSIVE_CANARY_V2_VERIFIER_REQUIRED',
      'Recursive V2 persistence requires a currently valid independent verification.',
      { verification }
    );
  }
  const state = sourceStore.load(runId);
  const configArtifact = sourceStore.readArtifact(
    runId,
    state?.evidenceArtifacts?.config?.id
  );
  let config;
  try {
    config = JSON.parse(configArtifact?.content || '');
  } catch {
    return refused(
      'RECURSIVE_CANARY_V2_CONFIG_INVALID',
      'The verifier-bound recursive V2 config could not be reopened.'
    );
  }
  const records = [
    config.parentFamily,
    config.candidateFamily,
    config.evolutionRecord,
    verification.calibrationMeasurement,
    verification.calibrationAnalysis,
    verification.confirmationMeasurement,
    verification.confirmationAnalysis,
    verification.verifiedAdmission,
    verification.activeAdmission,
    verification.rejectedAdmission,
    verification.rejectedEvolution
  ].filter(Boolean);
  const persisted = [];
  for (const record of records) {
    const result = persistAdaptiveRecordInternal({
      homeDir,
      record,
      allowVerifierMeasurement: record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT,
      allowVerifierEvolution: record.schemaVersion === ADAPTIVE_SCHEMA.EVOLUTION
        && ['VERIFIED', 'ACTIVE'].includes(record.state),
      allowVerifierAdmission:
        record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2,
      allowVerifierAnalysis:
        record.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
    });
    if (result.status !== 'OK') return result;
    persisted.push({
      schemaVersion: record.schemaVersion,
      state: record.state || null,
      recordId: result.recordId,
      recordSha256: result.recordSha256,
      idempotent: result.idempotent
    });
  }
  return ok({
    runId,
    calibrationQualified: verification.calibrationQualified,
    causalPass: verification.causalPass,
    activationEligible: verification.activationEligible,
    verifierEvidenceSha256: verification.evidenceSha256,
    persisted,
    verification
  });
}

export function persistAdaptiveRecursiveCanaryV2DevelopmentResult({
  homeDir,
  sourceStore,
  runId
} = {}) {
  const verification = verifyAdaptiveRecursiveCanaryV2Run(sourceStore, runId);
  if (verification.experimentValid !== true
      || !verification.calibrationMeasurement
      || !verification.calibrationAnalysis) {
    return refused(
      'RECURSIVE_CANARY_V2_DEVELOPMENT_VERIFIER_REQUIRED',
      'Development persistence requires a currently valid recursive V2 verification.',
      { verification }
    );
  }
  const state = sourceStore.load(runId);
  const configArtifact = sourceStore.readArtifact(
    runId,
    state?.evidenceArtifacts?.config?.id
  );
  let config;
  try {
    config = JSON.parse(configArtifact?.content || '');
  } catch {
    return refused(
      'RECURSIVE_CANARY_V2_CONFIG_INVALID',
      'The verifier-bound recursive V2 config could not be reopened.'
    );
  }
  const records = [
    config.parentFamily,
    config.candidateFamily,
    config.evolutionRecord,
    verification.calibrationMeasurement,
    verification.calibrationAnalysis,
    verification.confirmationMeasurement,
    verification.confirmationAnalysis,
    verification.rejectedAdmission,
    verification.rejectedEvolution
  ].filter(Boolean);
  const persisted = [];
  for (const record of records) {
    const result = persistAdaptiveRecordInternal({
      homeDir,
      record,
      allowVerifierMeasurement: record.schemaVersion === ADAPTIVE_SCHEMA.MEASUREMENT,
      allowVerifierEvolution: false,
      allowVerifierAdmission:
        record.schemaVersion === MECHANISM_EVOLUTION_ADMISSION_V2,
      allowVerifierAnalysis:
        record.schemaVersion === RECURSIVE_REPLICATED_ANALYSIS_SCHEMA
    });
    if (result.status !== 'OK') return result;
    persisted.push({
      schemaVersion: record.schemaVersion,
      state: record.state || null,
      recordId: result.recordId,
      recordSha256: result.recordSha256,
      idempotent: result.idempotent
    });
  }
  return ok({
    runId,
    mode: 'development-only',
    childCausalPass: verification.causalPass,
    activationEligible: false,
    verifierEvidenceSha256: verification.evidenceSha256,
    persisted,
    verification
  });
}

export function reconcileMechanismCatalog({
  homeDir,
  now,
  staleAfterMs
} = {}) {
  const home = normalizedHome(homeDir);
  if (!home) return refused('UNSAFE_HOME', 'homeDir must be a normalized absolute path.');
  const paths = pathsFor(home);
  const safety = validatePaths(paths);
  if (safety.status !== 'OK') return safety;
  let lock;
  try {
    lock = acquireLock(paths, { now, staleAfterMs });
    if (lock.status !== 'OK') return lock;
    const reconciled = reconcileUnlocked(paths);
    return reconciled.status === 'OK'
      ? { ...reconciled, staleLockPath: lock.staleLockPath }
      : reconciled;
  } catch (error) {
    return refused('CATALOG_RECONCILE_FAILED', error.message);
  } finally {
    releaseLock(lock);
  }
}

export function listAdaptiveRecords({
  homeDir,
  schemaVersion = null
} = {}) {
  const home = normalizedHome(homeDir);
  if (!home) return refused('UNSAFE_HOME', 'homeDir must be a normalized absolute path.');
  if (schemaVersion != null && !RECORD_TYPES[schemaVersion]) {
    return refused('UNKNOWN_ADAPTIVE_SCHEMA', `Unknown adaptive schema "${schemaVersion}".`);
  }
  const paths = pathsFor(home);
  const safety = validatePaths(paths);
  if (safety.status !== 'OK') return safety;
  const scanned = scanRecords(paths, schemaVersion);
  if (scanned.status !== 'OK') return scanned;
  return ok({
    records: scanned.records.map((item) => item.record),
    rejected: scanned.rejected
  });
}

export function loadMechanismCatalog({ homeDir } = {}) {
  const home = normalizedHome(homeDir);
  if (!home) return refused('UNSAFE_HOME', 'homeDir must be a normalized absolute path.');
  const paths = pathsFor(home);
  const safety = validatePaths(paths);
  if (safety.status !== 'OK') return safety;
  if (!existsSync(paths.catalogPath)) {
    return refused('CATALOG_NOT_FOUND', 'No reconciled mechanism catalog exists.');
  }
  try {
    const catalog = JSON.parse(readFileSync(paths.catalogPath, 'utf8'));
    const { catalogSha256, ...payload } = catalog;
    if (catalog.schemaVersion !== MECHANISM_CATALOG_SCHEMA_VERSION
        || !SHA256_RE.test(String(catalogSha256 || ''))
        || sha256(canonicalAdaptiveJson(payload)) !== catalogSha256) {
      return refused('CATALOG_HASH_MISMATCH', 'Mechanism catalog hash does not match its bytes.');
    }
    return ok({ catalog, catalogPath: paths.catalogPath });
  } catch (error) {
    return refused('CATALOG_READ_FAILED', error.message);
  }
}
