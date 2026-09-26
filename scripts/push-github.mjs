// Push the project tree to GitHub via the REST API (no git push needed).
// Uses $TOKEN, pushes tracked project files (respecting .gitignore-ish rules)
// to Dugu2010/Puter-openai- branch main.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const REPO = "Dugu2010/Puter-openai-";
const BRANCH = "main";
const ROOT = process.cwd();

const token = process.env.TOKEN;
if (!token) {
  console.error("TOKEN not set");
  process.exit(1);
}

const SKIP_DIRS = new Set(["node_modules", ".next", ".git", ".vly-run", "isolate", "dist"]);
const SKIP_FILES = new Set([".env", ".env.local", ".gitignore", "next-env.d.ts"]);

function walk(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(ROOT, full);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry) || entry.startsWith(".next")) continue;
      walk(full, acc);
    } else {
      if (SKIP_FILES.has(entry) || entry.endsWith(".tsbuildinfo")) continue;
      acc.push(rel.split(sep).join("/"));
    }
  }
  return acc;
}

const files = walk(ROOT);
console.log(`files to push: ${files.length}`);
console.log(files.join("\n"));

const gh = async (path, opts = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(opts.headers || {}),
    },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
};

// 0. Empty repos 409 on the git database API, so seed with one file via the
// Contents API first — this creates branch main + the initial commit.
try {
  await gh(`/repos/${REPO}/contents/README.md`);
  console.log("repo already seeded, README present");
} catch {
  const readme = readFileSync(join(ROOT, "README.md"));
  await gh(`/repos/${REPO}/contents/README.md`, {
    method: "PUT",
    body: JSON.stringify({
      message: "seed: README",
      content: readme.toString("base64"),
      branch: BRANCH,
    }),
  });
  console.log("repo seeded via Contents API");
}

// Seed commit + tree come from the branch head, not the contents response
// (which omits `commit` for GET).
const branchInfo = await gh(`/repos/${REPO}/branches/${BRANCH}`);
const seedCommitSha = branchInfo.commit.sha;
const seedTreeSha = branchInfo.commit.commit.tree.sha;
console.log(`seed commit: ${seedCommitSha}`);

// 1. base tree for the second commit
const baseTree = await gh(`/repos/${REPO}/git/trees/${seedTreeSha}`);
const baseSha = baseTree.sha;
console.log(`base tree: ${baseSha}`);

// 2. create blobs
const tree = [];
for (const rel of files) {
  if (rel === "README.md") continue; // already committed as the seed
  const content = readFileSync(join(ROOT, rel));
  const blob = await gh(`/repos/${REPO}/git/blobs`, {
    method: "POST",
    body: JSON.stringify({ content: content.toString("base64"), encoding: "base64" }),
  });
  tree.push({ path: rel, mode: "100644", type: "blob", sha: blob.sha });
  console.log(`  blob ok: ${rel}`);
}

// 3. create tree
const newTree = await gh(`/repos/${REPO}/git/trees`, {
  method: "POST",
  body: JSON.stringify(baseSha ? { base_tree: baseSha, tree } : { tree }),
});
console.log(`tree: ${newTree.sha}`);

// 4. commit
const commit = await gh(`/repos/${REPO}/git/commits`, {
  method: "POST",
  body: JSON.stringify({
    message: "Puter OpenAI-compatible gateway: streaming, tool calling, reasoning, Render-ready",
    tree: newTree.sha,
    parents: [seedCommitSha],
  }),
});
console.log(`commit: ${commit.sha}`);

// 5. point branch at commit
await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: "PATCH",
  body: JSON.stringify({ sha: commit.sha, force: true }),
}).catch(async (e) => {
  // ref may not exist yet in an empty repo
  await gh(`/repos/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: commit.sha }),
  });
});
console.log(`branch ${BRANCH} updated`);

console.log(`\nDone: https://github.com/${REPO}/tree/${BRANCH}`);
