import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, relative, extname } from "node:path";
import ts from "typescript";

const allowedPackageRootImports = new Set([
  "tests/plugin/smoke.test.ts",
  "tests/plugin/package-surface.test.ts",
  "tests/plugin/package-manifest.test.ts",
  "tests/plugin/test-boundary-regression.test.ts"
]);

const allowedInternalSourceImports = new Set([
  "tests/support/relay-plugin-testkit.ts",
  "tests/plugin/test-boundary-regression.test.ts"
]);

const supportedExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

function collectSourceFiles(directory: string): string[] {
  const results: string[] = [];

  for (const entry of readdirSync(directory)) {
    const fullPath = resolve(directory, entry);
    const stats = statSync(fullPath);

    if (stats.isDirectory()) {
      results.push(...collectSourceFiles(fullPath));
      continue;
    }

    if (supportedExtensions.has(extname(fullPath))) {
      results.push(fullPath);
    }
  }

  return results;
}

function collectModuleSpecifiers(filePath: string): string[] {
  const sourceText = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const moduleSpecifier = node.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text);
      }
    }

    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [firstArg] = node.arguments;
      if (firstArg && ts.isStringLiteral(firstArg)) {
        specifiers.push(firstArg.text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  return specifiers;
}

describe("test boundary regression", () => {
  it("limits package-root imports and direct internal-source imports to the approved files", () => {
    const testsRoot = resolve(__dirname, "../../tests");
    const files = collectSourceFiles(testsRoot);

    for (const filePath of files) {
      const normalizedPath = relative(resolve(__dirname, "../../"), filePath).replace(/\\/g, "/");
      const moduleSpecifiers = collectModuleSpecifiers(filePath);

      const importsPackageRoot = moduleSpecifiers.includes("@opencode-peer-session-relay/relay-plugin");
      const importsInternalSource = moduleSpecifiers.some((specifier) => specifier.includes("packages/relay-plugin/src/"));

      if (importsPackageRoot) {
        expect(allowedPackageRootImports.has(normalizedPath), `${normalizedPath} should not import the public package root`).toBe(true);
      }

      if (importsInternalSource) {
        expect(allowedInternalSourceImports.has(normalizedPath), `${normalizedPath} should not import package source internals directly`).toBe(true);
      }
    }
  });
});
