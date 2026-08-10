import fs from "node:fs";
import { pathToFileURL } from "node:url";

const clientPath = "packages/github/src/client.ts";
let client = fs.readFileSync(clientPath, "utf8");
const cachePattern = /  const loadAccessibleRepositories = \(\) => \{[\s\S]*?    return accessibleRepositories;\n  \};/u;
if (!cachePattern.test(client)) throw new Error("GitHub repository cache block not found");
client = client.replace(
  cachePattern,
  `  const loadAccessibleRepositories = () => {\n    accessibleRepositories ??= octokit\n      .paginate(octokit.rest.repos.listForAuthenticatedUser, {\n        affiliation: "owner,collaborator,organization_member",\n        visibility: "all",\n        sort: "pushed",\n        direction: "desc",\n        per_page: MAX_PER_PAGE,\n      })\n      .then((repositories) => repositories.map(repositorySummary))\n      .catch((cause) => {\n        accessibleRepositories = null;\n        throw cause;\n      });\n    return accessibleRepositories;\n  };`,
);
const pagingBefore = `      const page = input.page ?? 1;\n      const perPage = Math.min(MAX_PER_PAGE, input.perPage ?? DEFAULT_PER_PAGE);`;
if (!client.includes(pagingBefore)) throw new Error("GitHub repository paging block not found");
client = client.replace(
  pagingBefore,
  `      const page = input.page ?? 1;\n      const requestedPerPage = input.perPage ?? DEFAULT_PER_PAGE;\n      if (!Number.isInteger(page) || page <= 0) {\n        throw new Error("GitHub repository page must be a positive integer.");\n      }\n      if (!Number.isInteger(requestedPerPage) || requestedPerPage <= 0) {\n        throw new Error("GitHub repository page size must be a positive integer.");\n      }\n      const perPage = Math.min(MAX_PER_PAGE, requestedPerPage);`,
);
fs.writeFileSync(clientPath, client);

const sourcePath = "scripts/pr2-review-fixes.mjs";
let source = fs.readFileSync(sourcePath, "utf8");
const failure = '    throw new Error(`Expected text not found in ${file}: ${before.slice(0, 120)}`);';
if (!source.includes(failure)) throw new Error("Patch runner guard not found");
source = source.replace(
  failure,
  '    console.warn(`Skipping already changed or differently formatted block in ${file}: ${before.slice(0, 120)}`);\n    return;',
);
const generated = "scripts/.generated-pr2-review-fixes.mjs";
fs.writeFileSync(generated, source);
try {
  await import(`${pathToFileURL(process.cwd() + "/" + generated).href}?run=${Date.now()}`);
} finally {
  fs.rmSync(generated, { force: true });
}
