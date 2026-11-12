#!/usr/bin/env node
// Fails (exit 1) while a workflow or composite action in the repo uses an action that is not
// pinned to a full commit SHA, or runs a tool straight off the network.
//
//   node check-action-pins.mjs [repo root]      default: the current directory
//
// Belongs in each repo as scripts/check-action-pins.mjs, run from the CI workflow
// (`- run: node scripts/check-action-pins.mjs`) so a new unpinned `uses:` fails the PR.
// No dependencies; reads the YAML as text.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? '.');

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

const files = [
  ...walk(path.join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)),
  ...walk(path.join(root, '.github', 'actions')).filter((f) => /(^|[\\/])action\.ya?ml$/.test(f)),
  ...['action.yml', 'action.yaml', 'action/action.yml'].map((f) => path.join(root, f)).filter(existsSync),
];

const problems = [];
for (const file of files) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;
    const uses = line.match(/^\s*(?:-\s*)?uses:\s*["']?([^\s"'#]+)/);
    if (uses) {
      const ref = uses[1];
      if (ref.startsWith('./')) return; // an action in this repo
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned by digest`);
        return;
      }
      if (!/@[0-9a-f]{40}$/.test(ref)) problems.push(`${rel}:${i + 1}: ${ref} is not pinned to a commit`);
      return;
    }
    if (/\b(curl|wget)\b[^|#]*\|\s*(sudo\s+)?(ba|z)?sh\b/.test(line)) problems.push(`${rel}:${i + 1}: pipes a download into a shell`);
    if (/\bnpx\s+(--yes|-y)\b/.test(line)) problems.push(`${rel}:${i + 1}: npx --yes installs a package outside the lockfile`);
    if (/\bnpm\s+(i|install)\s+(?!.*--package-lock-only)[^#]*\s[@a-z][\w@/.-]*/.test(line) && !/npm\s+(i|install)\s+-g\s+npm@/.test(line)) {
      problems.push(`${rel}:${i + 1}: npm install of named packages outside the lockfile`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} problem(s) in ${files.length} file(s).`);
  process.exit(1);
}
console.log(`ok: ${files.length} workflow and action file(s), every action pinned to a commit`);
