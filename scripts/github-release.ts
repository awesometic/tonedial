// Run only after npm publishing succeeds; never rebuild the published archive here.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Asset = { name: string; state: string; digest: string; size: number };
type Release = { id: number; draft: boolean; assets: Asset[]; html_url: string };
type GitObject = { type: string; sha: string };

export async function publishGitHubRelease(root: string, env: NodeJS.ProcessEnv, request: typeof fetch = fetch): Promise<string> {
  const { name, version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const repository = "awesometic/tonedial";
  const sha = env.GITHUB_SHA;
  if (name !== "tonedial" || !/^\d+\.\d+\.\d+$/.test(version) ||
      env.GITHUB_REPOSITORY !== repository || !sha || !/^[a-f0-9]{40}$/.test(sha) || !env.GITHUB_TOKEN) {
    throw new Error("A stable ToneDial version and the publishing workflow's repository, SHA and token are required.");
  }
  const tag = `v${version}`;
  const body = readFileSync(join(root, "docs", "releases", `${version}.md`), "utf8").trim();
  if (!body) throw new Error(`Release notes for ${version} are empty.`);
  const archiveName = `${name}-${version}.tgz`;
  const tarballUrl = `https://registry.npmjs.org/${name}/-/${archiveName}`;
  const metadataResponse = await request(`https://registry.npmjs.org/${name}/${version}`, {
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  if (!metadataResponse.ok) throw new Error(`Published npm metadata is unavailable (HTTP ${metadataResponse.status}).`);
  const metadata = await metadataResponse.json() as {
    name?: string; version?: string; gitHead?: string; dist?: { tarball?: string; integrity?: string };
  };
  if (metadata.name !== name || metadata.version !== version || metadata.gitHead !== sha || metadata.dist?.tarball !== tarballUrl) {
    throw new Error("Published npm metadata does not match this package, version and workflow commit.");
  }
  const archiveResponse = await request(tarballUrl, { redirect: "error", signal: AbortSignal.timeout(60_000) });
  if (!archiveResponse.ok) throw new Error(`Published npm archive is unavailable (HTTP ${archiveResponse.status}).`);
  const archive = Buffer.from(await archiveResponse.arrayBuffer());
  if (metadata.dist.integrity !== `sha512-${createHash("sha512").update(archive).digest("base64")}`) {
    throw new Error("Published npm archive failed its SHA-512 integrity check.");
  }
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  const files = [
    { name: archiveName, bytes: archive, type: "application/gzip" },
    { name: "SHA256SUMS", bytes: Buffer.from(`${sha256(archive)}  ${archiveName}\n`), type: "text/plain" },
  ];
  const api = `https://api.github.com/repos/${repository}`;
  async function github(url: string, method = "GET", payload?: object | Buffer, type = "application/json") {
    const response = await request(url, {
      method, redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: {
        Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2026-03-10", "Content-Type": type,
      },
      ...(payload === undefined ? {} : { body: Buffer.isBuffer(payload) ? payload : JSON.stringify(payload) }),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) throw new Error(`GitHub ${method} ${new URL(url).pathname} failed (HTTP ${response.status}).`);
    return response.json();
  }
  const existingTag = await github(`${api}/git/ref/tags/${tag}`) as { object: GitObject } | null;
  let target = existingTag?.object;
  while (target?.type === "tag") target = (await github(`${api}/git/tags/${target.sha}`) as { object: GitObject }).object;
  if (existingTag && (target?.type !== "commit" || target.sha !== sha)) throw new Error(`${tag} has no matching commit; it will not be moved.`);
  let release = await github(`${api}/releases/tags/${tag}`) as Release | null;
  if (release && !existingTag) throw new Error(`Existing release ${tag} has no verifiable tag.`);
  if (!existingTag) await github(`${api}/git/refs`, "POST", { ref: `refs/tags/${tag}`, sha });
  if (!release) {
    release = await github(`${api}/releases`, "POST", {
      tag_name: tag, target_commitish: sha, name: `ToneDial ${tag}`, body, draft: true, prerelease: false,
    }) as Release;
  }
  // Inspect every existing attachment before writing, including an interrupted upload.
  for (const file of files) {
    const existing = release.assets.find(asset => asset.name === file.name);
    if (existing && (existing.state !== "uploaded" || existing.size !== file.bytes.length || existing.digest !== `sha256:${sha256(file.bytes)}`)) {
      throw new Error(`Existing release asset ${file.name} differs; it will not be overwritten.`);
    }
    if (!existing && !release.draft) throw new Error(`Published release is missing ${file.name}; it will not be changed.`);
  }
  for (const file of files) {
    if (release.assets.some(asset => asset.name === file.name)) continue;
    const asset = await github(`https://uploads.github.com/repos/${repository}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`,
      "POST", file.bytes, file.type) as Asset;
    if (asset.state !== "uploaded" || asset.size !== file.bytes.length || asset.digest !== `sha256:${sha256(file.bytes)}`) {
      throw new Error(`Uploaded release asset ${file.name} failed verification; the release remains a draft.`);
    }
  }
  if (release.draft) release = await github(`${api}/releases/${release.id}`, "PATCH", { draft: false }) as Release;
  return release.html_url;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${await publishGitHubRelease(process.cwd(), process.env)}\n`);
  } catch (error) {
    process.stderr.write(`GitHub release: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
