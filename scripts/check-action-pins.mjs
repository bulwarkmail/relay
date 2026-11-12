#!/usr/bin/env node
// Fails (exit 1) while a workflow or composite action in the repo uses an action that is not
// pinned to a full commit SHA, or runs a tool straight off the network.
//
//   node check-action-pins.mjs [repo root]      default: the current directory
//   node check-action-pins.mjs --self-test      runs the cases at the end of this file
//
// Belongs in each repo as scripts/check-action-pins.mjs, run from the CI workflow
// (`- run: node scripts/check-action-pins.mjs`) so a new unpinned `uses:` fails the PR.
// No dependencies; reads the YAML as text. A `uses:` counts wherever YAML can put it: at
// the start of a line (`uses:` or `- uses:`) and as a key of a flow mapping
// (`- {uses: ...}`, `steps: [{uses: ...}, ...]`), quoted or not.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const USES = /(?:^\s*(?:-\s*)?|[{,]\s*)["']?uses["']?\s*:\s*["']?([^\s"'#,{}[\]]+)/g;

/** The problems in one file's text, each as `<rel>:<line>: <what>`. */
function problemsIn(rel, text) {
  const problems = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const refs = [...line.matchAll(USES)].map((match) => match[1]);
    for (const ref of refs) {
      if (ref.startsWith('./')) continue; // an action in this repo
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned by digest`);
        continue;
      }
      if (!/@[0-9a-f]{40}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned to a commit`);
    }
    if (refs.length) return;
    if (/\b(curl|wget)\b[^|#]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(line)) problems.push(`${rel}:${i + 1}: pipes a download into a shell`);
    if (/\bnpx\s+(--yes|-y)\b/.test(line)) problems.push(`${rel}:${i + 1}: npx --yes installs a package outside the lockfile`);
    if (/\bnpm\s+(i|install)\b(?!.*--package-lock-only)(?:\s+-\S+)*\s+[@a-z][\w@/.-]*/.test(line) && !/npm\s+(i|install)\s+-g\s+npm@/.test(line)) {
      problems.push(`${rel}:${i + 1}: npm install of named packages outside the lockfile`);
    }
  });
  return problems;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function checkRepo(root) {
  const files = [
    ...walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)),
    ...walk(path.join(root, '.github', 'actions')).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f)),
    ...['action.yml', 'action.yaml', 'action/action.yml'].map((f) => path.join(root, f)).filter(existsSync),
  ];
  const problems = files.flatMap((file) => problemsIn(path.relative(root, file).replace(/\\/g, '/'), readFileSync(file, 'utf8')));
  if (problems.length) {
    console.error(problems.join('\n'));
    console.error(`\n${problems.length} problem(s) in ${files.length} file(s).`);
    process.exit(1);
  }
  console.log(`ok: ${files.length} workflow and action file(s), every action pinned to a commit`);
}

const SHA = '3d3c42e5aac5ba805825da76410c181273ba90b1';
const DIGEST = 'sha256:' + 'a'.repeat(64);
// [what, workflow text, how many problems it has]
const CASES = [
  ['a tag', '      - uses: actions/checkout@v7', 1],
  ['a commit, with the version as a comment', `      - uses: actions/checkout@${SHA} # v7.0.1`, 0],
  ['a step whose name comes first', '      - name: Checkout\n        uses: actions/checkout@v7', 1],
  ['single quotes', "      - uses: 'actions/checkout@v7'", 1],
  ['double quotes around a commit', `      - uses: "actions/checkout@${SHA}"`, 0],
  ['a short commit', '      - uses: actions/checkout@3d3c42e', 1],
  ['a branch', '      - uses: actions/checkout@main', 1],
  ['a reusable workflow at job level', '  build:\n    uses: octo/repo/.github/workflows/build.yml@v1', 1],
  ['an action of this repo', '      - uses: ./.github/actions/setup', 0],
  ['a docker image by tag', '      - uses: docker://alpine:3.20', 1],
  ['a docker image by digest', `      - uses: docker://alpine@${DIGEST}`, 0],
  ['a commented-out step', '      # - uses: actions/checkout@v7', 0],
  ['a flow mapping as a step', '      - {uses: actions/checkout@v7}', 1],
  ['a flow mapping with a name and a quoted key', '      - { name: Checkout, "uses": "actions/checkout@v7" }', 1],
  ['a flow list of steps', '    steps: [{uses: actions/checkout@v7}, {uses: actions/setup-node@v7}]', 2],
  ['a flow list of pinned steps', `    steps: [{uses: actions/checkout@${SHA}}, { uses: 'actions/setup-node@${SHA}' }]`, 0],
  ['a flow list over several lines', '    steps: [\n      { name: Checkout,\n        uses: actions/checkout@v7 },\n      {uses: actions/setup-node@v7}\n    ]', 2],
  ['a download piped into a shell', '      - run: curl -fsSL https://example.org/install.sh | sh', 1],
  ['npx --yes', '      - run: npx --yes some-tool', 1],
  ['npm install of a named package', '      - run: npm install left-pad', 1],
  ['npm install of a named package after a flag', '      - run: npm i -D left-pad', 1],
  ['npm install from the lockfile', '      - run: npm install --no-audit', 0],
  ['npm ci', '      - run: npm ci --no-audit --no-fund', 0],
];

function selfTest() {
  let failed = 0;
  for (const [what, text, expected] of CASES) {
    const found = problemsIn('case.yml', text);
    const ok = found.length === expected;
    if (!ok) failed++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}: ${found.length} problem(s), ${expected} expected${ok ? '' : `\n     ${found.join('\n     ') || '(none found)'}`}`);
  }
  console.log(`${CASES.length - failed} of ${CASES.length} cases as expected`);
  process.exit(failed ? 1 : 0);
}

if (process.argv[2] === '--self-test') selfTest();
else checkRepo(path.resolve(process.argv[2] ?? '.'));
