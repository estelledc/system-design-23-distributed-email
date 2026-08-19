import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

const root = new URL('..', import.meta.url);
const expected = [
  '.github/dependabot.yml',
  '.github/workflows/ci.yml',
  '.gitignore',
  '.node-version',
  'AGENTS.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'compose.yaml',
  'docs/adr/0001-postgres-recipient-attempt-authority.md',
  'docs/api.md',
  'docs/architecture.md',
  'docs/closed-book-contract.md',
  'docs/operations.md',
  'docs/requirements.md',
  'docs/research-log.md',
  'docs/threat-model.md',
  'docs/verification.md',
  'package-lock.json',
  'package.json',
  'scripts/infra-benchmark.mjs',
  'scripts/infra-smoke.mjs',
  'scripts/repo-check.mjs',
  'scripts/smtp-oracle-process.mjs',
  'sql/schema.sql',
  'src/contracts.js',
  'src/crypto.js',
  'src/errors.js',
  'src/http.js',
  'src/index.js',
  'src/main.js',
  'src/model.js',
  'src/repository.js',
  'src/service.js',
  'src/smtp-client.js',
  'src/smtp-oracle.js',
  'test/integration/postgresql.test.js',
  'test/unit/contracts.test.js',
  'test/unit/http.test.js',
  'test/unit/model.test.js',
];

async function walk(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) paths.push(...await walk(new URL(`${entry.name}/`, directory), relative));
    else paths.push(relative);
  }
  return paths;
}

for (const path of expected) {
  assert.equal((await stat(new URL(path, root))).isFile(), true, `missing required file: ${path}`);
}

const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
assert.equal(packageJson.private, true);
assert.equal(packageJson.engines.node, '>=22');
assert.deepEqual(packageJson.dependencies, { pg: '8.23.0' });
assert.equal(packageJson.repository.url, 'git+https://github.com/estelledc/system-design-23-distributed-email.git');
for (const script of ['lint', 'test', 'test:infra', 'smoke:infra', 'benchmark:infra', 'audit', 'check', 'check:ci']) {
  assert.equal(typeof packageJson.scripts[script], 'string', `missing package script: ${script}`);
}
const lock = JSON.parse(await readFile(new URL('package-lock.json', root), 'utf8'));
assert.equal(lock.lockfileVersion, 3);
assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies);

const workflow = await readFile(new URL('.github/workflows/ci.yml', root), 'utf8');
assert.match(workflow, /node: \[22, 24, 26\]/);
assert.match(workflow, /PostgreSQL 17\.11 \+ loopback SMTP/);
assert.match(workflow, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(workflow, /permissions:\n  contents: read/);
const actionUses = [...workflow.matchAll(/uses: [^@\n]+@([^\s#]+)/g)].map((match) => match[1]);
assert.ok(actionUses.length >= 2);
assert.ok(actionUses.every((reference) => /^[0-9a-f]{40}$/.test(reference)), 'actions must use full commit pins');

const compose = await readFile(new URL('compose.yaml', root), 'utf8');
assert.match(compose, /postgres:17\.11-alpine@sha256:[0-9a-f]{64}/);
assert.match(compose, /pg_isready -U postgres -d distributed_email/);

const schema = await readFile(new URL('sql/schema.sql', root), 'utf8');
for (const contract of [
  'PRIMARY KEY (principal, message_id)',
  'UNIQUE (principal, message_id, address_digest)',
  "state IN ('queued', 'retry_scheduled')",
  "'prepared', 'io_started', 'remote_accepted', 'transient_failure'",
  'PRIMARY KEY (principal, request_key, operation)',
  'FOREIGN KEY (current_attempt_id) REFERENCES attempts (attempt_id) DEFERRABLE INITIALLY DEFERRED',
]) assert.ok(schema.includes(contract), `missing schema contract: ${contract}`);

const repository = await readFile(new URL('src/repository.js', root), 'utf8');
for (const contract of [
  'pg_advisory_xact_lock',
  'FOR UPDATE SKIP LOCKED',
  "state = 'attempting'",
  "'unknown_after_io'",
  'statement_timestamp()',
  'completion_digest',
  'invariantGap',
]) assert.ok(repository.includes(contract), `missing repository contract: ${contract}`);

const service = await readFile(new URL('src/service.js', root), 'utf8');
for (const boundary of [
  'MAIL_CRASH_AFTER_SUBMIT_COMMIT',
  'MAIL_CRASH_AFTER_ATTEMPT_PREPARE_COMMIT',
  'MAIL_CRASH_AFTER_REMOTE_REPLY',
  'MAIL_CRASH_AFTER_COMPLETION_COMMIT',
]) assert.ok(service.includes(boundary), `missing process crash boundary: ${boundary}`);

const smtpClient = await readFile(new URL('src/smtp-client.js', root), 'utf8');
for (const contract of ['EHLO lab.invalid', 'MAIL FROM:', 'RCPT TO:', "socket.write('DATA", 'dataBytesSent = true']) {
  assert.ok(smtpClient.includes(contract), `missing SMTP client stage: ${contract}`);
}
const smtpOracle = await readFile(new URL('src/smtp-oracle.js', root), 'utf8');
for (const contract of ['handle.sync()', 'accept_without_reply', 'acceptedResponsibility', "host !== '127.0.0.1'"]) {
  assert.ok(smtpOracle.includes(contract), `missing SMTP oracle contract: ${contract}`);
}

const httpSource = await readFile(new URL('src/http.js', root), 'utf8');
const logBodies = [...httpSource.matchAll(/logger\(\{([\s\S]*?)\}\)/g)].map((match) => match[1]);
assert.ok(logBodies.length >= 1, 'expected structured HTTP log site');
for (const body of logBodies) {
  for (const forbiddenField of [
    'requestId', 'messageId', 'requestKey', 'attemptId', 'address', 'domain', 'subject', 'body', 'authorization', 'path',
  ]) assert.equal(new RegExp(`\\b${forbiddenField}\\s*:`).test(body), false, `ordinary log includes ${forbiddenField}`);
}

const research = await readFile(new URL('docs/research-log.md', root), 'utf8');
for (const pinned of [
  '9d8388721e7231442763ad37398b8d82224aa68f',
  '60ae9c946d0e042982b7f884110d34a0b53227f6',
  'e690211246a55e4a43b4690392725956d7a231e31d557b2d2776dc1aca9d4b2d',
  '5df422fb9940f2659fbf468d2a9f78fc8aebc2eec63f92a9dc598b4630ad48aa',
  '428d7af383f03c62b414a49766fa231063fd08c155180fd11e7113453a89c2e2',
  'f56811068b3c14a15e52ebd800ba7a03e7c10ef68eb9a2e07dee96d7cba0a261',
  '3f8666423bdc17b16d6d4889b9e17ea8b07e3823d154728a15fb5ee194b349e0',
  'e81f95ccab5b263087e259e197bfea6a86dc4c06ea4bbe993ac46a0253285a5f',
  '70cf332f46ff2d0537fe7706a7922fee9f1d8092fe98a8ea05947fe7cc1c769d',
  'dc13a9df72216e8bde3a9b6a4640493a6af8436c2ce7f06023bbce41e06cac44',
  'd431760660ea44e130f6e919dab216df2d0b3a490567a98089267523368fe1e5',
]) assert.ok(research.includes(pinned), `research log is missing fixed evidence identity: ${pinned}`);

const integration = await readFile(new URL('test/integration/postgresql.test.js', root), 'utf8');
assert.match(integration, /Infrastructure tests never skip/);
assert.doesNotMatch(integration, /\.skip\s*\(/);
for (const state of ['remote_accepted', 'retry_scheduled', 'permanent_rejected', 'unknown_after_io']) {
  assert.ok(integration.includes(state), `integration matrix misses ${state}`);
}
const smoke = await readFile(new URL('scripts/infra-smoke.mjs', root), 'utf8');
for (const boundary of ['SUBMIT_COMMIT', 'ATTEMPT_PREPARE_COMMIT', 'REMOTE_REPLY', 'COMPLETION_COMMIT']) {
  assert.ok(smoke.includes(`MAIL_CRASH_AFTER_${boundary}`));
}
assert.match(smoke, /killedProcesses\.length, 4/);
assert.match(smoke, /externalAcceptanceProved: false/);
const benchmark = await readFile(new URL('scripts/infra-benchmark.mjs', root), 'utf8');
for (const fixture of ['messages: 64', 'recipientsPerMessage: 4', 'recipientAttempts: 256', 'statusSnapshots: 32']) {
  assert.ok(benchmark.includes(fixture), `benchmark fixture is not fixed: ${fixture}`);
}

const files = await walk(root);
const portable = files.filter((path) => /\.(?:md|js|mjs|json|sql|ya?ml)$/.test(path));
const forbidden = [
  /\/Users\//,
  /\/private\/tmp\//,
  /file:\/\//,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  new RegExp(['Co', 'Authored-By:'].join('-')),
];
for (const path of portable) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const pattern of forbidden) assert.equal(pattern.test(contents), false, `${path} contains forbidden portable data`);
  if (/\.(?:js|mjs)$/.test(path)) {
    for (const match of contents.matchAll(/[a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)) {
      assert.ok(match[0].endsWith('.invalid') || match[0] === 'person@example.com', `${path} contains a non-synthetic address`);
    }
  }
}

for (const path of files.filter((value) => value.endsWith('.md'))) {
  const contents = await readFile(new URL(path, root), 'utf8');
  for (const match of contents.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#', 1)[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    const resolved = normalize(join(dirname(path), decodeURIComponent(target)));
    assert.equal((await stat(new URL(resolved, root))).isFile(), true, `${path} has broken link: ${target}`);
  }
}

for (const path of files.filter((value) => /\.(?:js|mjs)$/.test(value))) {
  execFileSync(process.execPath, ['--check', path], { cwd: root, stdio: 'inherit' });
}
execFileSync('git', ['diff', '--check'], { cwd: root, stdio: 'inherit' });
process.stdout.write(`${JSON.stringify({
  evidence: 'repository_policy_check',
  files: files.length,
  serviceLogSitesChecked: logBodies.length,
  markdownLinksChecked: true,
  syntaxChecked: true,
  externalAcceptanceProved: false,
})}\n`);
